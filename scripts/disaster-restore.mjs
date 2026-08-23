// 离线整机恢复：PostgreSQL custom dump + kbdata tar。脚本只在显式维护/指纹确认后执行。
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const dbDump = args[0] ? resolve(args[0]) : '';
const dataArchive = args[1] ? resolve(args[1]) : '';
const confirm = args.find(x => x.startsWith('--confirm='))?.slice(10);
const maintenance = args.includes('--maintenance');
const databaseUrl = process.env.DATABASE_URL;
const dataDir = resolve(process.env.DATA_DIR ?? 'data');
const hashFile = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const run = (command, argv) => {
  const result = spawnSync(command, argv, { stdio: 'inherit', env: process.env });
  if (result.status !== 0) throw new Error(`${command} 执行失败 (${result.status ?? 'signal'})`);
};

if (!dbDump || !dataArchive || !maintenance || !databaseUrl) {
  console.error('用法：DATABASE_URL=... DATA_DIR=... pnpm restore:disaster <postgres.dump> <kbdata.tar> --maintenance --confirm=<指纹>');
  process.exit(2);
}
await access(dbDump); await access(dataArchive);
if ([resolve('/'), resolve(tmpdir()), resolve(process.env.USERPROFILE ?? process.env.HOME ?? '.')].includes(dataDir)) throw new Error('DATA_DIR 不能是根目录、临时目录或用户目录');
const fingerprint = createHash('sha256').update(`${await hashFile(dbDump)}:${await hashFile(dataArchive)}`).digest('hex').slice(0, 16);
if (confirm !== fingerprint) {
  console.error(`预检通过：数据库=${basename(dbDump)}，数据卷=${basename(dataArchive)}，DATA_DIR=${dataDir}`);
  console.error(`确认停服且目标无误后重新执行：--confirm=${fingerprint}`);
  process.exit(2);
}

const listing = spawnSync(process.env.TAR_BIN ?? 'tar', ['-tf', dataArchive], { encoding: 'utf8' });
if (listing.status !== 0) throw new Error('无法读取 kbdata tar');
for (const entry of listing.stdout.split(/\r?\n/).filter(Boolean)) {
  if (isAbsolute(entry) || entry.replaceAll('\\', '/').split('/').includes('..')) throw new Error(`数据卷包含危险路径：${entry}`);
}
const verboseListing = spawnSync(process.env.TAR_BIN ?? 'tar', ['-tvf', dataArchive], { encoding: 'utf8' });
if (verboseListing.status !== 0) throw new Error('无法检查 kbdata tar 条目类型');
for (const entry of verboseListing.stdout.split(/\r?\n/).filter(Boolean)) {
  if (entry.startsWith('l') || entry.startsWith('h')) throw new Error('数据卷不能包含符号链接或硬链接');
}
const dataParent = dirname(dataDir);
await mkdir(dataParent, { recursive: true });
const work = await mkdtemp(join(dataParent, '.kb-restore-'));
const extractRoot = join(work, 'extract');
await mkdir(extractRoot);
const stagedData = join(extractRoot, 'data');
const dbCheckpoint = join(dataParent, `.kb-db-rollback-${Date.now()}.dump`);
const oldData = `${dataDir}.rollback-${Date.now()}`;
run(process.env.TAR_BIN ?? 'tar', ['-xf', dataArchive, '-C', extractRoot]);
// 归档建议顶层就是 data；若没有，直接把解包目录作为新数据卷。
const extracted = await access(stagedData).then(() => stagedData, () => extractRoot);
run(process.env.PG_DUMP_BIN ?? 'pg_dump', ['--format=custom', '--file', dbCheckpoint, databaseUrl]);
let oldDataMoved = false;
let newDataMoved = false;
const hadOldData = await access(dataDir).then(() => true, () => false);
try {
  run(process.env.PG_RESTORE_BIN ?? 'pg_restore', ['--clean', '--if-exists', '--single-transaction', '--dbname', databaseUrl, dbDump]);
  if (hadOldData) {
    await rename(dataDir, oldData);
    oldDataMoved = true;
  }
  await rename(extracted, dataDir);
  newDataMoved = true;
  run(process.env.PNPM_BIN ?? 'pnpm', ['db:push']);
  run(process.env.PSQL_BIN ?? 'psql', [databaseUrl, '--set', 'ON_ERROR_STOP=1', '--command', 'SELECT count(*) AS users FROM users; SELECT count(*) AS notes FROM notes;']);
  console.log(`整机恢复完成。回滚数据库检查点：${dbCheckpoint}；旧数据卷：${oldData}`);
} catch (error) {
  console.error('恢复失败，开始回滚数据库与数据卷。');
  run(process.env.PG_RESTORE_BIN ?? 'pg_restore', ['--clean', '--if-exists', '--single-transaction', '--dbname', databaseUrl, dbCheckpoint]);
  if (newDataMoved) {
    const failedData = `${dataDir}.failed-${Date.now()}`;
    await rename(dataDir, failedData);
  }
  if (oldDataMoved) await rename(oldData, dataDir);
  throw error;
}
