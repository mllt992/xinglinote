import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { auditLogs, backgroundJobs, shareLinks, workspaceInvites, workspaces } from "../db/schema.ts";
import { dropWorkspaceFromMcpTokens } from "../lib/mcp-workspaces.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";

export const workspaceLifecycleRoutes = new Hono();

async function ownerWorkspace(c: Parameters<typeof currentUser>[0], id: string) {
  const u = await currentUser(c);
  if (!u) throw fail("UNAUTHENTICATED", "未登录");
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id));
  if (!ws) throw fail("NOT_FOUND", "工作区不存在");
  if (ws.kind === "personal") throw fail("FORBIDDEN", "个人工作区不能注销");
  if (ws.ownerId !== u.id) throw fail("FORBIDDEN", "只有 Owner 可以注销工作区");
  return { u, ws };
}

workspaceLifecycleRoutes.delete("/workspaces/:id", async (c) => {
  const { u, ws } = await ownerWorkspace(c, c.req.param("id"));
  if (ws.deletionScheduledAt) throw fail("VALIDATION", "工作区已在注销宽限期");
  const body = z.object({ confirmName: z.string() }).parse(await c.req.json());
  if (body.confirmName !== ws.name) throw fail("VALIDATION", "请输入完整工作区名称确认");
  const scheduled = new Date(Date.now() + 86400000);
  await db.transaction(async (tx) => {
    await tx.update(workspaces).set({ frozen: true, deletionScheduledAt: scheduled }).where(eq(workspaces.id, ws.id));
    await tx.update(shareLinks).set({ status: "revoked", revokedAt: new Date() }).where(eq(shareLinks.workspaceId, ws.id));
    await dropWorkspaceFromMcpTokens(tx, { workspaceId: ws.id, empty: "revoke" });
    await tx.update(workspaceInvites).set({ status: "revoked" }).where(eq(workspaceInvites.workspaceId, ws.id));
    await tx.insert(backgroundJobs).values({ type: "delete_workspace", payload: { workspaceId: ws.id }, runAfter: scheduled });
    await tx.insert(auditLogs).values({ userId: u.id, workspaceId: ws.id, actorType: "user", action: "workspace.delete_scheduled", result: "ok", details: { scheduledAt: scheduled.toISOString() } });
  });
  return ok(c, { scheduledAt: scheduled });
});

workspaceLifecycleRoutes.post("/workspaces/:id/cancel-deletion", async (c) => {
  const { u, ws } = await ownerWorkspace(c, c.req.param("id"));
  if (!ws.deletionScheduledAt) throw fail("VALIDATION", "工作区未处于注销宽限期");
  await db.transaction(async (tx) => {
    await tx.update(workspaces).set({ frozen: false, deletionScheduledAt: null }).where(eq(workspaces.id, ws.id));
    await tx.delete(backgroundJobs).where(and(eq(backgroundJobs.type, "delete_workspace"), eq(backgroundJobs.status, "pending"), sql`payload->>'workspaceId' = ${ws.id}`));
    await tx.insert(auditLogs).values({ userId: u.id, workspaceId: ws.id, actorType: "user", action: "workspace.delete_cancelled", result: "ok" });
  });
  return ok(c, {});
});
