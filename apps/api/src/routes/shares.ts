import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { hashPassword, verifyPassword } from "@kb/core";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { attachments, folders, notebooks, notes, shareLinks, workspaces } from "../db/schema.ts";
import { env } from "../env.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";
import { memberRole } from "../lib/workspace.ts";
import { noteAccess } from "../lib/note-access.ts";
import { notebookAccess } from "../lib/notebook-access.ts";

export const shareRoutes = new Hono();

const manageRoles = new Set(["owner", "admin", "editor"]);
async function userRequired(c: Parameters<typeof currentUser>[0]) {
  const user = await currentUser(c);
  if (!user) throw fail("UNAUTHENTICATED", "未登录");
  return user;
}
async function manageableNote(c: Parameters<typeof currentUser>[0], noteId: string) {
  const user = await userRequired(c);
  const {note,role}=await noteAccess(noteId,user.id,"edit");
  if (!role || !manageRoles.has(role)) throw fail("FORBIDDEN", "无权分享这篇笔记");
  return { user, note };
}
async function manageableFolder(c: Parameters<typeof currentUser>[0], folderId: string) {
  const user = await userRequired(c);
  const [folder] = await db.select().from(folders).where(eq(folders.id, folderId));
  if (!folder || folder.trashedAt) throw fail("NOT_FOUND", "目录不存在");
  await notebookAccess(folder.notebookId, user.id, "edit");
  return { user, folder };
}
async function manageableAttachment(c: Parameters<typeof currentUser>[0], attachmentId: string) {
  const user = await userRequired(c);
  const [file] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  if (!file || file.trashedAt) throw fail("NOT_FOUND", "附件不存在");
  await manageableNote(c, file.noteId);
  return { user, file };
}
function publicShare(s: typeof shareLinks.$inferSelect) {
  return {
    id: s.id,
    token: s.token,
    targetType: s.targetType,
    targetId: s.targetId,
    headingAnchor: s.headingAnchor,
    hasPassword: !!s.passwordHash,
    expiresAt: s.expiresAt,
    allowRobots: s.allowRobots,
    commentsEnabled: s.commentsEnabled,
    correctionsEnabled: s.correctionsEnabled,
    showBacklinks: s.showBacklinks,
    status: s.status,
    createdAt: s.createdAt,
    revokedAt: s.revokedAt,
  };
}
function shareCookie(token: string) { return `share_${token.slice(0, 16)}`; }
function effective(s: typeof shareLinks.$inferSelect) { return s.status === "active" && (!s.expiresAt || s.expiresAt.getTime() > Date.now()); }

/** 标题锚点：和前端渲染用的一套规则，中文直接保留。 */
export const headingSlug = (text: string) => text.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "");
/** 单节分享只给这一节：从该标题起，到下一个同级或更高级标题为止。 */
function sliceHeading(body: string, anchor: string) {
  const lines = body.split("\n");
  const start = lines.findIndex(l => /^#{1,6}\s/.test(l) && headingSlug(l.replace(/^#+\s*/, "")) === anchor);
  if (start < 0) return null;
  const level = lines[start].match(/^#+/)![0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join("\n").trim();
}
/** 目录分享是实时子树：之后新建的笔记也会出现在链接里。 */
async function subtree(folderId: string) {
  const [root] = await db.select().from(folders).where(eq(folders.id, folderId));
  if (!root || root.trashedAt) return null;
  const all = await db.select().from(folders).where(and(eq(folders.notebookId, root.notebookId), isNull(folders.trashedAt)));
  const ids = new Set([root.id]);
  for (let grew = true; grew;) { grew = false; for (const f of all) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true; } }
  const rows = await db.select().from(notes).where(and(eq(notes.notebookId, root.notebookId), isNull(notes.trashedAt)));
  return { root, folders: all.filter(f => ids.has(f.id)), notes: rows.filter(n => n.folderId && ids.has(n.folderId)) };
}

const shareInput = z.object({
  password: z.string().max(100).optional(),
  expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
  allowRobots: z.boolean().default(false),
  commentsEnabled: z.boolean().default(true),
  correctionsEnabled: z.boolean().default(false),
  showBacklinks: z.boolean().default(false),
});
async function issue(body: z.infer<typeof shareInput>, base: { workspaceId: string; targetType: string; targetId: string; headingAnchor?: string | null; createdBy: string }) {
  const [created] = await db.insert(shareLinks).values({
    token: randomBytes(24).toString("base64url"),
    ...base,
    headingAnchor: base.headingAnchor ?? null,
    passwordHash: body.password ? await hashPassword(body.password) : null,
    expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400000) : null,
    allowRobots: body.allowRobots,
    commentsEnabled: body.commentsEnabled,
    correctionsEnabled: body.correctionsEnabled,
    showBacklinks: body.showBacklinks,
  }).returning();
  return created;
}

