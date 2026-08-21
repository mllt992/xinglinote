import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { auditLogs, moderationReviews, notes, notifications, posts, users, workspaces } from "../db/schema.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";
import { memberRole } from "../lib/workspace.ts";
import { SCOPE_LABEL, settleReports, type ModerationScope } from "../lib/moderation.ts";
import { writeNoteFile } from "../lib/files.ts";

export const moderationRoutes = new Hono();

async function requireUser(c: Parameters<typeof currentUser>[0]) {
  const u = await currentUser(c);
  if (!u) throw fail("UNAUTHENTICATED", "未登录");
  return u;
}

/** 实例管理员管全站；工作区 Owner/Admin 只管自己圈子里的那些。 */
async function assertCanReview(userId: string, instanceRole: string, workspaceId: string | null) {
  if (instanceRole === "admin") return;
  if (!workspaceId) throw fail("FORBIDDEN", "仅实例管理员可审核广场与公开文章");
  const role = await memberRole(workspaceId, userId);
  if (role !== "owner" && role !== "admin") throw fail("FORBIDDEN", "只有工作区管理员能审核圈子内容");
}

moderationRoutes.get("/moderation/queue", async c => {
  const u = await requireUser(c);
  const wsId = c.req.query("workspaceId") || null;
  await assertCanReview(u.id, u.roleInstance, wsId);
  const handled = c.req.query("status") === "handled";
  const scope = z.enum(["square", "circle", "article"]).optional().catch(undefined).parse(c.req.query("scope") || undefined);
  const rows = await db.select().from(moderationReviews).where(and(
    wsId ? eq(moderationReviews.workspaceId, wsId) : undefined,
    scope ? eq(moderationReviews.scope, scope) : undefined,
    handled ? inArray(moderationReviews.status, ["approved", "rejected"]) : eq(moderationReviews.status, "pending"),
  )).orderBy(desc(moderationReviews.createdAt)).limit(handled ? 100 : 200);
  const people = rows.length ? await db.select().from(users).where(inArray(users.id, [...new Set(rows.flatMap(r => [r.authorUserId, r.reviewerId].filter(Boolean) as string[]))])) : [];
  const spaces = rows.some(r => r.workspaceId) ? await db.select().from(workspaces) : [];
  const name = (id: string | null) => (id ? people.find(p => p.id === id)?.displayName ?? "已注销用户" : null);
  return ok(c, {
    items: rows.map(r => ({
      id: r.id, targetType: r.targetType, targetId: r.targetId, scope: r.scope, scopeLabel: SCOPE_LABEL[r.scope as ModerationScope] ?? r.scope,
      workspaceId: r.workspaceId, workspaceName: r.workspaceId ? spaces.find(w => w.id === r.workspaceId)?.name ?? null : null,
      author: name(r.authorUserId), snapshot: r.snapshot,
      aiVerdict: r.aiVerdict, aiScore: r.aiScore, aiCategories: r.aiCategories as string[], aiReason: r.aiReason, aiModel: r.aiModel,
      status: r.status, reviewer: name(r.reviewerId), reviewNote: r.reviewNote, reviewedAt: r.reviewedAt, createdAt: r.createdAt,
    })),
  });
});

moderationRoutes.patch("/moderation/:id", async c => {
  const u = await requireUser(c);
  const [item] = await db.select().from(moderationReviews).where(eq(moderationReviews.id, c.req.param("id")));
  if (!item) throw fail("NOT_FOUND", "审核记录不存在");
  await assertCanReview(u.id, u.roleInstance, item.workspaceId);
  if (item.status !== "pending") throw fail("VALIDATION", "这条已经审过了");
  const body = z.object({ action: z.enum(["approve", "reject"]), note: z.string().max(500).optional() }).parse(await c.req.json());
  const pass = body.action === "approve";

  if (item.targetType === "post") {
    const [p] = await db.select().from(posts).where(eq(posts.id, item.targetId));
    if (!p) throw fail("NOT_FOUND", "动态已经不在了");
    if (p.status === "deleted") throw fail("VALIDATION", "作者已经删掉了这条动态");
    await db.update(posts).set({ status: pass ? "visible" : "rejected", updatedAt: new Date() }).where(eq(posts.id, p.id));
  } else {
    const [n] = await db.select().from(notes).where(eq(notes.id, item.targetId));
    if (!n || n.trashedAt) throw fail("NOT_FOUND", "笔记已经不在了");
    if (pass) {
      const [saved] = await db.update(notes).set({ published: true, moderationStatus: "none", updatedAt: new Date() }).where(eq(notes.id, n.id)).returning();
      await writeNoteFile({ ...saved, noteId: saved.id });
    } else {
      const [saved] = await db.update(notes).set({ published: false, moderationStatus: "rejected", updatedAt: new Date() }).where(eq(notes.id, n.id)).returning();
      await writeNoteFile({ ...saved, noteId: saved.id });
    }
  }

  await db.update(moderationReviews).set({
    status: pass ? "approved" : "rejected", reviewerId: u.id, reviewNote: body.note?.trim() || null, reviewedAt: new Date(),
  }).where(eq(moderationReviews.id, item.id));
  await settleReports(item.targetType, item.targetId, pass ? "dismissed" : "accepted", u.id);

  const label = SCOPE_LABEL[item.scope as ModerationScope] ?? item.scope;
  await db.insert(notifications).values({
    userId: item.authorUserId, type: "moderation_result",
    title: pass ? `你的${label}已通过人工审核` : `你的${label}未通过人工审核`,
    body: body.note?.trim() || (pass ? "已经正常展示了。" : "内容不符合本站规则，可以修改后重新发布。"),
    href: item.targetType === "note" ? `/w/${item.workspaceId}/n/${item.targetId}` : item.workspaceId ? `/w/${item.workspaceId}/feed` : "/",
  });
  await db.insert(auditLogs).values({
    userId: u.id, workspaceId: item.workspaceId, actorType: "user",
    action: pass ? "moderation.approve" : "moderation.reject", result: "ok",
    targetType: item.targetType, targetId: item.targetId, details: { scope: item.scope, aiVerdict: item.aiVerdict, aiScore: item.aiScore },
  });
  return ok(c, { id: item.id, status: pass ? "approved" : "rejected" });
});
