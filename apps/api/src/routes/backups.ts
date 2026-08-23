import { Hono } from "hono";
import { statfs } from "node:fs/promises";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { auditLogs, backupRestorePlans, backupRestoreRuns, backupRuns, backupTargets, backgroundJobs, notifications, workspaces } from "../db/schema.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";
import { memberRole } from "../lib/workspace.ts";
import { executeBackupRun, fingerprint } from "../lib/backup.ts";
import { assertBackupObjectName, estimatedRestoreBytes, inspectBackupPackage, type WorkspaceBackupPackage } from "../lib/backup-package.ts";
import { restoreBackupPackage, verifyRestoredWorkspace } from "../lib/backup-restore.ts";
import { download, listRemote, type BackupCred, type BackupTargetRef } from "../lib/backup-transfer.ts";
import { assertSafeOutboundUrl } from "../lib/net-guard.ts";
import { open, seal } from "../lib/secrets.ts";
import { env } from "../env.ts";

export const backupRoutes = new Hono();

type Ctx = Parameters<typeof currentUser>[0];

async function workspaceAdmin(c: Ctx, wsId: string) {
  const u = await currentUser(c);
  if (!u) throw fail("UNAUTHENTICATED", "未登录");
  const r = await memberRole(wsId, u.id);
  if (r !== "owner" && r !== "admin") throw fail("FORBIDDEN", "只有管理员可以管理备份");
  return u;
}

async function instanceAdmin(c: Ctx) {
  const u = await currentUser(c);
  if (!u) throw fail("UNAUTHENTICATED", "未登录");
  if (u.roleInstance !== "admin") throw fail("FORBIDDEN", "仅实例管理员可操作");
  return u;
}

/** 按 id 取目标并确认调用方有权管它。 */
async function ownedTarget(c: Ctx, id: string) {
  const [t] = await db.select().from(backupTargets).where(eq(backupTargets.id, id));
  if (!t) throw fail("NOT_FOUND", "目标不存在");
  if (t.scope === "instance" || !t.workspaceId) await instanceAdmin(c);
  else await workspaceAdmin(c, t.workspaceId);
  return t;
}

const targetDto = ({ credentials: _c, encryptionKey: _k, ...rest }: typeof backupTargets.$inferSelect) => rest;

const credentialsSchema = z.object({
  username: z.string().optional(),
  password: z.string().optional(),
  accessKey: z.string().optional(),
  secretKey: z.string().optional(),
  bucket: z.string().optional(),
  region: z.string().optional(),
});

function assertCredentials(type: "webdav" | "s3", credentials: z.infer<typeof credentialsSchema>) {
  if (type === "webdav") {
    if (!credentials.username?.trim() || !credentials.password) {
      throw fail("VALIDATION", "WebDAV 需要用户名和密码");
    }
  } else if (!credentials.accessKey?.trim() || !credentials.secretKey || !credentials.bucket?.trim()) {
    throw fail("VALIDATION", "S3 需要 Access Key、Secret Key 和 Bucket");
  }
}

const targetBody = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(["webdav", "s3"]),
  endpoint: z.string().url(),
  prefix: z.string().max(200).default("knowledge"),
  credentials: credentialsSchema,
  schedule: z.enum(["manual", "daily", "weekly"]).default("manual"),
  retainDaily: z.number().int().min(1).max(365).default(7),
  retainWeekly: z.number().int().min(1).max(52).default(4),
  passphrase: z.string().min(8).optional(),
  enabled: z.boolean().optional(),
});

async function listBackups(scope: "workspace" | "instance", workspaceId: string | null) {
  const targets = scope === "instance"
    ? await db.select().from(backupTargets).where(eq(backupTargets.scope, "instance"))
    : await db.select().from(backupTargets).where(eq(backupTargets.workspaceId, workspaceId!));
  const runs = scope === "instance"
    ? await db.select().from(backupRuns).where(isNull(backupRuns.workspaceId)).orderBy(desc(backupRuns.createdAt)).limit(100)
    : await db.select().from(backupRuns).where(eq(backupRuns.workspaceId, workspaceId!)).orderBy(desc(backupRuns.createdAt)).limit(100);
  const restoreRuns = targets.length
    ? (await Promise.all(targets.map(t => db.select().from(backupRestoreRuns).where(eq(backupRestoreRuns.targetId, t.id)).orderBy(desc(backupRestoreRuns.createdAt)).limit(50)))).flat()
    : [];
  return { targets: targets.map(targetDto), runs, restoreRuns: restoreRuns.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 100) };
}

