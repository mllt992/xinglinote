import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../apps/api/src/db/client.ts";
import { users } from "../apps/api/src/db/schema.ts";
import { inspectBackupPackage } from "../apps/api/src/lib/backup-package.ts";
import { restoreInstanceMetadata } from "../apps/api/src/lib/backup-restore.ts";

const args = process.argv.slice(2);
const file = args.find(arg => !arg.startsWith("--"));
const maintenance = args.includes("--maintenance");
const confirm = args.find(arg => arg.startsWith("--confirm="))?.slice("--confirm=".length);
if (!file || !maintenance) {
  console.error("用法：pnpm restore:instance <instance.kbbackup> --maintenance --confirm=<checksum前12位>");
  process.exit(2);
}
const raw = await readFile(resolve(file));
const inspected = inspectBackupPackage(raw, { passphrase: process.env.KB_BACKUP_PASSPHRASE });
if (inspected.snapshot.format !== "knowledge-instance-backup") throw new Error("只接受实例元数据备份");
const fingerprint = inspected.checksumSha256.slice(0, 12);
if (confirm !== fingerprint) {
  console.error(`预检完成。确认执行请追加 --confirm=${fingerprint}`);
  process.exit(2);
}
const [admin] = await db.select().from(users).where(eq(users.roleInstance, "admin")).limit(1);
if (!admin) throw new Error("请先初始化一个实例管理员，再执行元数据恢复");
const result = await restoreInstanceMetadata({ snapshot: inspected.snapshot, actorId: admin.id, mode: "replace_instance_metadata" });
console.log(JSON.stringify({ ok: true, ...result }, null, 2));
await db.$client.end();