shareRoutes.get("/notes/:id/shares", async (c) => {
  const { note } = await manageableNote(c, c.req.param("id"));
  const rows = await db.select().from(shareLinks).where(eq(shareLinks.targetId, note.id)).orderBy(desc(shareLinks.createdAt));
  return ok(c, { shares: rows.filter(s => s.targetType === "note" || s.targetType === "heading").map(publicShare) });
});

shareRoutes.post("/notes/:id/shares", async (c) => {
  const { user, note } = await manageableNote(c, c.req.param("id"));
  const body = shareInput.extend({ headingAnchor: z.string().min(1).max(200).nullable().optional() }).parse(await c.req.json());
  if (body.headingAnchor && sliceHeading(note.bodyMd, body.headingAnchor) === null) throw fail("VALIDATION", "这一节在正文里找不到了");
  const created = await issue(body, { workspaceId: note.workspaceId, targetType: body.headingAnchor ? "heading" : "note", targetId: note.id, headingAnchor: body.headingAnchor, createdBy: user.id });
  return ok(c, publicShare(created), 201);
});

shareRoutes.post("/folders/:id/shares", async (c) => {
  const { user, folder } = await manageableFolder(c, c.req.param("id"));
  const body = shareInput.parse(await c.req.json());
  const created = await issue(body, { workspaceId: folder.workspaceId, targetType: "folder", targetId: folder.id, createdBy: user.id });
  return ok(c, publicShare(created), 201);
});

shareRoutes.post("/attachments/:id/shares", async (c) => {
  const { user, file } = await manageableAttachment(c, c.req.param("id"));
  const body = shareInput.parse(await c.req.json());
  const created = await issue(body, { workspaceId: file.workspaceId, targetType: "attachment", targetId: file.id, createdBy: user.id });
  return ok(c, publicShare(created), 201);
});

/** 工作区分享总览：Admin/Owner 看全区，其他人只看自己建的。 */
shareRoutes.get("/workspaces/:id/shares", async (c) => {
  const user = await userRequired(c);
  const workspaceId = c.req.param("id");
  const role = await memberRole(workspaceId, user.id);
  if (!role) throw fail("FORBIDDEN", "不是工作区成员");
  const rows = await db.select().from(shareLinks).where(eq(shareLinks.workspaceId, workspaceId)).orderBy(desc(shareLinks.createdAt));
  const mine = role === "owner" || role === "admin" ? rows : rows.filter(s => s.createdBy === user.id);
  const [ns, fs2, as] = [await db.select().from(notes).where(eq(notes.workspaceId, workspaceId)), await db.select().from(folders).where(eq(folders.workspaceId, workspaceId)), await db.select().from(attachments).where(eq(attachments.workspaceId, workspaceId))];
  const label = (s: typeof shareLinks.$inferSelect) => s.targetType === "folder" ? fs2.find(f => f.id === s.targetId)?.title
    : s.targetType === "attachment" ? as.find(a => a.id === s.targetId)?.filename
    : ns.find(n => n.id === s.targetId)?.title;
  return ok(c, { canManageAll: role === "owner" || role === "admin", shares: mine.map(s => ({ ...publicShare(s), targetTitle: label(s) ?? "已删除的内容", createdBy: s.createdBy, mine: s.createdBy === user.id })) });
});