async function createTarget(
  actorId: string,
  scope: "workspace" | "instance",
  workspaceId: string | null,
  raw: unknown,
) {
  const b = targetBody.parse(raw);
  assertCredentials(b.type, b.credentials);
  const endpoint = b.endpoint.replace(/\/$/, "");
  // 备份 worker 会带着凭据往这个地址 PUT 整个快照，
  // 所以私网/环回/链路本地（云元数据就在 169.254.169.254）一律先挡住。
  await assertSafeOutboundUrl(endpoint, "备份目标地址");
  const [t] = await db.insert(backupTargets).values({
    scope,
    workspaceId,
    type: b.type,
    name: b.name,
    endpoint,
    prefix: b.prefix,
    credentials: seal(JSON.stringify(b.credentials)),
    schedule: b.schedule,
    retainDaily: b.retainDaily,
    retainWeekly: b.retainWeekly,
    enabled: b.enabled ?? true,
    encryptionKey: b.passphrase ? seal(b.passphrase) : null,
    encryptionFingerprint: b.passphrase ? fingerprint(b.passphrase) : null,
    createdBy: actorId,
  }).returning();
  await db.insert(auditLogs).values({
    userId: actorId,
    workspaceId,
    actorType: "user",
    action: "backup.target_create",
    result: "ok",
    targetType: "backup_target",
    targetId: t.id,
    details: { type: t.type, scope },
  });
  return t;
}

backupRoutes.get("/workspaces/:id/backups", async (c) => {
  const workspaceId = c.req.param("id");
  await workspaceAdmin(c, workspaceId);
  return ok(c, await listBackups("workspace", workspaceId));
});

backupRoutes.post("/workspaces/:id/backups/targets", async (c) => {
  const workspaceId = c.req.param("id");
  const u = await workspaceAdmin(c, workspaceId);
  const t = await createTarget(u.id, "workspace", workspaceId, await c.req.json());
  return ok(c, { id: t.id, encryptionFingerprint: t.encryptionFingerprint }, 201);
});

backupRoutes.get("/admin/backups", async (c) => {
  await instanceAdmin(c);
  return ok(c, await listBackups("instance", null));
});

backupRoutes.post("/admin/backups/targets", async (c) => {
  const u = await instanceAdmin(c);
  const t = await createTarget(u.id, "instance", null, await c.req.json());
  return ok(c, { id: t.id, encryptionFingerprint: t.encryptionFingerprint }, 201);
});

/** 改目标。凭据和口令留空就保持原样，不要求每次都重填。 */
backupRoutes.patch("/backup-targets/:id", async (c) => {
  const t = await ownedTarget(c, c.req.param("id"));
  const b = targetBody.partial().parse(await c.req.json());
  if (b.credentials) assertCredentials(t.type as "webdav" | "s3", b.credentials);
  const endpoint = b.endpoint === undefined ? undefined : b.endpoint.replace(/\/$/, "");
  if (endpoint) await assertSafeOutboundUrl(endpoint, "备份目标地址");
  const [saved] = await db.update(backupTargets).set({
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(b.prefix !== undefined ? { prefix: b.prefix } : {}),
    ...(b.schedule !== undefined ? { schedule: b.schedule } : {}),
    ...(b.retainDaily !== undefined ? { retainDaily: b.retainDaily } : {}),
    ...(b.retainWeekly !== undefined ? { retainWeekly: b.retainWeekly } : {}),
    ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
    ...(b.credentials !== undefined ? { credentials: seal(JSON.stringify(b.credentials)) } : {}),
    ...(b.passphrase !== undefined
      ? { encryptionKey: seal(b.passphrase), encryptionFingerprint: fingerprint(b.passphrase) }
      : {}),
  }).where(eq(backupTargets.id, t.id)).returning();
  return ok(c, targetDto(saved));
});

