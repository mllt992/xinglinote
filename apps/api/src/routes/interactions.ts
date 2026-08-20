import { createHash } from "node:crypto";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { comments, corrections, notebooks, notes, noteVersions, notifications, shareLinks, users, workspaceMembers } from "../db/schema.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";
import { limit } from "../lib/rate-limit.ts";
import { clientIp } from "../lib/client-ip.ts";
import { shareCookieName, shareCookieValid } from "../lib/share-cookie.ts";
import { issueChallenge, solveChallenge } from "../lib/challenge.ts";
import { memberRole } from "../lib/workspace.ts";
import { writeNoteFile } from "../lib/files.ts";
import { rebuildLinks } from "../lib/links.ts";
import { assertUserStorage, textBytes } from "../lib/quota.ts";
import { noteAccess } from "../lib/note-access.ts";

export const interactionRoutes = new Hono();
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function publicChannel(c:Parameters<typeof getCookie>[0],noteId:string,shareToken?: string, siteNotebookId?: string) {
  if (shareToken) { const [s] = await db.select().from(shareLinks).where(eq(shareLinks.token, shareToken)); if (!s || s.status !== "active" || (s.targetType!=="note"&&s.targetType!=="heading")||s.targetId!==noteId||(s.expiresAt && s.expiresAt.getTime() <= Date.now())) throw fail("NOT_FOUND", "分享不存在");if(s.passwordHash&&!shareCookieValid(getCookie(c,shareCookieName(s.token)),s.id,s.passwordHash))throw fail("FORBIDDEN","请先解锁分享"); return { shareId: s.id, siteNotebookId: null, comments: s.commentsEnabled, corrections: s.correctionsEnabled }; }
  if (siteNotebookId) {const [nb]=await db.select().from(notebooks).where(eq(notebooks.id,siteNotebookId));const[note]=await db.select().from(notes).where(eq(notes.id,noteId));if(!nb?.sitePublished||nb.trashedAt||!note||note.notebookId!==nb.id||!note.published||note.trashedAt)throw fail("NOT_FOUND","文档站内容不存在");return { shareId: null, siteNotebookId, comments: true, corrections: true };}
  throw fail("VALIDATION", "缺少公开来源");
}
/**
 * 待处理的访客互动通知谁。
 *
 * 只发给笔记作者和工作区的 owner/admin——以前是「所有非 viewer 成员」，
 * 一个几十人的工作区里，访客每提交一条评论就是几十行通知，
 * 脚本刷几下就能把所有人的铃铛淹掉。
 */
async function notifyEditors(noteId: string, title: string, body: string) {
  const [note] = await db.select().from(notes).where(eq(notes.id, noteId));
  if (!note) return;
  const managers = await db.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, note.workspaceId), inArray(workspaceMembers.role, ["owner", "admin"])));
  const ids = new Set([note.createdBy, ...managers.map(m => m.userId)]);
  if (ids.size) {
    await db.insert(notifications).values([...ids].map(userId => ({
      userId, type: "interaction_pending", title, body, href: `/w/${note.workspaceId}/n/${note.id}`,
    })));
  }
}

interactionRoutes.get("/public/notes/:id/comments", async c => { const noteId = c.req.param("id"); const channel=await publicChannel(c,noteId,c.req.query("shareToken"), c.req.query("siteNotebookId")); const rows = await db.select().from(comments).where(and(eq(comments.targetType, "note"), eq(comments.targetId, noteId),channel.shareId?eq(comments.shareId,channel.shareId):eq(comments.siteNotebookId,channel.siteNotebookId!), eq(comments.status, "visible"))).orderBy(desc(comments.createdAt)); const authorIds = [...new Set(rows.map(r => r.authorUserId).filter((x): x is string => !!x))];
  const authors = authorIds.length ? await db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, authorIds)) : [];
  const viewer = await currentUser(c); return ok(c, { comments: rows.map(r => ({ id: r.id, body: r.body, parentId: r.parentId, author: r.authorUserId ? authors.find(u => u.id === r.authorUserId)?.displayName ?? "已注销用户" : r.guestName, createdAt: r.createdAt, editedAt: r.editedAt, mine: !!viewer && r.authorUserId === viewer.id, editableUntil: new Date(new Date(r.createdAt).getTime() + 300000) })) }); });
