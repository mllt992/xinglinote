import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectBackupPackage } from "../apps/api/src/lib/backup-package.ts";

const args = process.argv.slice(2);
const file = args.find(arg => !arg.startsWith("--"));
if (!file) {
  console.error("用法：pnpm backup:verify <file.kbbackup> [--checksum=<sha256>]；加密口令从 KB_BACKUP_PASSPHRASE 读取");
  process.exit(2);
}
const checksum = args.find(arg => arg.startsWith("--checksum="))?.slice("--checksum=".length);
try {
  const raw = await readFile(resolve(file));
  const result = inspectBackupPackage(raw, { passphrase: process.env.KB_BACKUP_PASSPHRASE, expectedChecksum: checksum });
  console.log(JSON.stringify({
    ok: true,
    format: result.snapshot.format,
    version: result.snapshot.version,
    exportedAt: result.snapshot.exportedAt,
    encrypted: result.encrypted,
    checksumSha256: result.checksumSha256,
    checksumVerified: result.checksumVerified,
    counts: result.counts,
    warnings: result.warnings,
  }, null, 2));
} catch (error) {
  console.error(`备份校验失败：${error instanceof Error ? error.message : "未知错误"}`);
  process.exit(1);
}
