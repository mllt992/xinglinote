import { Hono } from "hono";
import { and, count, desc, eq, ilike, inArray, ne, or } from "drizzle-orm";
import { z } from "zod";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { auditLogs, contentReports, moderationReviews, notes, notifications, posts, users, workspaces } from "../db/schema.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";
import { memberRole } from "../lib/workspace.ts";
import { instanceConfig, SCOPE_LABEL, settleReports, type ModerationScope } from "../lib/moderation.ts";
import { normalizeCategories } from "../lib/moderation-verdict.ts";
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
  const legacy = c.req.query("status");
  const state = z.enum(["all", "review", "recheck", "approved", "rejected"]).optional().catch(undefined).parse(c.req.query("state") || undefined)
    ?? (legacy === "handled" ? "all" : legacy === "pending" ? "review" : "review");
  const scope = z.enum(["square", "circle", "article"]).optional().catch(undefined).parse(c.req.query("scope") || undefined);
  const kind = z.enum(["publish", "report", "appeal"]).optional().catch(undefined).parse(c.req.query("kind") || undefined);
  const q = (c.req.query("q") ?? "").replace(/[%_]/g, "").trim().slice(0, 80);
  const author = (c.req.query("author") ?? "").replace(/[%_]/g, "").trim().slice(0, 40);
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const pageSize = Math.min(50, Math.max(10, Number(c.req.query("pageSize") ?? 30) || 30));
  let authorIds: string[] | null = null;
  if (author) {
    const hits = await db.select({ id: users.id }).from(users).where(or(ilike(users.displayName, `%${author}%`), ilike(users.handle, `%${author}%`)));
    authorIds = hits.map(h => h.id);
    if (!authorIds.length) {
      const catalogEmpty = normalizeCategories((await instanceConfig())?.moderationCategories);
      return ok(c, { categories: catalogEmpty, items: [], total: 0, page, pageSize });
    }
  }
  const stateWhere = state === "approved" ? eq(moderationReviews.status, "approved")
    : state === "rejected" ? eq(moderationReviews.status, "rejected")
    : state === "recheck" ? and(eq(moderationReviews.status, "pending"), eq(moderationReviews.kind, "appeal"))
    : state === "all" ? inArray(moderationReviews.status, ["pending", "approved", "rejected"])
    : and(eq(moderationReviews.status, "pending"), ne(moderationReviews.kind, "appeal"));
  const where = and(
    wsId ? eq(moderationReviews.workspaceId, wsId) : undefined,
    scope ? eq(moderationReviews.scope, scope) : undefined,
    kind ? eq(moderationReviews.kind, kind) : undefined,
    stateWhere,
    q ? ilike(moderationReviews.snapshot, `%${q}%`) : undefined,
    authorIds ? inArray(moderationReviews.authorUserId, authorIds) : undefined,
  );
  const [{ value: total }] = await db.select({ value: count() }).from(moderationReviews).where(where);
  const rows = await db.select().from(moderationReviews).where(where)
    .orderBy(desc(moderationReviews.createdAt)).limit(pageSize).offset((page - 1) * pageSize);
  const people = rows.length ? await db.select().from(users).where(inArray(users.id, [...new Set(rows.flatMap(r => [r.authorUserId, r.reviewerId].filter(Boolean) as string[]))])) : [];
  const spaces = rows.some(r => r.workspaceId) ? await db.select().from(workspaces) : [];
  const reportRows = rows.length ? await db.select().from(contentReports).where(and(
    eq(contentReports.targetType, "post"),
    inArray(contentReports.targetId, [...new Set(rows.filter(r => r.targetType === "post").map(r => r.targetId))]),
  )) : [];
  const name = (id: string | null) => (id ? people.find(p => p.id === id)?.displayName ?? "已注销用户" : null);
  const catalog = normalizeCategories((await instanceConfig())?.moderationCategories);
  return ok(c, {
    categories: catalog,
    total, page, pageSize,
    items: rows.map(r => ({
      id: r.id, targetType: r.targetType, targetId: r.targetId, scope: r.scope, scopeLabel: SCOPE_LABEL[r.scope as ModerationScope] ?? r.scope,
      kind: r.kind ?? "publish",
      phase: r.status === "approved" ? "approved" : r.status === "rejected" ? "rejected" : r.kind === "appeal" ? "recheck" : "review",
      workspaceId: r.workspaceId, workspaceName: r.workspaceId ? spaces.find(w => w.id === r.workspaceId)?.name ?? null : null,
      author: name(r.authorUserId), snapshot: r.snapshot,
      aiVerdict: r.aiVerdict, aiScore: r.aiScore, aiCategories: r.aiCategories as string[], aiReason: r.aiReason, aiModel: r.aiModel,
      status: r.status, reviewer: name(r.reviewerId), reviewNote: r.reviewNote, reviewedAt: r.reviewedAt, createdAt: r.createdAt,
      reports: reportRows.filter(x => x.targetId === r.targetId).map(x => ({
        reason: x.reason, note: x.note, status: x.status, createdAt: x.createdAt,
      })),
    })),
  });
});

moderationRoutes.patch("/moderation/:id", async c => {
  const u = await requireUser(c);
  const [item] = await db.select().from(moderationReviews).where(eq(moderationReviews.id, c.req.param("id")));
  if (!item) throw fail("NOT_FOUND", "审核记录不存在");
  await assertCanReview(u.id, u.roleInstance, item.workspaceId);
  if (item.status === "queued") throw fail("VALIDATION", "AI 还在审，等它结束再改");
  const body = z.object({ action: z.enum(["approve", "reject"]), note: z.string().max(500).optional() }).parse(await c.req.json());
  const pass = body.action === "approve";
  const changed = item.status !== (pass ? "approved" : "rejected");

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
  const wasHandled = item.status === "approved" || item.status === "rejected";
  await db.insert(notifications).values({
    userId: item.authorUserId, type: "moderation_result",
    title: wasHandled
      ? (pass ? `你的${label}已恢复公开` : `你的${label}已被下架`)
      : (pass ? `你的${label}已通过人工审核` : `你的${label}未通过人工审核`),
    body: body.note?.trim() || (pass ? "已经正常展示了。" : "内容不符合本站规则，可以修改后重新发布。"),
    href: item.targetType === "note" ? `/w/${item.workspaceId}/n/${item.targetId}` : item.workspaceId ? `/w/${item.workspaceId}/feed` : "/",
  });
  await db.insert(auditLogs).values({
    userId: u.id, workspaceId: item.workspaceId, actorType: "user",
    action: pass ? "moderation.approve" : "moderation.reject", result: "ok",
    targetType: item.targetType, targetId: item.targetId,
    details: { scope: item.scope, aiVerdict: item.aiVerdict, aiScore: item.aiScore, revised: changed && wasHandled },
  });
  return ok(c, { id: item.id, status: pass ? "approved" : "rejected" });
});