interactionRoutes.post("/public/notes/:id/comments", async c => { const noteId = c.req.param("id"); const channel = await publicChannel(c,noteId,c.req.query("shareToken"), c.req.query("siteNotebookId")); if (!channel.comments) throw fail("FORBIDDEN", "评论已关闭"); const [note] = await db.select().from(notes).where(eq(notes.id, noteId)); if (!note || note.trashedAt) throw fail("NOT_FOUND", "笔记不存在"); const user = await currentUser(c); const body = z.object({ body: z.string().min(1).max(2000), parentId: z.string().uuid().nullish(), guestName: z.string().min(1).max(40).optional(), guestEmail: z.string().email().optional(), challengeToken: z.string().optional(), challengeAnswer: z.string().optional() }).parse(await c.req.json());
  if (user) limit(`comment:user:${user.id}:${note.id}`, 10, 60_000); else limit(`comment:ip:${clientIp(c)}`, 5, 600_000);
  if (!user) { if (!body.guestName) throw fail("VALIDATION", "访客昵称必填"); if (!solveChallenge(body.challengeToken, body.challengeAnswer)) throw fail("VALIDATION", "验证码不正确或已过期"); }
  if (body.parentId) { const [parent] = await db.select().from(comments).where(eq(comments.id, body.parentId)); if (!parent || parent.targetId !== note.id || parent.status !== "visible") throw fail("VALIDATION", "回复的评论不存在"); if (parent.parentId) throw fail("VALIDATION", "只支持一层回复"); }
  const status = user ? "visible" : "pending"; const [row] = await db.insert(comments).values({ targetType: "note", targetId: note.id, shareId: channel.shareId, siteNotebookId: channel.siteNotebookId, authorUserId: user?.id, guestName: body.guestName, guestEmail: body.guestEmail, parentId: body.parentId ?? null, body: body.body, status }).returning(); if (status === "pending") await notifyEditors(note.id, "有新的待审评论", body.body.slice(0,100)); return ok(c, { id: row.id, status }, 201); });
interactionRoutes.post("/public/notes/:id/corrections", async c => { const noteId = c.req.param("id"); const channel = await publicChannel(c,noteId,c.req.query("shareToken"), c.req.query("siteNotebookId")); if (!channel.corrections) throw fail("FORBIDDEN", "此分享没有开启纠错"); const [note] = await db.select().from(notes).where(eq(notes.id, noteId)); if (!note || note.trashedAt) throw fail("NOT_FOUND", "笔记不存在"); const user = await currentUser(c); const body = z.object({ originalExcerpt: z.string().min(1).max(2000), suggested: z.string().max(5000), comment: z.string().max(1000).optional(), guestName: z.string().min(1).max(40).optional(), guestEmail: z.string().email().optional(), challengeToken: z.string().optional(), challengeAnswer: z.string().optional() }).parse(await c.req.json());
  // 和评论同一套口径：访客要过验证码，所有人都限流。
  // 这条路径以前两样都没有，而且每提交一次就给全工作区成员各插一行通知。
  if (user) limit(`fix:user:${user.id}:${note.id}`, 10, 60_000); else limit(`fix:ip:${clientIp(c)}`, 5, 600_000);
  if (!note.bodyMd.includes(body.originalExcerpt)) throw fail("VALIDATION", "原文已变化或不存在");
  if (!user) { if (!body.guestName) throw fail("VALIDATION", "访客昵称必填"); if (!solveChallenge(body.challengeToken, body.challengeAnswer)) throw fail("VALIDATION", "验证码不正确或已过期"); } const [row] = await db.insert(corrections).values({ noteId, shareId: channel.shareId, siteNotebookId: channel.siteNotebookId, originalExcerpt: body.originalExcerpt, originalHash: hash(body.originalExcerpt), suggested: body.suggested, comment: body.comment, authorUserId: user?.id, guestName: body.guestName, guestEmail: body.guestEmail }).returning(); await notifyEditors(note.id, "有新的纠错建议", body.comment ?? body.originalExcerpt.slice(0,100)); return ok(c, { id: row.id, status: row.status }, 201); });

