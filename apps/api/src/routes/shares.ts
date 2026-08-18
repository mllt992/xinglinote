import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { hashPassword, verifyPassword } from "@kb/core";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { folders, notebooks, notes, shareLinks, workspaces } from "../db/schema.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";
import { memberRole } from "../lib/workspace.ts";
import { noteAccess } from "../lib/note-access.ts";

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
function publicShare(s: typeof shareLinks.$inferSelect) {
  return {
    id: s.id,
    token: s.token,
    targetType: s.targetType,
    targetId: s.targetId,
    hasPassword: !!s.passwordHash,
    expiresAt: s.expiresAt,
    allowRobots: s.allowRobots,
    commentsEnabled: s.commentsEnabled,
    status: s.status,
    createdAt: s.createdAt,
    revokedAt: s.revokedAt,
  };
}
function shareCookie(token: string) { return `share_${token.slice(0, 16)}`; }
function effective(s: typeof shareLinks.$inferSelect) { return s.status === "active" && (!s.expiresAt || s.expiresAt.getTime() > Date.now()); }

shareRoutes.get("/notes/:id/shares", async (c) => {
  const { note } = await manageableNote(c, c.req.param("id"));
  const rows = await db.select().from(shareLinks).where(and(eq(shareLinks.targetType, "note"), eq(shareLinks.targetId, note.id))).orderBy(desc(shareLinks.createdAt));
  return ok(c, { shares: rows.map(publicShare) });
});

shareRoutes.post("/notes/:id/shares", async (c) => {
  const { user, note } = await manageableNote(c, c.req.param("id"));
  const body = z.object({
    password: z.string().max(100).optional(),
    expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
    allowRobots: z.boolean().default(false),
    commentsEnabled: z.boolean().default(true),
  }).parse(await c.req.json());
  const token = randomBytes(24).toString("base64url");
  const [created] = await db.insert(shareLinks).values({
    token,
    workspaceId: note.workspaceId,
    targetType: "note",
    targetId: note.id,
    passwordHash: body.password ? await hashPassword(body.password) : null,
    expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400000) : null,
    allowRobots: body.allowRobots,
    commentsEnabled: body.commentsEnabled,
    createdBy: user.id,
  }).returning();
  return ok(c, publicShare(created), 201);
});

shareRoutes.patch("/shares/:id", async (c) => {
  const user = await userRequired(c);
  const [share] = await db.select().from(shareLinks).where(eq(shareLinks.id, c.req.param("id")));
  if (!share) throw fail("NOT_FOUND", "分享不存在");
  const role = await memberRole(share.workspaceId, user.id);
  if (!role || (!manageRoles.has(role) && share.createdBy !== user.id)) throw fail("FORBIDDEN", "无权管理此分享");
  const body = z.object({ password: z.string().max(100).nullable().optional(), expiresInDays: z.number().int().min(1).max(365).nullable().optional(), commentsEnabled: z.boolean().optional() }).parse(await c.req.json());
  const [saved] = await db.update(shareLinks).set({
    passwordHash: body.password === undefined ? share.passwordHash : body.password ? await hashPassword(body.password) : null,
    expiresAt: body.expiresInDays === undefined ? share.expiresAt : body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400000) : null,
    commentsEnabled: body.commentsEnabled ?? share.commentsEnabled,
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

async function loadPublic(token: string) {
  const [share] = await db.select().from(shareLinks).where(eq(shareLinks.token, token));
  if (!share || !effective(share)) throw fail("NOT_FOUND", "分享不存在或已失效");
  if (share.targetType !== "note") throw fail("NOT_FOUND", "不支持的分享类型");
  const [note] = await db.select().from(notes).where(eq(notes.id, share.targetId));
  if (!note || note.trashedAt) throw fail("NOT_FOUND", "分享不存在或已失效");
  const [nb] = await db.select().from(notebooks).where(eq(notebooks.id, note.notebookId));
  return { share, note, nb };
}

shareRoutes.get("/public/shares/:token", async (c) => {
  const { share, note, nb } = await loadPublic(c.req.param("token"));
  if (!share.allowRobots) c.header("X-Robots-Tag", "noindex, nofollow");
  const unlocked = !share.passwordHash || getCookie(c, shareCookie(share.token)) === share.id;
  if (!unlocked) return ok(c, { requiresPassword: true, title: "受保护的分享" });
  return ok(c, { requiresPassword: false, noteId: note.id, shareToken: share.token, title: note.title, bodyMd: note.bodyMd, updatedAt: note.updatedAt, notebookTitle: nb?.title ?? "笔记", commentsEnabled: share.commentsEnabled });
});

shareRoutes.post("/public/shares/:token/unlock", async (c) => {
  const { share } = await loadPublic(c.req.param("token"));
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
