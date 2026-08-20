import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { backupRuns, backupTargets, backgroundJobs } from "../db/schema.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";
import { memberRole } from "../lib/workspace.ts";
import { fingerprint } from "../lib/backup.ts";
import { assertSafeOutboundUrl } from "../lib/net-guard.ts";
import { seal } from "../lib/secrets.ts";

export const backupRoutes = new Hono();

type Ctx = Parameters<typeof currentUser>[0];

async function admin(c: Ctx, wsId: string) {
  const u = await currentUser(c);
  if (!u) throw fail("UNAUTHENTICATED", "未登录");
  const r = await memberRole(wsId, u.id);
  if (r !== "owner" && r !== "admin") throw fail("FORBIDDEN", "只有管理员可以管理备份");
  return u;
}

/** 按 id 取目标并确认调用方是它所属工作区的管理员。 */
async function ownedTarget(c: Ctx, id: string) {
  const [t] = await db.select().from(backupTargets).where(eq(backupTargets.id, id));
  if (!t || !t.workspaceId) throw fail("NOT_FOUND", "目标不存在");
  await admin(c, t.workspaceId);
  return t;
}

const targetDto = ({ credentials: _c, encryptionKey: _k, ...rest }: typeof backupTargets.$inferSelect) => rest;

backupRoutes.get("/workspaces/:id/backups", async (c) => {
  const workspaceId = c.req.param("id");
  await admin(c, workspaceId);
  const targets = await db.select().from(backupTargets).where(eq(backupTargets.workspaceId, workspaceId));
  const runs = await db
    .select()
    .from(backupRuns)
    .where(eq(backupRuns.workspaceId, workspaceId))
    .orderBy(desc(backupRuns.createdAt))
    .limit(100);
  return ok(c, { targets: targets.map(targetDto), runs });
});

const credentialsSchema = z.object({
  username: z.string().optional(),
  password: z.string().optional(),
  accessKey: z.string().optional(),
  secretKey: z.string().optional(),
  bucket: z.string().optional(),
  region: z.string().optional(),
});

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
});

backupRoutes.post("/workspaces/:id/backups/targets", async (c) => {
  const workspaceId = c.req.param("id");
  const u = await admin(c, workspaceId);
  const b = targetBody.parse(await c.req.json());
  const endpoint = b.endpoint.replace(/\/$/, "");
  // 备份 worker 会带着凭据往这个地址 PUT 整个工作区快照，
  // 所以私网/环回/链路本地（云元数据就在 169.254.169.254）一律先挡住。
  await assertSafeOutboundUrl(endpoint, "备份目标地址");
  const [t] = await db.insert(backupTargets).values({
    workspaceId,
    type: b.type,
    name: b.name,
    endpoint,
    prefix: b.prefix,
    credentials: seal(JSON.stringify(b.credentials)),
    schedule: b.schedule,
    retainDaily: b.retainDaily,
    retainWeekly: b.retainWeekly,
    encryptionKey: b.passphrase ? seal(b.passphrase) : null,
    encryptionFingerprint: b.passphrase ? fingerprint(b.passphrase) : null,
    createdBy: u.id,
  }).returning();
  return ok(c, { id: t.id, encryptionFingerprint: t.encryptionFingerprint }, 201);
});

/** 改目标。凭据和口令留空就保持原样，不要求每次都重填。 */
backupRoutes.patch("/backup-targets/:id", async (c) => {
  const t = await ownedTarget(c, c.req.param("id"));
  const b = targetBody.partial().parse(await c.req.json());
  const endpoint = b.endpoint === undefined ? undefined : b.endpoint.replace(/\/$/, "");
  if (endpoint) await assertSafeOutboundUrl(endpoint, "备份目标地址");
  const [saved] = await db.update(backupTargets).set({
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(b.prefix !== undefined ? { prefix: b.prefix } : {}),
    ...(b.schedule !== undefined ? { schedule: b.schedule } : {}),
    ...(b.retainDaily !== undefined ? { retainDaily: b.retainDaily } : {}),
    ...(b.retainWeekly !== undefined ? { retainWeekly: b.retainWeekly } : {}),
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
  await db.delete(backupTargets).where(eq(backupTargets.id, t.id));
  return ok(c, {});
});

backupRoutes.post("/backup-targets/:id/test", async (c) => {
  const t = await ownedTarget(c, c.req.param("id"));
  const [j] = await db.insert(backgroundJobs).values({
    type: "test_backup_target",
    payload: { targetId: t.id },
    runAfter: new Date(),
  }).returning();
  return ok(c, { jobId: j.id }, 202);
});

backupRoutes.post("/backup-targets/:id/run", async (c) => {
  const t = await ownedTarget(c, c.req.param("id"));
  const running = await db
    .select({ id: backupRuns.id })
    .from(backupRuns)
    .where(and(eq(backupRuns.targetId, t.id), eq(backupRuns.status, "running")));
  if (running.length) throw fail("CONFLICT_VERSION", "此目标已有备份正在运行");
  const [r] = await db.insert(backupRuns).values({ targetId: t.id, workspaceId: t.workspaceId }).returning();
  await db.insert(backgroundJobs).values({
    type: "backup_workspace",
    payload: { targetId: t.id, runId: r.id },
    runAfter: new Date(),
  });
  return ok(c, { runId: r.id }, 202);
});