async function editor(c: Parameters<typeof currentUser>[0], noteId: string) { const u = await currentUser(c); if (!u) throw fail("UNAUTHENTICATED", "未登录");const {note:n}=await noteAccess(noteId,u.id,"edit");return {u,n}; }
interactionRoutes.get("/notes/:id/interactions", async c => {
  await editor(c,c.req.param("id"));
  const noteId=c.req.param("id");
  // scope=handled 取已处理的历史，审核完的东西不该就此消失（设计 09）。
  const handled=c.req.query("scope")==="handled";
  const cs=await db.select().from(comments).where(and(eq(comments.targetId,noteId),handled?ne(comments.status,"pending"):eq(comments.status,"pending"))).orderBy(desc(comments.createdAt)).limit(handled?50:200);
  const fixes=await db.select().from(corrections).where(and(eq(corrections.noteId,noteId),handled?ne(corrections.status,"pending"):eq(corrections.status,"pending"))).orderBy(desc(corrections.createdAt)).limit(handled?50:200);
  return ok(c,{comments:cs,corrections:fixes});
});
interactionRoutes.patch("/comments/:id/review", async c => { const [comment]=await db.select().from(comments).where(eq(comments.id,c.req.param("id"))); if(!comment)throw fail("NOT_FOUND","评论不存在"); await editor(c,comment.targetId); const body=z.object({status:z.enum(["visible","rejected","hidden"])}).parse(await c.req.json()); await db.update(comments).set({status:body.status}).where(eq(comments.id,comment.id)); return ok(c,{}); });
interactionRoutes.patch("/corrections/:id/review", async c => { const [fix]=await db.select().from(corrections).where(eq(corrections.id,c.req.param("id"))); if(!fix)throw fail("NOT_FOUND","纠错不存在"); const {u,n}=await editor(c,fix.noteId); const body=z.object({action:z.enum(["accept","reject"]),suggested:z.string().max(20000).optional()}).parse(await c.req.json());const applied=body.suggested??fix.suggested; if(body.action==="reject"){await db.update(corrections).set({status:"rejected",reviewedAt:new Date(),reviewedBy:u.id}).where(eq(corrections.id,fix.id));return ok(c,{status:"rejected"});} const idx=n.bodyMd.indexOf(fix.originalExcerpt); if(idx<0||hash(n.bodyMd.slice(idx,idx+fix.originalExcerpt.length))!==fix.originalHash){await db.update(corrections).set({status:"stale",reviewedAt:new Date(),reviewedBy:u.id}).where(eq(corrections.id,fix.id));return ok(c,{status:"stale"});} const bodyMd=n.bodyMd.slice(0,idx)+applied+n.bodyMd.slice(idx+fix.originalExcerpt.length); await assertUserStorage(n.createdBy,textBytes(n.title,bodyMd)-textBytes(n.title,n.bodyMd)); const [saved]=await db.update(notes).set({bodyMd,version:n.version+1,updatedBy:u.id,updatedAt:new Date()}).where(and(eq(notes.id,n.id),eq(notes.version,n.version))).returning();if(!saved)throw fail("CONFLICT_VERSION","笔记刚刚被其他人修改，请重新审核"); await db.insert(noteVersions).values({noteId:n.id,version:saved.version,title:saved.title,bodyMd:saved.bodyMd,editorId:u.id,source:"correction"}); await db.update(corrections).set({status:"accepted",reviewedAt:new Date(),reviewedBy:u.id}).where(eq(corrections.id,fix.id)); await writeNoteFile({...saved,noteId:saved.id}); await rebuildLinks(saved.id,saved.workspaceId,saved.bodyMd); return ok(c,{status:"accepted",version:saved.version}); });
interactionRoutes.get("/public/captcha", async c => { limit(`captcha:${clientIp(c)}`, 30, 60_000); return ok(c, issueChallenge()); });
interactionRoutes.patch("/public/comments/:id", async c => {
  const user = await currentUser(c); if (!user) throw fail("UNAUTHENTICATED", "未登录");
  const [comment] = await db.select().from(comments).where(eq(comments.id, c.req.param("id")));
  if (!comment || comment.status !== "visible") throw fail("NOT_FOUND", "评论不存在");
  if (comment.authorUserId !== user.id) throw fail("FORBIDDEN", "只能改自己的评论");
  if (Date.now() - new Date(comment.createdAt).getTime() > 300000) throw fail("EXPIRED", "超过 5 分钟就不能再改了，只能隐藏");
  const body = z.object({ body: z.string().min(1).max(2000) }).parse(await c.req.json());
  const [saved] = await db.update(comments).set({ body: body.body, editedAt: new Date() }).where(eq(comments.id, comment.id)).returning();
  return ok(c, { id: saved.id, body: saved.body, editedAt: saved.editedAt });
});
interactionRoutes.get("/notifications", async c => { const u=await currentUser(c);if(!u)throw fail("UNAUTHENTICATED","未登录"); const rows=await db.select().from(notifications).where(eq(notifications.userId,u.id)).orderBy(desc(notifications.createdAt)).limit(50);return ok(c,{notifications:rows}); });
interactionRoutes.post("/notifications/read", async c => { const u=await currentUser(c);if(!u)throw fail("UNAUTHENTICATED","未登录");await db.update(notifications).set({readAt:new Date()}).where(and(eq(notifications.userId,u.id),isNull(notifications.readAt)));return ok(c,{}); });
