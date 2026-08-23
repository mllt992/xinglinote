// WebDAV / S3 备份验收。需要 pnpm dev，以及：
//   node scripts/mock-webdav.mjs   (:19092)
//   node scripts/mock-s3.mjs       (:19094)
// 内网地址要开 ALLOW_PRIVATE_OUTBOUND_ENDPOINTS=true，否则 worker 上传会被护栏挡住。
import { KB_EMAIL, KB_PASSWORD } from "./creds.mjs";
import { db } from "../apps/api/src/db/client.ts";
import { backupRuns, backupTargets } from "../apps/api/src/db/schema.ts";
import { seal } from "../apps/api/src/lib/secrets.ts";
import { eq } from "drizzle-orm";

const base = (process.env.KB_BASE_URL ?? "http://127.0.0.1:12098") + "/api/v1";

async function q(path, opt = {}, cookie = "") {
  const r = await fetch(base + path, {
    ...opt,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(opt.headers || {}) },
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error?.message ?? r.status);
  return { data: j.data, cookie: r.headers.get("set-cookie")?.split(";")[0] || cookie };
}

async function waitRun(listPath, runId, cookie) {
  let result;
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const d = (await q(listPath, {}, cookie)).data;
    result = d.runs.find(x => x.id === runId);
    if (result?.status === "success" || result?.status === "failed") break;
  }
  return result;
}

const c = (await q("/auth/login", { method: "POST", body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) })).cookie;
const me = (await q("/me", {}, c)).data;
const created = [];

try {
  const [webdav] = await db.insert(backupTargets).values({
    workspaceId: me.personalWorkspaceId,
    type: "webdav",
    name: "验收 WebDAV",
    endpoint: "http://127.0.0.1:19092",
    prefix: "backups",
    credentials: seal(JSON.stringify({ username: "u", password: "remote-secret" })),
    encryptionKey: seal("backup-passphrase"),
    encryptionFingerprint: "test",
    createdBy: me.id,
  }).returning();
  created.push(webdav.id);

  const [s3] = await db.insert(backupTargets).values({
    workspaceId: me.personalWorkspaceId,
    type: "s3",
    name: "验收 S3",
    endpoint: "http://127.0.0.1:19094",
    prefix: "backups",
    credentials: seal(JSON.stringify({ accessKey: "AKIA", secretKey: "s3-secret", bucket: "kb", region: "us-east-1" })),
    encryptionKey: seal("backup-passphrase"),
    encryptionFingerprint: "test",
    createdBy: me.id,
  }).returning();
  created.push(s3.id);

  const [inst] = await db.insert(backupTargets).values({
    scope: "instance",
    type: "webdav",
    name: "验收实例 WebDAV",
    endpoint: "http://127.0.0.1:19092",
    prefix: "instance",
    credentials: seal(JSON.stringify({ username: "u", password: "remote-secret" })),
    encryptionKey: seal("backup-passphrase"),
    encryptionFingerprint: "test",
    createdBy: me.id,
  }).returning();
  created.push(inst.id);

  await q(`/backup-targets/${webdav.id}/test`, { method: "POST" }, c);
  await new Promise(r => setTimeout(r, 1500));

  const webRun = (await q(`/backup-targets/${webdav.id}/run`, { method: "POST" }, c)).data;
  const s3Run = (await q(`/backup-targets/${s3.id}/run`, { method: "POST" }, c)).data;
  const instRun = (await q(`/backup-targets/${inst.id}/run`, { method: "POST" }, c)).data;

  const webResult = await waitRun(`/workspaces/${me.personalWorkspaceId}/backups`, webRun.runId, c);
  const s3Result = await waitRun(`/workspaces/${me.personalWorkspaceId}/backups`, s3Run.runId, c);
  const instResult = await waitRun("/admin/backups", instRun.runId, c);

  const davFiles = await fetch("http://127.0.0.1:19092/_files").then(r => r.json());
  const s3Files = await fetch("http://127.0.0.1:19094/_files").then(r => r.json());
  const list = (await q(`/workspaces/${me.personalWorkspaceId}/backups`, {}, c)).data;
  const adminList = (await q("/admin/backups", {}, c)).data;
  const webObjects = (await q(`/backup-targets/${webdav.id}/objects`, {}, c)).data.objects;
  const s3Objects = (await q(`/backup-targets/${s3.id}/objects`, {}, c)).data.objects;
  let wrongPassRejected = false;
  try {
    await q(`/backup-targets/${webdav.id}/objects/inspect`, { method: 'POST', body: JSON.stringify({ remote_path: webResult.remotePath, passphrase: 'wrong-passphrase', mode: 'new_workspace' }) }, c);
  } catch { wrongPassRejected = true; }
  const plan = (await q(`/backup-targets/${webdav.id}/objects/inspect`, { method: 'POST', body: JSON.stringify({ remote_path: webResult.remotePath, passphrase: 'backup-passphrase', mode: 'new_workspace' }) }, c)).data;
  const drill = (await q(`/backup-restore-plans/${plan.restore_plan_id}/drill`, { method: 'POST', body: JSON.stringify({ passphrase: 'backup-passphrase', confirm_name: plan.confirmation_text }) }, c)).data;
  await db.delete(backupRuns).where(eq(backupRuns.id, webResult.id));
  const rediscovered = (await q(`/backup-targets/${webdav.id}/objects`, {}, c)).data.objects.find(x => x.remote_path === webResult.remotePath);
  const serialized = JSON.stringify({ list, adminList });

  const out = {
    webdavSuccess: webResult?.status === "success",
    s3Success: s3Result?.status === "success",
    instanceSuccess: instResult?.status === "success",
    checksum: /^[a-f0-9]{64}$/.test(webResult?.checksumSha256 ?? "") && /^[a-f0-9]{64}$/.test(s3Result?.checksumSha256 ?? ""),
    workspaceManifest: typeof webResult?.manifest?.notes === "number",
    instanceManifest: typeof instResult?.manifest?.users === "number",
    encryptedRemote: davFiles.some(x => x.head === "KBENC1") && s3Files.some(x => x.head === "KBENC1"),
    credentialsRedacted: !serialized.includes("remote-secret") && !serialized.includes("backup-passphrase") && !serialized.includes("s3-secret"),
    instanceListedSeparately: adminList.targets.some(t => t.id === inst.id) && !list.targets.some(t => t.id === inst.id),
    remoteDiscovery: webObjects.some(x => x.remote_path === webResult.remotePath && x.checksum_sha256 === webResult.checksumSha256) && s3Objects.some(x => x.remote_path === s3Result.remotePath),
    wrongPassNoMutation: wrongPassRejected,
    restoreDrill: drill.status === 'success' && drill.workspace_id === null,
    remoteDiscoveryWithoutLocalRun: rediscovered?.locally_recorded === false && rediscovered?.checksum_sha256 === webResult.checksumSha256,
  };
  console.log(JSON.stringify(out, null, 2));
  if (!Object.values(out).every(Boolean)) process.exitCode = 1;
} finally {
  for (const id of created) {
    await db.delete(backupRuns).where(eq(backupRuns.targetId, id)).catch(() => {});
    await db.delete(backupTargets).where(eq(backupTargets.id, id)).catch(() => {});
  }
}