backupRoutes.delete("/backup-targets/:id", async (c) => {
  const t = await ownedTarget(c, c.req.param("id"));
  const running = await db
    .select({ id: backupRuns.id })
    .from(backupRuns)
    .where(and(eq(backupRuns.targetId, t.id), eq(backupRuns.status, "running")));
  if (running.length) throw fail("CONFLICT_VERSION", "此目标还有备份在跑，等它结束再删");
  const restoring = await db.select({ id: backupRestoreRuns.id }).from(backupRestoreRuns)
    .where(and(eq(backupRestoreRuns.targetId, t.id), inArray(backupRestoreRuns.status, ["restoring", "verifying"])));
  if (restoring.length) throw fail("CONFLICT_VERSION", "此目标还有恢复任务在执行，等它结束再删");
  // restore run 可能通过 checkpoint_run_id 引用 backup_runs，先由 plan 的级联删除清掉恢复历史。
  await db.delete(backupRestorePlans).where(eq(backupRestorePlans.targetId, t.id));
  await db.delete(backupRuns).where(eq(backupRuns.targetId, t.id));
  await db.delete(backupTargets).where(eq(backupTargets.id, t.id));
  return ok(c, {});
});

backupRoutes.post("/backup-targets/:id/test", async (c) => {
  const t = await ownedTarget(c, c.req.param("id"));
  const u = await currentUser(c);
  const [j] = await db.insert(backgroundJobs).values({
    type: "test_backup_target",
    payload: { targetId: t.id },
    runAfter: new Date(),
  }).returning();
  await db.insert(auditLogs).values({
    userId: u?.id,
    workspaceId: t.workspaceId,
    actorType: "user",
    action: "backup.test",
    result: "ok",
    targetType: "backup_target",
    targetId: t.id,
  });
  return ok(c, { jobId: j.id }, 202);
});

backupRoutes.post("/backup-targets/:id/run", async (c) => {
  const t = await ownedTarget(c, c.req.param("id"));
  const u = await currentUser(c);
  const running = await db
    .select({ id: backupRuns.id })
    .from(backupRuns)
    .where(and(eq(backupRuns.targetId, t.id), eq(backupRuns.status, "running")));
  if (running.length) throw fail("CONFLICT_VERSION", "此目标已有备份正在运行");
  const [r] = await db.insert(backupRuns).values({ targetId: t.id, workspaceId: t.workspaceId }).returning();
  await db.insert(backgroundJobs).values({
    type: t.scope === "instance" || !t.workspaceId ? "backup_instance" : "backup_workspace",
    payload: { targetId: t.id, runId: r.id },
    runAfter: new Date(),
  });
  await db.insert(auditLogs).values({
    userId: u?.id,
    workspaceId: t.workspaceId,
    actorType: "user",
    action: "backup.run",
    result: "ok",
    targetType: "backup_target",
    targetId: t.id,
  });
  return ok(c, { runId: r.id }, 202);
});

function targetAccess(target: typeof backupTargets.$inferSelect) {
  return {
    ref: { type: target.type, endpoint: target.endpoint, prefix: target.prefix } satisfies BackupTargetRef,
    credentials: JSON.parse(open(target.credentials)) as BackupCred,
  };
}

async function remoteObjects(target: typeof backupTargets.$inferSelect) {
  const { ref, credentials } = targetAccess(target);
  return (await listRemote(ref, credentials)).filter(item => item.name.endsWith(".kbbackup"));
}

async function selectedObject(target: typeof backupTargets.$inferSelect, remotePath: string) {
  const name = assertBackupObjectName(remotePath);
  const objects = await remoteObjects(target);
  const object = objects.find(item => item.name === name);
  if (!object) throw fail("NOT_FOUND", "远端备份对象不存在");
  return object;
}

type RemoteManifest = { format: string; version: number; encrypted: boolean; bytes: number; checksumSha256: string; remotePath: string; exportedAt?: string };