shareRoutes.patch("/shares/:id", async (c) => {
  const user = await userRequired(c);
  const [share] = await db.select().from(shareLinks).where(eq(shareLinks.id, c.req.param("id")));
  if (!share) throw fail("NOT_FOUND", "分享不存在");
  const role = await memberRole(share.workspaceId, user.id);
  if (!role || (!manageRoles.has(role) && share.createdBy !== user.id)) throw fail("FORBIDDEN", "无权管理此分享");
  const body = z.object({ password: z.string().max(100).nullable().optional(), expiresInDays: z.number().int().min(1).max(365).nullable().optional(), commentsEnabled: z.boolean().optional(), correctionsEnabled: z.boolean().optional(), showBacklinks: z.boolean().optional(), allowRobots: z.boolean().optional() }).parse(await c.req.json());
  const [saved] = await db.update(shareLinks).set({
    passwordHash: body.password === undefined ? share.passwordHash : body.password ? await hashPassword(body.password) : null,
    expiresAt: body.expiresInDays === undefined ? share.expiresAt : body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400000) : null,
    commentsEnabled: body.commentsEnabled ?? share.commentsEnabled,
    correctionsEnabled: body.correctionsEnabled ?? share.correctionsEnabled,
    showBacklinks: body.showBacklinks ?? share.showBacklinks,
    allowRobots: body.allowRobots ?? share.allowRobots,
  }).where(eq(shareLinks.id, share.id)).returning();
  return ok(c, publicShare(saved));
});

shareRoutes.delete("/shares/:id", async (c) => {
  const user = await userRequired(c);
  const [share] = await db.select().from(shareLinks).where(eq(shareLinks.id, c.req.param("id")));
  if (!share) throw fail("NOT_FOUND", "分享不存在");
  const role = await memberRole(share.workspaceId, user.id);
  if (!role || (!manageRoles.has(role) && share.createdBy !== user.id)) throw fail("FORBIDDEN", "无权撤销此分享");
  await db.update(shareLinks).set({ status: "revoked", revokedAt: new Date() }).where(eq(shareLinks.id, share.id));
  return ok(c, {});
});

async function loadShare(token: string) {
  const [share] = await db.select().from(shareLinks).where(eq(shareLinks.token, token));
  if (!share || !effective(share)) throw fail("NOT_FOUND", "分享不存在或已失效");
  return share;
}
const gone = () => fail("NOT_FOUND", "分享不存在或已失效");

shareRoutes.get("/public/shares/:token", async (c) => {
  const share = await loadShare(c.req.param("token"));
  if (!share.allowRobots) c.header("X-Robots-Tag", "noindex, nofollow");
  if (share.passwordHash && getCookie(c, shareCookie(share.token)) !== share.id) return ok(c, { requiresPassword: true, type: share.targetType, title: "受保护的分享" });
  const common = { requiresPassword: false, type: share.targetType, shareToken: share.token, commentsEnabled: share.commentsEnabled, correctionsEnabled: share.correctionsEnabled, showBacklinks: share.showBacklinks };

  if (share.targetType === "attachment") {
    const [file] = await db.select().from(attachments).where(eq(attachments.id, share.targetId));
    if (!file || file.trashedAt) throw gone();
    const [note] = await db.select().from(notes).where(eq(notes.id, file.noteId));
    if (!note || note.trashedAt) throw gone();
    return ok(c, { ...common, title: file.filename, attachment: { filename: file.filename, mime: file.mime, bytes: file.bytes, url: `/api/v1/public/shares/${share.token}/file` } });
  }

  if (share.targetType === "folder") {
    const tree = await subtree(share.targetId);
    if (!tree) throw gone();
    const wanted = c.req.query("noteId");
    const current = wanted ? tree.notes.find(n => n.id === wanted) : tree.notes[0];
    if (wanted && !current) throw gone();
    return ok(c, { ...common, title: tree.root.title,
      folders: tree.folders.map(f => ({ id: f.id, title: f.title, parentId: f.parentId })),
      notes: tree.notes.map(n => ({ id: n.id, title: n.title, folderId: n.folderId })),
      noteId: current?.id ?? null, noteTitle: current?.title ?? null, bodyMd: current?.bodyMd ?? "", updatedAt: current?.updatedAt ?? null });
  }

  const [note] = await db.select().from(notes).where(eq(notes.id, share.targetId));
  if (!note || note.trashedAt) throw gone();
  const [nb] = await db.select().from(notebooks).where(eq(notebooks.id, note.notebookId));
  const bodyMd = share.targetType === "heading" ? sliceHeading(note.bodyMd, share.headingAnchor ?? "") : note.bodyMd;
  if (bodyMd === null) throw gone();
  return ok(c, { ...common, noteId: note.id, title: share.targetType === "heading" ? `${note.title} · 节选` : note.title, bodyMd, updatedAt: note.updatedAt, notebookTitle: nb?.title ?? "笔记" });
});

