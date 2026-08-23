import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { auditLogs, backupRuns, backupTargets, backgroundJobs } from "../db/schema.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";
import { memberRole } from "../lib/workspace.ts";
import { fingerprint } from "../lib/backup.ts";
import { assertSafeOutboundUrl } from "../lib/net-guard.ts";
import { seal } from "../lib/secrets.ts";

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
  return { targets: targets.map(targetDto), runs };
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