async function remoteManifest(target: typeof backupTargets.$inferSelect, remotePath: string): Promise<RemoteManifest | null> {
  const { ref, credentials } = targetAccess(target);
  try {
    const raw = await download(ref, credentials, `${assertBackupObjectName(remotePath)}.manifest.json`);
    if (raw.length > 16_384) return null;
    const value = z.object({ format: z.enum(["knowledge-workspace-backup", "knowledge-instance-backup"]), version: z.number().int().positive(), encrypted: z.boolean(), bytes: z.number().int().nonnegative(), checksumSha256: z.string().regex(/^[a-f0-9]{64}$/), remotePath: z.string(), exportedAt: z.string().datetime().optional() }).parse(JSON.parse(raw.toString("utf8")));
    return value.remotePath === remotePath ? value : null;
  } catch { return null; }
}

backupRoutes.get("/backup-targets/:id/objects", async c => {
  const target = await ownedTarget(c, c.req.param("id"));
  const objects = await remoteObjects(target);
  const runs = await db.select().from(backupRuns).where(and(eq(backupRuns.targetId, target.id), eq(backupRuns.status, "success")));
  const byPath = new Map(runs.filter(run => run.remotePath).map(run => [run.remotePath!, run]));
  const items = await Promise.all(objects.map(async object => {
    const run = byPath.get(object.name);
    const manifest = run ? null : await remoteManifest(target, object.name);
    return {
      remote_path: object.name,
      bytes: object.bytes ?? run?.bytes ?? manifest?.bytes ?? null,
      updated_at: object.updatedAt ?? run?.finishedAt ?? manifest?.exportedAt ?? null,
      checksum_sha256: run?.checksumSha256 ?? manifest?.checksumSha256 ?? null,
      format: (run?.manifest as { format?: string } | null)?.format ?? manifest?.format ?? null,
      version: (run?.manifest as { version?: number } | null)?.version ?? manifest?.version ?? null,
      encrypted: (run?.manifest as { encrypted?: boolean } | null)?.encrypted ?? manifest?.encrypted ?? null,
      locally_recorded: !!run,
    };
  }));
  items.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
  return ok(c, { objects: items });
});

const modeSchema = z.enum(["new_workspace", "replace_workspace", "bootstrap_empty_instance", "replace_instance_metadata"]);
const inspectBody = z.object({
  remote_path: z.string().min(1).max(240),
  passphrase: z.string().max(500).optional(),
  mode: modeSchema,
  target_workspace_id: z.string().uuid().optional(),
  allow_missing_attachments: z.boolean().default(false),
});

