import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { canPublishNotebook, canRequestSitePublish, hashPassword, verifyPassword } from "@kb/core";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { attachments, folders, notebooks, notes, notifications, shareLinks, users, workspaceMembers, workspaces } from "../db/schema.ts";
import { ok } from "../http.ts";
import { readStoredFile } from "../lib/blobs.ts";
import { currentUser } from "../lib/session.ts";
import { memberRole } from "../lib/workspace.ts";
import { noteAccess } from "../lib/note-access.ts";
import { notebookAccess } from "../lib/notebook-access.ts";
import { limit } from "../lib/rate-limit.ts";
import { clientIp } from "../lib/client-ip.ts";
import { shareCookieName, shareCookieValid, shareCookieValue } from "../lib/share-cookie.ts";
import {
  headingSlug, loadLiveShare, loadLiveSite, renderShare, renderSite, sliceHeading,
} from "../lib/share-render.ts";
import {
  dismissSaved, getSaved, listSaved, maybeAutoSave, openLocation, peekSaved, reactivateSaved, renderSavedContent, saveManually,
} from "../lib/saved-shares.ts";

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
async function manageableNotebook(c: Parameters<typeof currentUser>[0], notebookId: string) {
  const user = await userRequired(c);
  const { notebook } = await notebookAccess(notebookId, user.id, "edit");
  return { user, notebook };
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
export { headingSlug };

const shareInput = z.object({
  password: z.string().max(100).optional(),
  expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
  allowRobots: z.boolean().default(false),
  commentsEnabled: z.boolean().default(true),
  correctionsEnabled: z.boolean().default(false),
  showBacklinks: z.boolean().default(false),
});
/**
 * 分享 token 是**明文**存的，和仓库里其它凭据（会话、MCP 钥匙、邀请码）不一样。
 * 这是刻意的：分享管理页要能反复把完整链接显示出来给人复制，hash 存就取不回原文了。
 * 代价是数据库泄露等于这些链接泄露，所以它们被设计成低权限、可吊销、可设密码、
 * 可设有效期的一次性能力 URL，而不是账号级凭据；`X-Robots-Tag: noindex` 也一直带着。
 * 日历订阅地址（calendar_feed_tokens）同理。
 */
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

shareRoutes.get("/notebooks/:id/shares", async (c) => {
  const { notebook } = await manageableNotebook(c, c.req.param("id"));
  const rows = await db.select().from(shareLinks).where(eq(shareLinks.targetId, notebook.id)).orderBy(desc(shareLinks.createdAt));
  return ok(c, { shares: rows.filter(s => s.targetType === "notebook").map(publicShare) });
});

shareRoutes.post("/notebooks/:id/shares", async (c) => {
  const { user, notebook } = await manageableNotebook(c, c.req.param("id"));
  const body = shareInput.parse(await c.req.json());
  const created = await issue(body, { workspaceId: notebook.workspaceId, targetType: "notebook", targetId: notebook.id, createdBy: user.id });
  return ok(c, publicShare(created), 201);
});

shareRoutes.get("/folders/:id/shares", async (c) => {
  const { folder } = await manageableFolder(c, c.req.param("id"));
  const rows = await db.select().from(shareLinks).where(eq(shareLinks.targetId, folder.id)).orderBy(desc(shareLinks.createdAt));
  return ok(c, { shares: rows.filter(s => s.targetType === "folder").map(publicShare) });
});

shareRoutes.post("/folders/:id/shares", async (c) => {
  const { user, folder } = await manageableFolder(c, c.req.param("id"));
  const body = shareInput.parse(await c.req.json());
  const created = await issue(body, { workspaceId: folder.workspaceId, targetType: "folder", targetId: folder.id, createdBy: user.id });
  return ok(c, publicShare(created), 201);
});

shareRoutes.get("/attachments/:id/shares", async (c) => {
  const { file } = await manageableAttachment(c, c.req.param("id"));
  const rows = await db.select().from(shareLinks).where(eq(shareLinks.targetId, file.id)).orderBy(desc(shareLinks.createdAt));
  return ok(c, { shares: rows.filter(s => s.targetType === "attachment").map(publicShare) });
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
  // 只按分享指到的那几个 id 取标题。以前是把整个工作区的 notes（含全部 bodyMd）、
  // folders、attachments 三张表全拉出来，只为了 find 一个 title。
  const wanted = (kind: string) => mine.filter(s => (kind === "note" ? s.targetType === "note" || s.targetType === "heading" : s.targetType === kind)).map(s => s.targetId);
  const pick = async <T>(ids: string[], run: (ids: string[]) => Promise<T[]>) => (ids.length ? run(ids) : []);
  const [ns, fs2, as, nbs] = await Promise.all([
    pick(wanted("note"), ids => db.select({ id: notes.id, title: notes.title }).from(notes).where(inArray(notes.id, ids))),
    pick(wanted("folder"), ids => db.select({ id: folders.id, title: folders.title }).from(folders).where(inArray(folders.id, ids))),
    pick(wanted("attachment"), ids => db.select({ id: attachments.id, filename: attachments.filename }).from(attachments).where(inArray(attachments.id, ids))),
    pick(wanted("notebook"), ids => db.select({ id: notebooks.id, title: notebooks.title }).from(notebooks).where(inArray(notebooks.id, ids))),
  ]);
  const label = (s: typeof shareLinks.$inferSelect) => s.targetType === "folder" ? fs2.find(f => f.id === s.targetId)?.title
    : s.targetType === "attachment" ? as.find(a => a.id === s.targetId)?.filename
    : s.targetType === "notebook" ? nbs.find(n => n.id === s.targetId)?.title
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
  return loadLiveShare(token);
}
const gone = () => fail("NOT_FOUND", "分享不存在或已失效");

async function savedChip(userId: string | undefined, channel: Parameters<typeof peekSaved>[1]) {
  if (!userId) return null;
  const row = await peekSaved(userId, channel);
  return row ? { id: row.id, status: row.status } : null;
}

shareRoutes.get("/public/shares/:token", async (c) => {
  const share = await loadShare(c.req.param("token"));
  if (!share.allowRobots) c.header("X-Robots-Tag", "noindex, nofollow");
  if (share.passwordHash && !shareCookieValid(getCookie(c, shareCookieName(share.token)), share.id, share.passwordHash)) {
    return ok(c, { requiresPassword: true, type: share.targetType, title: "受保护的分享" });
  }
  const payload = await renderShare(share, c.req.query("noteId"));
  const user = await currentUser(c);
  const lastNoteId = "noteId" in payload ? (payload as { noteId?: string | null }).noteId : null;
  const channel = { source: "share" as const, share, lastNoteId };
  if (user) await maybeAutoSave(user, channel);
  return ok(c, { ...payload, savedShare: await savedChip(user?.id, channel) });
});

/** 附件只能经分享 token 下载，不给可猜的物理路径。 */
shareRoutes.get("/public/shares/:token/file", async (c) => {
  const share = await loadShare(c.req.param("token"));
  if (share.targetType !== "attachment") throw gone();
  const unlocked = !share.passwordHash || shareCookieValid(getCookie(c, shareCookieName(share.token)), share.id, share.passwordHash);
  if (!unlocked) {
    const user = await currentUser(c);
    const kept = user ? await peekSaved(user.id, { source: "share", share }) : null;
    if (kept?.status !== "active") throw fail("FORBIDDEN", "请先解锁分享");
  }
  const [file] = await db.select().from(attachments).where(eq(attachments.id, share.targetId));
  if (!file || file.trashedAt) throw gone();
  const [note] = await db.select().from(notes).where(eq(notes.id, file.noteId));
  if (!note || note.trashedAt) throw gone();
  const data = await readStoredFile(file);
  c.header("Content-Type", file.mime);
  c.header("Content-Disposition", `${file.mime.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  c.header("X-Content-Type-Options", "nosniff");
  if (!share.allowRobots) c.header("X-Robots-Tag", "noindex, nofollow");
  return c.body(data);
});

shareRoutes.post("/public/shares/:token/unlock", async (c) => {
  const token = c.req.param("token");
  // 没有限流的话，这就是个可以对着分享密码无限猜的接口。
  // 按 token 和来源各限一道：换 IP 换不掉对同一个分享的总次数。
  limit(`share-unlock:${token}`, 10, 600_000);
  limit(`share-unlock:${clientIp(c)}`, 30, 600_000);
  const share = await loadShare(token);
  if (!share.passwordHash) return ok(c, {});
  const body = z.object({ password: z.string().max(100) }).parse(await c.req.json());
  if (!(await verifyPassword(share.passwordHash, body.password))) throw fail("FORBIDDEN", "密码错误");
  setCookie(c, shareCookieName(share.token), shareCookieValue(share.id, share.passwordHash), {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    path: "/api/v1/public",
    maxAge: 86400,
  });
  return ok(c, {});
});

function sitePending(nb: { sitePublished: boolean; sitePublishRequestedBy: string | null }) {
  return !nb.sitePublished && !!nb.sitePublishRequestedBy;
}
async function siteView(nb: typeof notebooks.$inferSelect, userId: string) {
  const { workspace, role, notebookRole } = await notebookAccess(nb.id, userId, "read");
  const canPublish = canPublishNotebook(role);
  const canRequest = canRequestSitePublish({
    actor: { kind: "user", userId },
    notebook: { id: nb.id, workspaceId: workspace.id, visibility: nb.visibility as "open" | "private" | "restricted", createdBy: nb.createdBy, frozenWorkspace: workspace.frozen },
    wsRole: role, nbMemberRole: notebookRole,
  });
  return {
    published: nb.sitePublished,
    pending: sitePending(nb),
    requestedBy: nb.sitePublishRequestedBy,
    requestedAt: nb.sitePublishRequestedAt,
    canPublish, canRequest,
    slug: `/s/${workspace.slug}/${nb.slug}`,
    accent: nb.siteAccent,
  };
}
async function notifySiteManagers(workspaceId: string, title: string, body: string, href: string) {
  const managers = await db.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.role, ["owner", "admin"])));
  if (!managers.length) return;
  await db.insert(notifications).values(managers.map(m => ({ userId: m.userId, type: "site_publish_request", title, body, href })));
}

shareRoutes.patch("/notebooks/:id/site", async (c) => {
  const user = await userRequired(c);
  const id = c.req.param("id");
  const [nb] = await db.select().from(notebooks).where(eq(notebooks.id, id));
  if (!nb || nb.trashedAt) throw fail("NOT_FOUND", "笔记本不存在");
  const { role } = await notebookAccess(id, user.id, "read");
  const isAdmin = canPublishNotebook(role);
  const body = z.object({
    published: z.boolean().optional(),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    action: z.enum(["approve", "reject"]).optional(),
  }).parse(await c.req.json());

  let next = { sitePublished: nb.sitePublished, siteAccent: body.accent === undefined ? nb.siteAccent : body.accent, sitePublishRequestedBy: nb.sitePublishRequestedBy, sitePublishRequestedAt: nb.sitePublishRequestedAt };

  if (body.action === "approve" || body.action === "reject") {
    if (!isAdmin) throw fail("FORBIDDEN", "只有管理员能审文档站申请");
    if (!sitePending(nb)) throw fail("VALIDATION", "没有待审的发布申请");
    const requester = nb.sitePublishRequestedBy;
    if (body.action === "approve") {
      next = { ...next, sitePublished: true, sitePublishRequestedBy: null, sitePublishRequestedAt: null };
    } else {
      next = { ...next, sitePublishRequestedBy: null, sitePublishRequestedAt: null };
    }
    const [saved] = await db.update(notebooks).set(next).where(eq(notebooks.id, nb.id)).returning();
    if (requester) {
      await db.insert(notifications).values({
        userId: requester, type: "site_publish_decided",
        title: body.action === "approve" ? `《${nb.title}》已发布为文档站` : `《${nb.title}》的发布申请未通过`,
        body: body.action === "approve" ? "管理员已通过，对外地址现在可以打开。" : "管理员驳回了这次申请。改好后可以再提交。",
        href: `/w/${nb.workspaceId}`,
      });
    }
    return ok(c, await siteView(saved, user.id));
  }

  if (body.published === true) {
    if (isAdmin) {
      next = { ...next, sitePublished: true, sitePublishRequestedBy: null, sitePublishRequestedAt: null };
    } else {
      await notebookAccess(id, user.id, "edit");
      if (nb.sitePublished) return ok(c, await siteView(nb, user.id));
      if (sitePending(nb) && nb.sitePublishRequestedBy === user.id) return ok(c, await siteView(nb, user.id));
      if (sitePending(nb) && nb.sitePublishRequestedBy !== user.id) throw fail("VALIDATION", "已有待审的发布申请");
      next = { ...next, sitePublishRequestedBy: user.id, sitePublishRequestedAt: new Date() };
      const [saved] = await db.update(notebooks).set(next).where(eq(notebooks.id, nb.id)).returning();
      await notifySiteManagers(nb.workspaceId, `《${nb.title}》申请发布为文档站`, "有编辑权的成员提交了申请，通过后才会对外上线。", `/w/${nb.workspaceId}/settings?tab=shares`);
      return ok(c, await siteView(saved, user.id));
    }
  } else if (body.published === false) {
    if (isAdmin) {
      next = { ...next, sitePublished: false, sitePublishRequestedBy: null, sitePublishRequestedAt: null };
    } else {
      if (nb.sitePublished) throw fail("FORBIDDEN", "只有管理员能下线文档站");
      if (!sitePending(nb)) return ok(c, await siteView(nb, user.id));
      if (nb.sitePublishRequestedBy !== user.id) throw fail("FORBIDDEN", "只能撤回自己的申请");
      next = { ...next, sitePublishRequestedBy: null, sitePublishRequestedAt: null };
    }
  }

  const [saved] = await db.update(notebooks).set(next).where(eq(notebooks.id, nb.id)).returning();
  return ok(c, await siteView(saved, user.id));
});

shareRoutes.get("/notebooks/:id/site", async (c) => {
  const user = await userRequired(c);
  const [nb] = await db.select().from(notebooks).where(eq(notebooks.id, c.req.param("id")));
  if (!nb) throw fail("NOT_FOUND", "笔记本不存在");
  return ok(c, await siteView(nb, user.id));
});

shareRoutes.get("/workspaces/:id/site-requests", async (c) => {
  const user = await userRequired(c);
  const workspaceId = c.req.param("id");
  const role = await memberRole(workspaceId, user.id);
  if (!canPublishNotebook(role)) throw fail("FORBIDDEN", "只有管理员能看发布申请");
  const [ws] = await db.select({ slug: workspaces.slug }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const rows = await db.select({
    id: notebooks.id, title: notebooks.title, slug: notebooks.slug,
    requestedBy: notebooks.sitePublishRequestedBy, requestedAt: notebooks.sitePublishRequestedAt,
    requesterName: users.displayName,
  }).from(notebooks)
    .leftJoin(users, eq(users.id, notebooks.sitePublishRequestedBy))
    .where(and(eq(notebooks.workspaceId, workspaceId), eq(notebooks.sitePublished, false), isNull(notebooks.trashedAt)))
    .orderBy(desc(notebooks.sitePublishRequestedAt));
  return ok(c, { requests: rows.filter(r => r.requestedBy).map(r => ({
    notebookId: r.id, title: r.title, requestedBy: r.requestedBy, requestedByName: r.requesterName ?? "未知用户",
    requestedAt: r.requestedAt, slug: `/s/${ws?.slug}/${r.slug}`,
  })) });
});

shareRoutes.get("/public/sites/:wsSlug/:nbSlug", async (c) => {
  const { ws, nb } = await loadLiveSite(c.req.param("wsSlug"), c.req.param("nbSlug"));
  const payload = await renderSite(ws, nb);
  const user = await currentUser(c);
  const channel = { source: "site" as const, notebook: nb, workspaceName: ws.name, lastNoteId: payload.notes[0]?.id ?? null };
  if (user) await maybeAutoSave(user, channel);
  return ok(c, { ...payload, savedShare: await savedChip(user?.id, channel) });
});

shareRoutes.get("/me/saved-shares", async (c) => {
  const user = await userRequired(c);
  return ok(c, { items: await listSaved(user.id) });
});

shareRoutes.post("/me/saved-shares", async (c) => {
  const user = await userRequired(c);
  const body = z.object({
    shareToken: z.string().min(1).max(80).optional(),
    site: z.object({ wsSlug: z.string().min(1).max(80), nbSlug: z.string().min(1).max(80) }).optional(),
    lastNoteId: z.string().uuid().nullable().optional(),
    reactivateId: z.string().uuid().optional(),
  }).parse(await c.req.json());
  if (body.reactivateId) {
    const saved = await reactivateSaved(user.id, body.reactivateId);
    return ok(c, { id: saved.id, status: saved.status });
  }
  if (body.shareToken) {
    const share = await loadLiveShare(body.shareToken);
    const saved = await saveManually(user.id, { source: "share", share, lastNoteId: body.lastNoteId });
    return ok(c, { id: saved.id, status: saved.status });
  }
  if (body.site) {
    const { ws, nb } = await loadLiveSite(body.site.wsSlug, body.site.nbSlug);
    const saved = await saveManually(user.id, { source: "site", notebook: nb, workspaceName: ws.name, lastNoteId: body.lastNoteId });
    return ok(c, { id: saved.id, status: saved.status });
  }
  throw fail("VALIDATION", "请指定分享链接或文档站");
});

shareRoutes.get("/me/saved-shares/:id/content", async (c) => {
  const user = await userRequired(c);
  return ok(c, await renderSavedContent(user.id, c.req.param("id"), c.req.query("noteId")));
});

shareRoutes.get("/me/saved-shares/:id/open", async (c) => {
  const user = await userRequired(c);
  const to = await openLocation(user.id, c.req.param("id"), c.req.query("noteId"));
  return c.redirect(to);
});

shareRoutes.get("/me/saved-shares/:id", async (c) => {
  const user = await userRequired(c);
  const { item } = await getSaved(user.id, c.req.param("id"));
  return ok(c, item);
});

shareRoutes.delete("/me/saved-shares/:id", async (c) => {
  const user = await userRequired(c);
  await dismissSaved(user.id, c.req.param("id"));
  return ok(c, {});
});
