import { Hono } from "hono";
import { and, asc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { comments, notes, notifications, users } from "../db/schema.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";
import { noteAccess } from "../lib/note-access.ts";
import { limit } from "../lib/rate-limit.ts";
import { userAvatarUrl } from "../lib/user-avatar.ts";

export const noteCommentRoutes = new Hono();
const TARGET = "note_thread";
const bodySchema = z.string().trim().min(1).max(4000);
const anchorSchema = z.object({
  from: z.number().int().min(0),
  to: z.number().int().min(1),
  text: z.string().min(1).max(2000),
  prefix: z.string().max(80).default(""),
  suffix: z.string().max(80).default(""),
  version: z.number().int().min(1),
}).refine(a => a.to > a.from && a.to - a.from === a.text.length, { message: "引用范围不正确" });

async function reader(c: Parameters<typeof currentUser>[0], noteId: string) {
  const user = await currentUser(c);
  if (!user) throw fail("UNAUTHENTICATED", "未登录");
  const access = await noteAccess(noteId, user.id, "read");
  return { user, ...access };
}

async function canEdit(noteId: string, userId: string) {
  try { await noteAccess(noteId, userId, "edit"); return true; }
  catch (error) {
    if ((error as { code?: string }).code === "NOT_FOUND") return false;
    throw error;
  }
}

async function threadFor(id: string) {
  const [thread] = await db.select().from(comments).where(and(
    eq(comments.id, id), eq(comments.targetType, TARGET), isNull(comments.parentId), ne(comments.status, "hidden"),
  ));
  if (!thread) throw fail("NOT_FOUND", "评论不存在");
  return thread;
}

async function notifyThread(noteId: string, actorId: string, participantIds: string[], title: string, body: string) {
  const [note] = await db.select({ workspaceId: notes.workspaceId, createdBy: notes.createdBy }).from(notes).where(eq(notes.id, noteId));
  if (!note) return;
  const recipients = [...new Set([note.createdBy, ...participantIds])].filter(id => id !== actorId);
  if (!recipients.length) return;
  await db.insert(notifications).values(recipients.map(userId => ({
    userId,
    type: "note_comment",
    title,
    body: body.slice(0, 160),
    href: `/w/${note.workspaceId}/n/${noteId}?rail=comments`,
  })));
}

noteCommentRoutes.get("/notes/:id/discussions", async c => {
  const noteId = c.req.param("id");
  const { user } = await reader(c, noteId);
  const editable = await canEdit(noteId, user.id);
  const resolved = c.req.query("resolved") === "1";
  const roots = await db.select().from(comments).where(and(
    eq(comments.targetType, TARGET), eq(comments.targetId, noteId), isNull(comments.parentId),
    eq(comments.status, resolved ? "resolved" : "visible"),
  )).orderBy(asc(comments.createdAt));
  const replies = roots.length ? await db.select().from(comments).where(and(
    eq(comments.targetType, TARGET), inArray(comments.parentId, roots.map(row => row.id)), ne(comments.status, "hidden"),
  )).orderBy(asc(comments.createdAt)) : [];
  const authorIds = [...new Set([...roots, ...replies].map(row => row.authorUserId).filter((id): id is string => !!id))];
  const people = authorIds.length ? await db.select({
    id: users.id, displayName: users.displayName, avatarSha256: users.avatarSha256, status: users.status,
  }).from(users).where(inArray(users.id, authorIds)) : [];
  const author = (id: string | null) => {
    const person = people.find(p => p.id === id);
    if (!person || person.status === "deleted") return { id: null, displayName: "已注销用户", avatarUrl: null };
    return { id: person.id, displayName: person.displayName, avatarUrl: userAvatarUrl(person) };
  };
  const message = (row: typeof comments.$inferSelect) => ({
    id: row.id, body: row.body, author: author(row.authorUserId), mine: row.authorUserId === user.id,
    canDelete: editable || row.authorUserId === user.id, createdAt: row.createdAt, editedAt: row.editedAt,
  });
  return ok(c, {
    discussions: roots.map(root => ({
      ...message(root), status: root.status, resolvedAt: root.resolvedAt,
      canManage: editable || root.authorUserId === user.id,
      anchor: root.anchorQuote == null ? null : {
        from: root.anchorFrom!, to: root.anchorTo!, text: root.anchorQuote,
        prefix: root.anchorPrefix ?? "", suffix: root.anchorSuffix ?? "", version: root.anchorVersion!,
      },
      replies: replies.filter(reply => reply.parentId === root.id).map(message),
    })),
  });
});

noteCommentRoutes.post("/notes/:id/discussions", async c => {
  const noteId = c.req.param("id");
  const { user } = await reader(c, noteId);
  limit(`note-comment:${user.id}:${noteId}`, 30, 60_000);
  const input = z.object({ body: bodySchema, anchor: anchorSchema.nullish() }).parse(await c.req.json());
  const [row] = await db.insert(comments).values({
    targetType: TARGET, targetId: noteId, authorUserId: user.id, body: input.body, status: "visible",
    anchorFrom: input.anchor?.from, anchorTo: input.anchor?.to, anchorQuote: input.anchor?.text,
    anchorPrefix: input.anchor?.prefix, anchorSuffix: input.anchor?.suffix, anchorVersion: input.anchor?.version,
  }).returning();
  // 通知是旁路：不能让已成功落库的评论因为通知表短暂故障向客户端假报失败。
  await notifyThread(noteId, user.id, [], "笔记有一条新评论", input.body).catch(() => {});
  return ok(c, { id: row.id }, 201);
});

noteCommentRoutes.post("/discussions/:id/replies", async c => {
  const thread = await threadFor(c.req.param("id"));
  const { user } = await reader(c, thread.targetId);
  if (thread.status === "resolved") throw fail("VALIDATION", "已解决的评论需要先重新打开");
  limit(`note-comment:${user.id}:${thread.targetId}`, 30, 60_000);
  const input = z.object({ body: bodySchema }).parse(await c.req.json());
  const [row] = await db.insert(comments).values({
    targetType: TARGET, targetId: thread.targetId, parentId: thread.id,
    authorUserId: user.id, body: input.body, status: "visible",
  }).returning();
  const participants = await db.select({ authorUserId: comments.authorUserId }).from(comments).where(and(
    eq(comments.targetType, TARGET), eq(comments.targetId, thread.targetId),
    // 一篇里可能有多楼，只通知当前楼参与者。
    or(eq(comments.id, thread.id), eq(comments.parentId, thread.id)),
  ));
  await notifyThread(thread.targetId, user.id, participants.map(p => p.authorUserId).filter((id): id is string => !!id), "笔记评论有新回复", input.body).catch(() => {});
  return ok(c, { id: row.id }, 201);
});

noteCommentRoutes.patch("/discussions/:id", async c => {
  const thread = await threadFor(c.req.param("id"));
  const { user } = await reader(c, thread.targetId);
  const input = z.object({ body: bodySchema.optional(), status: z.enum(["visible", "resolved"]).optional() })
    .refine(value => value.body !== undefined || value.status !== undefined, "没有要修改的内容")
    .parse(await c.req.json());
  if (input.body !== undefined && thread.authorUserId !== user.id) throw fail("FORBIDDEN", "只能修改自己的评论");
  if (input.status !== undefined && thread.authorUserId !== user.id && !(await canEdit(thread.targetId, user.id))) throw fail("FORBIDDEN", "没有处理这条评论的权限");
  const resolved = input.status === "resolved";
  const [saved] = await db.update(comments).set({
    ...(input.body === undefined ? {} : { body: input.body, editedAt: new Date() }),
    ...(input.status === undefined ? {} : { status: input.status, resolvedAt: resolved ? new Date() : null, resolvedBy: resolved ? user.id : null }),
  }).where(eq(comments.id, thread.id)).returning();
  return ok(c, { id: saved.id, status: saved.status });
});

noteCommentRoutes.delete("/discussions/:id", async c => {
  const thread = await threadFor(c.req.param("id"));
  const { user } = await reader(c, thread.targetId);
  if (thread.authorUserId !== user.id && !(await canEdit(thread.targetId, user.id))) throw fail("FORBIDDEN", "没有删除这条评论的权限");
  await db.update(comments).set({ status: "hidden" }).where(eq(comments.id, thread.id));
  return ok(c, {});
});

noteCommentRoutes.delete("/discussion-replies/:id", async c => {
  const [reply] = await db.select().from(comments).where(and(
    eq(comments.id, c.req.param("id")), eq(comments.targetType, TARGET), ne(comments.status, "hidden"),
  ));
  if (!reply?.parentId) throw fail("NOT_FOUND", "回复不存在");
  const { user } = await reader(c, reply.targetId);
  if (reply.authorUserId !== user.id && !(await canEdit(reply.targetId, user.id))) throw fail("FORBIDDEN", "没有删除这条回复的权限");
  await db.update(comments).set({ status: "hidden" }).where(eq(comments.id, reply.id));
  return ok(c, {});
});