backupRoutes.post("/backup-targets/:id/objects/inspect", async c => {
  const target = await ownedTarget(c, c.req.param("id"));
  const actor = await currentUser(c);
  if (!actor) throw fail("UNAUTHENTICATED", "未登录");
  const body = inspectBody.parse(await c.req.json());
  await selectedObject(target, body.remote_path);
  const workspaceMode = body.mode === "new_workspace" || body.mode === "replace_workspace";
  if (workspaceMode !== (target.scope === "workspace" && !!target.workspaceId)) throw fail("VALIDATION", "备份目标与恢复模式不匹配");
  const targetWorkspaceId = body.mode === "replace_workspace" ? (body.target_workspace_id ?? target.workspaceId ?? undefined) : undefined;
  if (body.mode === "replace_workspace") {
    if (!targetWorkspaceId || targetWorkspaceId !== target.workspaceId) throw fail("VALIDATION", "只能替换该备份目标所属的工作区");
    if (await memberRole(targetWorkspaceId, actor.id) !== "owner") throw fail("FORBIDDEN", "替换恢复仅允许工作区 Owner 执行");
  }
  const { ref, credentials } = targetAccess(target);
  const raw = await download(ref, credentials, body.remote_path);
  const [recorded] = await db.select().from(backupRuns).where(and(eq(backupRuns.targetId, target.id), eq(backupRuns.remotePath, body.remote_path), eq(backupRuns.status, "success"))).orderBy(desc(backupRuns.createdAt)).limit(1);
  const sidecar = recorded ? null : await remoteManifest(target, body.remote_path);
  let inspected;
  try { inspected = inspectBackupPackage(raw, { passphrase: body.passphrase, expectedChecksum: recorded?.checksumSha256 ?? sidecar?.checksumSha256 ?? undefined }); }
  catch (error) { throw fail("VALIDATION", error instanceof Error ? error.message : "备份预检失败"); }
  const missingAttachments = inspected.snapshot.format === "knowledge-workspace-backup" && inspected.snapshot.version === 3 && inspected.snapshot.attachments.length > 0;
  let compatible = inspected.compatible && (!missingAttachments || body.allow_missing_attachments);
  const warnings = [...inspected.warnings];
  const requiredBytes = estimatedRestoreBytes(inspected.snapshot);
  if (requiredBytes) {
    const fsInfo = await statfs(env.dataDir).catch(() => statfs(env.repoRoot));
    const availableBytes = Number(fsInfo.bavail) * Number(fsInfo.bsize);
    if (availableBytes < requiredBytes) {
      compatible = false;
      warnings.push(`可用磁盘空间不足：预估需要 ${requiredBytes} 字节，可用 ${availableBytes} 字节`);
    }
  }
  if (body.mode === "replace_workspace") warnings.push("替换恢复会冻结工作区、先创建恢复前检查点，并轮换分享/日历令牌、吊销会话和 MCP Token");
  if (body.mode === "replace_instance_metadata") warnings.push("实例元数据恢复会吊销全部会话、认证令牌和 MCP Token；不会恢复任何 API Key 或私钥");
  const [plan] = await db.insert(backupRestorePlans).values({
    targetId: target.id,
    actorId: actor.id,
    targetWorkspaceId,
    remotePath: body.remote_path,
    checksumSha256: inspected.checksumSha256,
    format: inspected.snapshot.format,
    version: inspected.snapshot.version,
    encrypted: inspected.encrypted,
    mode: body.mode,
    compatible,
    counts: inspected.counts,
    conflicts: inspected.conflicts,
    warnings,
    expiresAt: new Date(Date.now() + 15 * 60_000),
  }).returning();
  await db.insert(auditLogs).values({ userId: actor.id, workspaceId: targetWorkspaceId ?? target.workspaceId, actorType: "user", action: "backup.restore_inspect", result: compatible ? "ok" : "rejected", targetType: "backup_restore_plan", targetId: plan.id, details: { remotePath: body.remote_path, checksum: inspected.checksumSha256, format: inspected.snapshot.format, version: inspected.snapshot.version, mode: body.mode } });
  return ok(c, {
    restore_plan_id: plan.id,
    backup: { format: inspected.snapshot.format, version: inspected.snapshot.version, exported_at: inspected.snapshot.exportedAt, checksum_sha256: inspected.checksumSha256, checksum_verified: inspected.checksumVerified, encrypted: inspected.encrypted },
    counts: inspected.counts,
    conflicts: inspected.conflicts,
    warnings,
    compatible,
    expires_at: plan.expiresAt,
    confirmation_text: body.mode === "replace_workspace"
      ? (await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, targetWorkspaceId!)).limit(1))[0]?.name ?? ""
      : inspected.snapshot.format === "knowledge-instance-backup" ? "RESTORE INSTANCE" : "RESTORE",
  });
});

backupRoutes.get("/backup-targets/:id/objects/:name/download", async c => {
  const target = await ownedTarget(c, c.req.param("id"));
  const name = decodeURIComponent(c.req.param("name"));
  await selectedObject(target, name);
  const { ref, credentials } = targetAccess(target);
  const raw = await download(ref, credentials, name);
  return new Response(new Uint8Array(raw), { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, "cache-control": "private, no-store" } });
});

const executeBody = z.object({
  passphrase: z.string().max(500).optional(),
  confirm_name: z.string().min(1).max(200),
});

async function loadPlan(c: Ctx, id: string) {
  const actor = await currentUser(c);
  if (!actor) throw fail("UNAUTHENTICATED", "未登录");
  const [plan] = await db.select().from(backupRestorePlans).where(eq(backupRestorePlans.id, id));
  if (!plan || plan.actorId !== actor.id) throw fail("NOT_FOUND", "恢复计划不存在");
  if (plan.status !== "ready" || plan.expiresAt.getTime() <= Date.now()) throw fail("VALIDATION", "恢复计划已使用或过期，请重新预检");
  if (!plan.compatible) throw fail("VALIDATION", "预检未通过，不能执行恢复");
  const target = await ownedTarget(c, plan.targetId);
  return { actor, plan, target };
}