/** 附件只能经分享 token 下载，不给可猜的物理路径。 */
shareRoutes.get("/public/shares/:token/file", async (c) => {
  const share = await loadShare(c.req.param("token"));
  if (share.targetType !== "attachment") throw gone();
  if (share.passwordHash && getCookie(c, shareCookie(share.token)) !== share.id) throw fail("FORBIDDEN", "请先解锁分享");
  const [file] = await db.select().from(attachments).where(eq(attachments.id, share.targetId));
  if (!file || file.trashedAt) throw gone();
  const [note] = await db.select().from(notes).where(eq(notes.id, file.noteId));
  if (!note || note.trashedAt) throw gone();
  const data = await readFile(join(env.dataDir, "attachments", file.workspaceId, file.storedName));
  c.header("Content-Type", file.mime);
  c.header("Content-Disposition", `${file.mime.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  c.header("X-Content-Type-Options", "nosniff");
  if (!share.allowRobots) c.header("X-Robots-Tag", "noindex, nofollow");
  return c.body(data);
});

shareRoutes.post("/public/shares/:token/unlock", async (c) => {
  const share = await loadShare(c.req.param("token"));
  if (!share.passwordHash) return ok(c, {});
  const body = z.object({ password: z.string().max(100) }).parse(await c.req.json());
  if (!(await verifyPassword(share.passwordHash, body.password))) throw fail("FORBIDDEN", "密码错误");
  setCookie(c, shareCookie(share.token), share.id, { httpOnly: true, sameSite: "Lax", secure:new URL(c.req.url).protocol==="https:", path: "/api/v1/public", maxAge: 86400 });
  return ok(c, {});
});

shareRoutes.patch("/notebooks/:id/site", async (c) => {
  const user = await userRequired(c);
  const [nb] = await db.select().from(notebooks).where(eq(notebooks.id, c.req.param("id")));
  if (!nb || nb.trashedAt) throw fail("NOT_FOUND", "笔记本不存在");
  const role = await memberRole(nb.workspaceId, user.id);
  if (role !== "owner" && role !== "admin") throw fail("FORBIDDEN", "只有管理员能发布文档站");
  const body = z.object({ published: z.boolean(), accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional() }).parse(await c.req.json());
  const [saved] = await db.update(notebooks).set({ sitePublished: body.published, siteAccent: body.accent === undefined ? nb.siteAccent : body.accent }).where(eq(notebooks.id, nb.id)).returning();
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, nb.workspaceId));
  return ok(c, { published: saved.sitePublished, slug: `/s/${ws?.slug}/${saved.slug}`, accent: saved.siteAccent });
});

shareRoutes.get("/notebooks/:id/site", async (c) => {
  const user = await userRequired(c);
  const [nb] = await db.select().from(notebooks).where(eq(notebooks.id, c.req.param("id")));
  if (!nb) throw fail("NOT_FOUND", "笔记本不存在");
  if (!(await memberRole(nb.workspaceId, user.id))) throw fail("FORBIDDEN", "无权查看");
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, nb.workspaceId));
  return ok(c, { published: nb.sitePublished, slug: `/s/${ws?.slug}/${nb.slug}`, accent: nb.siteAccent });
});

shareRoutes.get("/public/sites/:wsSlug/:nbSlug", async (c) => {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, c.req.param("wsSlug")));
  if (!ws) throw fail("NOT_FOUND", "站点不存在");
  const [nb] = await db.select().from(notebooks).where(and(eq(notebooks.workspaceId, ws.id), eq(notebooks.slug, c.req.param("nbSlug"))));
  if (!nb?.sitePublished || nb.trashedAt) throw fail("NOT_FOUND", "站点不存在");
  const list = await db.select().from(notes).where(and(eq(notes.notebookId, nb.id), eq(notes.published, true), isNull(notes.trashedAt)));
  return ok(c, { workspace: ws.name, notebook: nb.title, accent: nb.siteAccent, notes: list.map(n => ({ id: n.id, title: n.title, bodyMd: n.bodyMd, updatedAt: n.updatedAt })) });
});
