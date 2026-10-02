// 仅供 CI 的一次性 PostgreSQL；运行真实升级两次，覆盖旧触发器停用与数据保留。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

assert.equal(process.env.CI, 'true', '只允许在 CI 隔离数据库执行');
assert.ok(process.env.KB_TEST_DATABASE_URL, '需要显式测试数据库');
assert.equal(process.env.DATABASE_URL, process.env.KB_TEST_DATABASE_URL);
const target = new URL(process.env.KB_TEST_DATABASE_URL);
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname));
assert.ok(target.pathname.endsWith('_test'));
const { sql } = await import('../apps/api/src/db/client.ts');
const { syncNoteTasks } = await import('../apps/api/src/lib/calendar.ts');
const id = { user: randomUUID(), ws: randomUUID(), nb: randomUUID(), note: randomUUID(), legacy: randomUUID(), manual: randomUUID(), fresh: randomUUID() };
const originalBody = '- [ ] 普通选项\n- [ ] 历史任务 ^tk-11223344';
const upgrade = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--import', './apps/api/node_modules/tsx/dist/loader.mjs', 'apps/api/src/db/push.ts'], { stdio: 'inherit', env: process.env });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`数据库升级退出码 ${code}`)));
});
const jobs = () => sql`select id, type, payload, status from background_jobs where type='sync_note_tasks' and payload->>'noteId'=${id.note} order by id`;
const storedItems = () => sql`select * from calendar_items where workspace_id=${id.ws} order by id`;
try {
  await sql`insert into users(id,email,handle,display_name,password_hash) values(${id.user},${`calendar-migration-${id.user}@example.invalid`},${`cm${id.user.replaceAll('-', '').slice(0,20)}`},'迁移回归','not-a-login')`;
  await sql`insert into workspaces(id,slug,name,kind,owner_id) values(${id.ws},${`calendar-migration-${id.ws}`},'隔离迁移验收','normal',${id.user})`;
  await sql`insert into notebooks(id,workspace_id,slug,title,created_by) values(${id.nb},${id.ws},'notes','旧笔记',${id.user})`;
  // 还原升级前的真实函数与触发器，先证明它会为正文入队。
  await sql.unsafe(`CREATE OR REPLACE FUNCTION kb_note_tasks_sync() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO background_jobs(type,payload) VALUES('sync_note_tasks',jsonb_build_object('noteId',NEW.id)); RETURN NEW; END $$`);
  await sql.unsafe('DROP TRIGGER IF EXISTS notes_tasks_sync ON notes');
  await sql.unsafe('CREATE TRIGGER notes_tasks_sync AFTER INSERT OR UPDATE OF body_md ON notes FOR EACH ROW EXECUTE FUNCTION kb_note_tasks_sync()');
  await sql`insert into notes(id,workspace_id,notebook_id,title,body_md,created_by,updated_by) values(${id.note},${id.ws},${id.nb},'保留正文',${originalBody},${id.user},${id.user})`;
  assert.equal((await jobs()).length, 1, '旧触发器必须实际入队');
  await sql`insert into calendar_items(id,workspace_id,notebook_id,kind,title,source,source_note_id,source_anchor,created_by,updated_by) values(${id.legacy},${id.ws},${id.nb},'task','历史任务','note',${id.note},'^tk-11223344',${id.user},${id.user}),(${id.manual},${id.ws},null,'task','手工日历任务','manual',null,null,${id.user},${id.user})`;
  const beforeItems = await storedItems(), beforeJobs = await jobs();
  const [beforeNote] = await sql`select * from notes where id=${id.note}`;
  await upgrade();
  assert.deepEqual(await storedItems(), beforeItems, '升级不改历史 note/manual 记录');
  assert.deepEqual(await jobs(), beforeJobs, '旧队列记录保留');
  assert.deepEqual((await sql`select * from notes where id=${id.note}`)[0], beforeNote, '升级不改正文及笔记元数据');
  const trigger = await sql`select tgname from pg_trigger where tgrelid='notes'::regclass and tgname='notes_tasks_sync' and not tgisinternal`;
  assert.equal(trigger.length, 0);
  await sql`update notes set body_md=${originalBody + '\n- [ ] 新普通选项'} where id=${id.note}`;
  assert.deepEqual(await jobs(), beforeJobs, '更新笔记不再入同步队列');
  assert.deepEqual(await syncNoteTasks(id.note), { added: 0, updated: 0, detached: 0 });
  assert.deepEqual(await storedItems(), beforeItems, '消化旧队列不导入复选框、不删历史任务');
  await sql`insert into calendar_items(id,workspace_id,kind,title,source,due_at,created_by,updated_by) values(${id.fresh},${id.ws},'task','升级后日历任务','manual',now(),${id.user},${id.user})`;
  const afterItems = await storedItems();
  assert.equal(afterItems.length, 3, '升级后仍可创建日历任务');
  await upgrade();
  assert.deepEqual(await storedItems(), afterItems, '重复升级保留全部任务');
  await sql`update notes set body_md=${originalBody} where id=${id.note}`;
  assert.deepEqual(await jobs(), beforeJobs, '重复升级仍不恢复同步触发器');
  console.log('calendar migration: old trigger removed, data and queued job preserved, manual creation works, second upgrade idempotent');
} finally {
  // 删除仅本脚本创建的夹具；历史数据保留断言已在上面完成。
  await sql.unsafe('DROP TRIGGER IF EXISTS notes_tasks_sync ON notes');
  await sql`delete from background_jobs where payload->>'noteId'=${id.note}`;
  await sql`delete from calendar_items where workspace_id=${id.ws}`;
  await sql`delete from notes where id=${id.note}`;
  await sql`delete from notebooks where id=${id.nb}`;
  await sql`delete from workspaces where id=${id.ws}`;
  await sql`delete from users where id=${id.user}`;
  await sql.end();
}