async function executePlan(c: Ctx, drill: boolean) {
  const planId = c.req.param("id");
  if (!planId) throw fail("NOT_FOUND", "恢复计划不存在");
  const { actor, plan, target } = await loadPlan(c, planId);
  const body = executeBody.parse(await c.req.json());
  const [targetWs] = plan.targetWorkspaceId ? await db.select().from(workspaces).where(eq(workspaces.id, plan.targetWorkspaceId)) : [];
  const expectedName = plan.mode === "replace_workspace" ? targetWs?.name : plan.format === "knowledge-instance-backup" ? "RESTORE INSTANCE" : "RESTORE";
  if (body.confirm_name !== expectedName) throw fail("CONFIRMATION_REQUIRED", `请输入 ${expectedName} 确认恢复`);
  await selectedObject(target, plan.remotePath);
  const { ref, credentials } = targetAccess(target);
  const raw = await download(ref, credentials, plan.remotePath);
  let inspected;
  try { inspected = inspectBackupPackage(raw, { passphrase: body.passphrase, expectedChecksum: plan.checksumSha256 }); }
  catch (error) { throw fail("VALIDATION", error instanceof Error ? error.message : "备份校验失败"); }
  if (inspected.snapshot.format !== plan.format || inspected.snapshot.version !== plan.version) throw fail("VALIDATION", "远端对象与预检计划不一致");
  const run = await db.transaction(async tx => {
    const claimed = await tx.update(backupRestorePlans).set({ status: "executing" })
      .where(and(eq(backupRestorePlans.id, plan.id), eq(backupRestorePlans.status, "ready"))).returning({ id: backupRestorePlans.id });
    if (!claimed.length) throw fail("CONFLICT_VERSION", "恢复计划已在执行或已使用");
    const [created] = await tx.insert(backupRestoreRuns).values({ planId: plan.id, targetId: target.id, actorId: actor.id, workspaceId: plan.targetWorkspaceId, mode: plan.mode, status: "restoring", drill, startedAt: new Date(), warnings: plan.warnings }).returning();
    return created;
  });
  let checkpointRunId: string | null = null;
  const shouldCheckpoint = !drill && (plan.mode === "replace_workspace" || plan.mode === "replace_instance_metadata");
  const wasFrozen = targetWs?.frozen ?? false;
  try {
    if (plan.mode === "replace_workspace" && plan.targetWorkspaceId) await db.update(workspaces).set({ frozen: true }).where(eq(workspaces.id, plan.targetWorkspaceId));
    if (shouldCheckpoint) {
      const [checkpoint] = await db.insert(backupRuns).values({ targetId: target.id, workspaceId: target.workspaceId }).returning();
      checkpointRunId = checkpoint.id;
      await db.update(backupRestoreRuns).set({ checkpointRunId }).where(eq(backupRestoreRuns.id, run.id));
      await executeBackupRun(target, checkpoint.id);
    }
    const result = await restoreBackupPackage({ snapshot: inspected.snapshot, actorId: actor.id, mode: plan.mode as z.infer<typeof modeSchema>, targetWorkspaceId: plan.targetWorkspaceId ?? undefined, drill });
    await db.update(backupRestoreRuns).set({ status: "verifying", stats: result.stats, warnings: [...inspected.warnings, ...result.warnings] }).where(eq(backupRestoreRuns.id, run.id));
    let verification: Record<string, number> = {};
    if (!drill && inspected.snapshot.format === "knowledge-workspace-backup" && result.workspaceId) verification = await verifyRestoredWorkspace(result.workspaceId, inspected.snapshot as WorkspaceBackupPackage);
    await db.update(backupRestoreRuns).set({ status: "success", workspaceId: result.workspaceId, stats: { ...result.stats, ...verification }, warnings: [...inspected.warnings, ...result.warnings], finishedAt: new Date() }).where(eq(backupRestoreRuns.id, run.id));
    await db.update(backupRestorePlans).set({ status: "used", usedAt: new Date() }).where(eq(backupRestorePlans.id, plan.id));
    if (drill) await db.update(backupTargets).set({ lastRestoreTestAt: new Date(), lastRestoreTestStatus: "success" }).where(eq(backupTargets.id, target.id));
    await db.insert(auditLogs).values({ userId: actor.id, workspaceId: result.workspaceId ?? plan.targetWorkspaceId ?? target.workspaceId, actorType: "user", action: drill ? "backup.restore_drill" : "backup.restore_execute", result: "ok", targetType: "backup_restore_run", targetId: run.id, details: { mode: plan.mode, checksum: plan.checksumSha256, checkpointRunId, stats: result.stats, rotatedSecrets: result.rotatedSecrets } });
    await db.insert(notifications).values({ userId: actor.id, type: drill ? "backup_restore_drill" : "backup_restored", title: drill ? "备份恢复演练通过" : "备份恢复完成", body: `${target.name} · ${plan.remotePath}`, href: result.workspaceId ? `/w/${result.workspaceId}/settings?tab=backup` : "/admin?tab=backup" });
    return ok(c, { run_id: run.id, status: "success", workspace_id: result.workspaceId, checkpoint_run_id: checkpointRunId, stats: result.stats, warnings: [...inspected.warnings, ...result.warnings], rotated_secrets: result.rotatedSecrets });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "恢复失败";
    let rolledBack = !shouldCheckpoint;
    if (checkpointRunId) {
      try {
        const [checkpoint] = await db.select().from(backupRuns).where(eq(backupRuns.id, checkpointRunId));
        if (!checkpoint?.remotePath || !checkpoint.checksumSha256) throw new Error("恢复前检查点不完整");
        const checkpointRaw = await download(ref, credentials, checkpoint.remotePath);
        const checkpointPassphrase = target.encryptionKey ? open(target.encryptionKey) : undefined;
        const checkpointPackage = inspectBackupPackage(checkpointRaw, { passphrase: checkpointPassphrase, expectedChecksum: checkpoint.checksumSha256 });
        await restoreBackupPackage({
          snapshot: checkpointPackage.snapshot,
          actorId: actor.id,
          mode: checkpointPackage.snapshot.format === "knowledge-workspace-backup" ? "replace_workspace" : "replace_instance_metadata",
          targetWorkspaceId: plan.targetWorkspaceId ?? undefined,
        });
        rolledBack = true;
      } catch { rolledBack = false; }
    }
    await db.update(backupRestoreRuns).set({ status: rolledBack ? "rolled_back" : "failed", error: message, finishedAt: new Date() }).where(eq(backupRestoreRuns.id, run.id));
    await db.update(backupRestorePlans).set({ status: plan.expiresAt.getTime() > Date.now() ? "ready" : "expired" }).where(eq(backupRestorePlans.id, plan.id));
    if (drill) await db.update(backupTargets).set({ lastRestoreTestAt: new Date(), lastRestoreTestStatus: "failed" }).where(eq(backupTargets.id, target.id));
    await db.insert(auditLogs).values({ userId: actor.id, workspaceId: plan.targetWorkspaceId ?? target.workspaceId, actorType: "user", action: drill ? "backup.restore_drill" : "backup.restore_execute", result: "failed", targetType: "backup_restore_run", targetId: run.id, details: { mode: plan.mode, checksum: plan.checksumSha256, checkpointRunId } });
    await db.insert(notifications).values({ userId: actor.id, type: "backup_restore_failed", title: drill ? "备份恢复演练失败" : "备份恢复失败", body: `${target.name}：${message}`.slice(0, 400), href: target.workspaceId ? `/w/${target.workspaceId}/settings?tab=backup` : "/admin?tab=backup" });
    throw fail("VALIDATION", `${rolledBack ? "恢复失败并已回滚" : "恢复失败，自动回滚也未完成，请使用恢复前检查点"}：${message}`);
  } finally {
    if (plan.mode === "replace_workspace" && plan.targetWorkspaceId) await db.update(workspaces).set({ frozen: wasFrozen }).where(eq(workspaces.id, plan.targetWorkspaceId)).catch(() => {});
  }
}

backupRoutes.post("/backup-restore-plans/:id/execute", c => executePlan(c, false));
backupRoutes.post("/backup-restore-plans/:id/drill", c => executePlan(c, true));
