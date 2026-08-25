import { Hono } from "hono";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { canEditNote, canReadNote, recencyBoost, scoreNote, tokenize, type WsRole } from "@kb/core";
import { fail, FOLDER_DEPTH_LIMIT, folderMoveExceedsDepth, nextSortKey } from "@kb/shared";
import { db } from "../db/client.ts";
import { attachments, auditLogs, folders, notebookMembers, notebooks, notes, noteVersions, users, workspaceMembers, workspaces } from "../db/schema.ts";
import { ok } from "../http.ts";
import { writeNoteFile } from "../lib/files.ts";
import { currentUser } from "../lib/session.ts";
import { memberRole } from "../lib/workspace.ts";
import { backlinksFor, rebuildLinks, snippetAround } from "../lib/links.ts";
import { assertUserStorage, textBytes } from "../lib/quota.ts";
import { noteAccess } from "../lib/note-access.ts";
import { notebookAccess } from "../lib/notebook-access.ts";
import { attachNoteModeration, instanceConfig, lastReviewedAt, moderationOn, queueReview, withdrawOpenReviews } from "../lib/moderation.ts";
import { notebookVisibleTo } from "../lib/notebook-access.ts";
import { moveNotebook } from "../lib/notebook-move.ts";
import { relocateNote } from "../lib/note-move.ts";
import { purgeFolder,purgeNotebook,purgeNotes,restoreFolder,restoreFolderId,restoreNotebook,restoreTitle,trashFolder,trashNotebook } from "../lib/trash.ts";

export const knowledge = new Hono();

async function requireUser(c: Parameters<typeof currentUser>[0]) {
  const user = await currentUser(c);
  if (!user) throw fail("UNAUTHENTICATED", "未登录");
  return user;
}

async function loadNotebook(notebookId: string) {
  const [nb] = await db.select().from(notebooks).where(eq(notebooks.id, notebookId));
  if (!nb || nb.trashedAt) throw fail("NOT_FOUND", "笔记本不存在");
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, nb.workspaceId));
  if (!ws) throw fail("NOT_FOUND", "工作区不存在");
  return { nb, ws };
}

/**
 * 目录必须属于目标笔记本。
 *
 * 建笔记的 folderId 和建/改目录的 parentId 以前完全不校验归属：
 * 笔记可以挂到别的笔记本（甚至别的工作区）的目录下。代码里那几处
 * `const seen = new Set()` 的环检测，就是在下游给这个洞打补丁。
 */
async function assertFolderInNotebook(folderId: string | null | undefined, notebookId: string) {
  if (!folderId) return;
  const [f] = await db.select({ notebookId: folders.notebookId, trashedAt: folders.trashedAt })
    .from(folders).where(eq(folders.id, folderId));
  if (!f || f.trashedAt || f.notebookId !== notebookId) throw fail("VALIDATION", "目录不属于这个笔记本");
}

/** 别让目录成为自己的后代——成环之后目录树遍历就没有终点了。 */
async function assertNoFolderCycle(folderId: string, nextParentId: string | null | undefined) {
  if (!nextParentId) return;
  if (nextParentId === folderId) throw fail("VALIDATION", "目录不能挂到自己下面");
  const all = await db.select({ id: folders.id, parentId: folders.parentId }).from(folders);
  const parentOf = new Map(all.map(f => [f.id, f.parentId]));
  const seen = new Set<string>([folderId]);
  for (let cur: string | null | undefined = nextParentId; cur; cur = parentOf.get(cur)) {
    if (seen.has(cur)) throw fail("VALIDATION", "这样会让目录成环");
    seen.add(cur);
  }
}

async function liveFoldersInNotebook(notebookId: string) {
  return db.select({ id: folders.id, title: folders.title, parentId: folders.parentId })
    .from(folders)
    .where(and(eq(folders.notebookId, notebookId), isNull(folders.trashedAt)));
}

/** 设计 03 §5.3：目录深度一期上限 8。 */
async function assertFolderDepth(notebookId: string, nextParentId: string | null | undefined, movingId?: string) {
  if (!nextParentId) return;
  const all = (await liveFoldersInNotebook(notebookId)).map(f => ({ ...f, parentId: f.parentId ?? null }));
  if (movingId) {
    if (folderMoveExceedsDepth(all, movingId, nextParentId)) throw fail("VALIDATION", `目录最多嵌套 ${FOLDER_DEPTH_LIMIT} 层`);
    return;
  }
  let depth = 0;
  const parentOf = new Map(all.map(f => [f.id, f.parentId]));
  const seen = new Set<string>();
  for (let cur: string | null | undefined = nextParentId; cur; cur = parentOf.get(cur)) {
    if (seen.has(cur)) throw fail("VALIDATION", "这样会让目录成环");
    seen.add(cur);
    depth++;
    if (depth >= FOLDER_DEPTH_LIMIT) throw fail("VALIDATION", `目录最多嵌套 ${FOLDER_DEPTH_LIMIT} 层`);
  }
}

knowledge.get("/workspaces", async (c) => {
  const user = await requireUser(c);
  const mine = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, user.id));
  const ids = mine.map((m) => m.workspaceId);
  if (!ids.length) return ok(c, { workspaces: [] });
  // 按 id 取，别把全实例的工作区都拉出来再 filter
  const list = await db.select().from(workspaces).where(inArray(workspaces.id, ids));
  return ok(c, {
    workspaces: list
      .map((w) => ({
        id: w.id,
        name: w.name,
        slug: w.slug,
        kind: w.kind,
        frozen: w.frozen,
        deletionScheduledAt: w.deletionScheduledAt,
        role: mine.find((m) => m.workspaceId === w.id)?.role,
      })),
  });
});

knowledge.get("/workspaces/:id/notebooks", async (c) => {
  const user = await requireUser(c);
  const id = c.req.param("id");
  const role = await memberRole(id, user.id);
  if (!role) throw fail("FORBIDDEN", "不是该工作区成员");
  // 按自定义顺序发出去，客户端还会再按用户选的排序模式排一遍；这里定一个稳定的底。
  const list = await db
    .select()
    .from(notebooks)
    .where(and(eq(notebooks.workspaceId, id), isNull(notebooks.trashedAt)))
    .orderBy(asc(notebooks.sortKey), asc(notebooks.createdAt));
  const visible=[];for(const nb of list){try{await notebookAccess(nb.id,user.id,"read");visible.push(nb);}catch{}}
  return ok(c, { notebooks: visible });
});

/**
 * 笔记本的自定义顺序。规则与上面那条「笔记顺序」完全一致：整串重写 `sort_key`，
 * 不做增量插值——插值省的那点写入换来的是「排久了 key 挤在一起要重排」的隐患。
 *
 * 权限按工作区算而不是按单个笔记本算：这是工作区侧栏的排列，不是某一本的内部事务。
 */
knowledge.patch("/workspaces/:id/notebooks/order", async (c) => {
  const user = await requireUser(c);
  const workspaceId = c.req.param("id");
  const role = await memberRole(workspaceId, user.id);
  if (!role) throw fail("FORBIDDEN", "不是该工作区成员");
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (ws?.frozen) throw fail("FORBIDDEN", "工作区已冻结，暂时只读");
  const body = z.object({ notebookIds: z.array(z.string().uuid()).min(1).max(500) }).parse(await c.req.json());
  if (new Set(body.notebookIds).size !== body.notebookIds.length) throw fail("VALIDATION", "笔记本顺序不能重复");
  const rows = await db
    .select({ id: notebooks.id })
    .from(notebooks)
    .where(and(eq(notebooks.workspaceId, workspaceId), isNull(notebooks.trashedAt), inArray(notebooks.id, body.notebookIds)));
  if (rows.length !== body.notebookIds.length) throw fail("VALIDATION", "只能排列当前工作区里的笔记本");
  await db.transaction(async (tx) => {
    for (let i = 0; i < body.notebookIds.length; i++) {
      await tx.update(notebooks).set({ sortKey: i }).where(eq(notebooks.id, body.notebookIds[i]!));
    }
  });
  return ok(c, { notebookIds: body.notebookIds });
});

knowledge.get("/notebooks/:id/tree", async (c) => {
  const user = await requireUser(c);
  const {notebook:nb}=await notebookAccess(c.req.param("id"),user.id,"read");
  const dirs = await db.select().from(folders).where(and(eq(folders.notebookId, nb.id), isNull(folders.trashedAt)));
  const ns = await db
    .select()
    .from(notes)
    .where(and(eq(notes.notebookId, nb.id), isNull(notes.trashedAt)))
    .orderBy(asc(notes.sortKey), desc(notes.createdAt));
  let canEdit = true;
  try { await notebookAccess(nb.id, user.id, "edit"); } catch { canEdit = false; }
  return ok(c, {
    folders: dirs,
    canEdit,
    notes: ns.map((n) => ({ id: n.id, title: n.title, folderId: n.folderId, sortKey: n.sortKey, createdAt: n.createdAt, updatedAt: n.updatedAt })),
  });
});

knowledge.patch("/notebooks/:id/notes/order", async (c) => {
  const user = await requireUser(c);
  const { notebook: nb } = await notebookAccess(c.req.param("id"), user.id, "edit");
  const body = z.object({ noteIds: z.array(z.string().uuid()).min(1).max(2000) }).parse(await c.req.json());
  if (new Set(body.noteIds).size !== body.noteIds.length) throw fail("VALIDATION", "笔记顺序不能重复");
  const rows = await db.select({ id: notes.id }).from(notes).where(and(eq(notes.notebookId, nb.id), isNull(notes.trashedAt), inArray(notes.id, body.noteIds)));
  if (rows.length !== body.noteIds.length) throw fail("VALIDATION", "只能排列当前笔记本里的笔记");
  await db.transaction(async (tx) => {
    for (let i = 0; i < body.noteIds.length; i++) {
      await tx.update(notes).set({ sortKey: i }).where(eq(notes.id, body.noteIds[i]!));
    }
  });
  return ok(c, { noteIds: body.noteIds });
});

/**
 * 目录的自定义顺序。规则与笔记完全一致：整串重写 `sort_key`。
 * 前端只传同级那一串；别的父目录下的 key 不动。
 */
knowledge.patch("/notebooks/:id/folders/order", async (c) => {
  const user = await requireUser(c);
  const { notebook: nb } = await notebookAccess(c.req.param("id"), user.id, "edit");
  const body = z.object({ folderIds: z.array(z.string().uuid()).min(1).max(2000) }).parse(await c.req.json());
  if (new Set(body.folderIds).size !== body.folderIds.length) throw fail("VALIDATION", "目录顺序不能重复");
  const rows = await db.select({ id: folders.id }).from(folders).where(and(eq(folders.notebookId, nb.id), isNull(folders.trashedAt), inArray(folders.id, body.folderIds)));
  if (rows.length !== body.folderIds.length) throw fail("VALIDATION", "只能排列当前笔记本里的目录");
  await db.transaction(async (tx) => {
    for (let i = 0; i < body.folderIds.length; i++) {
      await tx.update(folders).set({ sortKey: i }).where(eq(folders.id, body.folderIds[i]!));
    }
  });
  return ok(c, { folderIds: body.folderIds });
});

knowledge.post("/notes", async (c) => {
  const user = await requireUser(c);
  const body = z.object({ notebookId: z.string().uuid(), folderId: z.string().uuid().nullish(), title: z.string().min(1).max(200).optional() }).parse(await c.req.json());
  const {notebook:nb,workspace:ws}=await notebookAccess(body.notebookId,user.id,"edit");
  await assertFolderInNotebook(body.folderId, nb.id);
  const title = body.title?.trim() || "未命名";
  await assertUserStorage(user.id, textBytes(title, ""));
  const existing = await db.select({ sortKey: notes.sortKey }).from(notes).where(and(eq(notes.notebookId, nb.id), isNull(notes.trashedAt)));
  const [note] = await db
    .insert(notes)
    .values({
      workspaceId: ws.id,
      notebookId: nb.id,
      folderId: body.folderId ?? null,
      sortKey: nextSortKey(existing.map((n) => n.sortKey)),
      title,
      bodyMd: "",
      aiIndex: nb.defaultAiIndex,
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning();
  await db.insert(noteVersions).values({
    noteId: note.id,
    version: 1,
    title: note.title,
    bodyMd: "",
    editorId: user.id,
    source: "ui",
  });
  await writeNoteFile({ ...note, noteId: note.id });
  return ok(c, note, 201);
});

knowledge.get("/notes/:id", async (c) => {
  const user = await requireUser(c);
  const {note}=await noteAccess(c.req.param("id"),user.id,"read");
  let canEdit=true;try{await noteAccess(note.id,user.id,"edit");}catch{canEdit=false;}
  return ok(c, { ...await attachNoteModeration(note), canEdit });
});

/**
 * 「谁能一起编这篇」。协同没有开关，它跟着 ACL 走（设计 17 §3.4），
 * 所以前端要能把这份名单摊开给人看，否则「协同在哪分享」就永远是个谜。
 * 只回工作区内的人；对外只读分享是另一套，不在这里。
 */
knowledge.get("/notes/:id/collaborators", async (c) => {
  const user = await requireUser(c);
  const { note, workspace } = await noteAccess(c.req.param("id"), user.id, "read");
  const [notebook] = await db.select().from(notebooks).where(eq(notebooks.id, note.notebookId));
  if (!notebook) throw fail("NOT_FOUND", "笔记不存在");
  const team = await db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, note.workspaceId));
  const ids = team.map(m => m.userId);
  const people = ids.length ? await db.select({ id: users.id, displayName: users.displayName, handle: users.handle, status: users.status }).from(users).where(inArray(users.id, ids)) : [];
  const nbMembers = await db.select().from(notebookMembers).where(eq(notebookMembers.notebookId, notebook.id));
  const nbAcl = { id: notebook.id, workspaceId: notebook.workspaceId, visibility: notebook.visibility as "open" | "restricted" | "private", createdBy: notebook.createdBy, frozenWorkspace: workspace.frozen };
  const noteAcl = { id: note.id, workspaceId: note.workspaceId, notebookId: note.notebookId, trashed: !!note.trashedAt };

  const list = people.filter(u => u.status === "active").map(u => {
    const wsRole = (team.find(m => m.userId === u.id)?.role ?? null) as WsRole | null;
    const nbMemberRole = (nbMembers.find(m => m.userId === u.id)?.role as "edit" | "view" | undefined) ?? null;
    const ctx = { actor: { kind: "user" as const, userId: u.id }, note: noteAcl, notebook: nbAcl, wsRole, nbMemberRole, canSeeTrash: false };
    const can = canEditNote(ctx) ? "edit" as const : canReadNote(ctx) ? "read" as const : null;
    if (!can) return null;
    // 权限从哪来：非公开笔记本靠创建者身份或单独授权，公开笔记本就是工作区角色
    const via = notebook.visibility === "open" ? "workspace" as const
      : u.id === notebook.createdBy ? "owner" as const
      : nbMemberRole ? "notebook" as const : "workspace" as const;
    return { userId: u.id, displayName: u.displayName, handle: u.handle, wsRole, can, via, me: u.id === user.id };
  }).filter(Boolean);

  const myRole = team.find(m => m.userId === user.id)?.role ?? null;
  return ok(c, {
    people: list,
    workspaceId: note.workspaceId,
    workspaceKind: workspace.kind,
    frozen: workspace.frozen,
    notebookVisibility: notebook.visibility,
    canInvite: workspace.kind !== "personal" && (myRole === "owner" || myRole === "admin"),
  });
});

knowledge.patch("/notes/:id", async (c) => {
  const user = await requireUser(c);
  const body = z
    .object({
      expectedVersion: z.number().int(),
      bodyMd: z.string().optional(),
      title: z.string().min(1).max(200).optional(),
      published: z.boolean().optional(),
      aiIndex: z.boolean().optional(),
      tags: z.array(z.string().min(1).max(40)).max(30).optional(),
      force: z.boolean().optional(),
      source:z.enum(["ui","ai_accept"]).optional(),
    })
    .parse(await c.req.json());
  const {note}=await noteAccess(c.req.param("id"),user.id,"edit");
  const requestedTags = body.tags
    ? [...new Set(body.tags.map(t => t.trim()).filter(Boolean))]
    : (note.tags as string[]);
  const currentTags = note.tags as string[];
  const unchanged = (body.bodyMd ?? note.bodyMd) === note.bodyMd
    && (body.title ?? note.title) === note.title
    && (body.published ?? note.published) === note.published
    && (body.aiIndex ?? note.aiIndex) === note.aiIndex
    && requestedTags.length === currentTags.length
    && requestedTags.every((tag, index) => tag === currentTags[index]);
  // 协同房间可能已经把同一份正文落成更高版本。旧页面随后发来的手动保存若没有
  // 实际变化，应直接认当前版本，而不是把自己的上一轮保存误报成版本冲突。
  if (unchanged) {
    const dto = await attachNoteModeration(note);
    return ok(c, { ...dto, canEdit: true, moderation: { ...dto.moderation, submitted: false } });
  }
  if (note.version !== body.expectedVersion && !body.force) {
    throw fail("CONFLICT_VERSION", "笔记已有较新版本，请刷新后重试");
  }
  if (note.version !== body.expectedVersion && body.force) {
    const [already] = await db.select().from(noteVersions).where(and(eq(noteVersions.noteId, note.id), eq(noteVersions.version, note.version)));
    if (!already) await db.insert(noteVersions).values({ noteId: note.id, version: note.version, title: note.title, bodyMd: note.bodyMd, editorId: note.updatedBy, source: "ui" });
  }
  const nextTitle = body.title ?? note.title;
  const nextBody = body.bodyMd ?? note.bodyMd;
  await assertUserStorage(note.createdBy, textBytes(nextTitle, nextBody) - textBytes(note.title, note.bodyMd));
  // 公开文章的审核：翻成 published 时必审；已公开的文章改了正文也要重审，
  // 否则先发一篇干净的、再改成违规就绕过去了。但自动保存很密，同一篇 60 秒内只审一次。
  // 审是后台跑的：这里只把状态落成审核中，HTTP 马上成功返回。
  const settings = await instanceConfig();
  const nextPublished = body.published ?? note.published;
  const unpublish = body.published === false && note.published;
  const wantsPublish = body.published === true && (!note.published || note.moderationStatus === "rejected");
  const stillPublic = note.published && note.moderationStatus === "none" && nextPublished;
  const alreadyHeld = note.published && note.moderationStatus === "pending_review" && nextPublished;
  const contentChanged = nextTitle !== note.title || nextBody !== note.bodyMd;
  let shouldReview = false;
  if (moderationOn(settings, "article") && nextPublished && !unpublish) {
    if (wantsPublish) shouldReview = true;
    else if (stillPublic && contentChanged) {
      const last = await lastReviewedAt("note", note.id);
      if (!last || Date.now() - new Date(last).getTime() > 60000) shouldReview = true;
    } else if (alreadyHeld && contentChanged) shouldReview = true;
  }
  const next = {
    title: nextTitle,
    bodyMd: nextBody,
    published: nextPublished,
    moderationStatus: unpublish ? "none" : shouldReview ? "pending_review" : (note.moderationStatus ?? "none"),
    aiIndex: body.aiIndex ?? note.aiIndex,
    tags: requestedTags,
    version: note.version + 1,
    updatedBy: user.id,
    updatedAt: new Date(),
  };
  const [saved] = await db.update(notes).set(next).where(eq(notes.id, note.id)).returning();
  await db.insert(noteVersions).values({
    noteId: note.id,
    version: saved.version,
    title: saved.title,
    bodyMd: saved.bodyMd,
    editorId: user.id,
    source: body.source??"ui",
  });
  await writeNoteFile({ ...saved, noteId: saved.id });
  await rebuildLinks(saved.id, saved.workspaceId, saved.bodyMd);
  if (unpublish) await withdrawOpenReviews("note", saved.id);
  else if (shouldReview) await queueReview({ targetType: "note", targetId: saved.id, scope: "article", workspaceId: saved.workspaceId, authorUserId: user.id, snapshot: `${saved.title}\n\n${saved.bodyMd}` });
  // canEdit 必须跟着回：前端拿这份响应整个换掉手上的笔记对象，少一个字段就等于「这篇变只读了」
  // ——编辑器会锁上、协同房间会被拆掉，而且它的 save() 见 canEdit 假就直接 return，之后连保存都停了，
  // 只能刷新页面才好。走到这里 noteAccess(…, "edit") 已经过了，此刻就是能编的。
  const dto = await attachNoteModeration(saved);
  return ok(c, { ...dto, canEdit: true, moderation: { ...dto.moderation, submitted: wantsPublish || (stillPublic && shouldReview) } });
});

knowledge.post("/workspaces", async (c) => {
  const user = await requireUser(c);
  // allowUserCreateWorkspace 这个开关一直没人读：管理员在设置页关掉了，
  // 任何人照样能建工作区。实例管理员自己不受限。
  const settings = await instanceConfig();
  if (settings && !settings.allowUserCreateWorkspace && user.roleInstance !== "admin") {
    throw fail("FORBIDDEN", "管理员关闭了自行创建工作区");
  }
  const body = z.object({ name: z.string().min(1).max(40) }).parse(await c.req.json());
  const slug = `w-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const [ws] = await db.insert(workspaces).values({ name: body.name.trim(), slug, kind: "normal", ownerId: user.id }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: "owner" });
  const [nb] = await db.insert(notebooks).values({ workspaceId: ws.id, slug: "inbox", title: "收件箱", createdBy: user.id }).returning();
  return ok(c, { workspace: ws, notebook: nb }, 201);
});

knowledge.post("/workspaces/:id/notebooks", async (c) => {
  const user = await requireUser(c);
  const workspaceId = c.req.param("id");
  const role = await memberRole(workspaceId, user.id);
  if (role !== "owner" && role !== "admin") throw fail("FORBIDDEN", "只有管理员能创建笔记本");
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (ws?.frozen) throw fail("FORBIDDEN", "工作区已冻结，暂时只读");
  const body = z.object({ title: z.string().min(1).max(80), visibility: z.enum(["open", "private", "restricted"]).default("open") }).parse(await c.req.json());
  const slug = `nb-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  // 新本排在最后。不给的话所有本的 sort_key 都是 0，自定义排序等于没有起点。
  const keys = await db.select({ sortKey: notebooks.sortKey }).from(notebooks).where(and(eq(notebooks.workspaceId, workspaceId), isNull(notebooks.trashedAt)));
  const [nb] = await db.insert(notebooks).values({ workspaceId, slug, title: body.title.trim(), visibility: body.visibility, createdBy: user.id, sortKey: nextSortKey(keys.map(k => k.sortKey)) }).returning();
  return ok(c, nb, 201);
});

knowledge.patch("/notebooks/:id", async (c) => {
  const user = await requireUser(c);
  const { nb, ws } = await loadNotebook(c.req.param("id"));
  const role = await memberRole(ws.id, user.id);
  if (role !== "owner" && role !== "admin" && nb.createdBy !== user.id) throw fail("FORBIDDEN", "无权修改笔记本");
  const body = z.object({ title: z.string().min(1).max(80).optional(), defaultAiIndex: z.boolean().optional(), visibility:z.enum(["open","private","restricted"]).optional() }).parse(await c.req.json());
  const [saved] = await db.update(notebooks).set({ title: body.title ?? nb.title, defaultAiIndex: body.defaultAiIndex ?? nb.defaultAiIndex,visibility:body.visibility??nb.visibility }).where(eq(notebooks.id, nb.id)).returning();
  return ok(c, saved);
});

/**
 * 把整本笔记本搬到另一个工作区。
 *
 * 权限两头都要，而且都按「能不能建 / 能不能删这本」那条线走（owner / admin），
 * 不用笔记本创建者那条：搬走等于从原区拿掉一整块内容、又往目标区塞进一块，
 * 这是两个工作区的事，不是一本笔记本内部的事。
 */
knowledge.post("/notebooks/:id/move", async (c) => {
  const user = await requireUser(c);
  const { nb, ws } = await loadNotebook(c.req.param("id"));
  const body = z.object({ workspaceId: z.string().uuid() }).parse(await c.req.json());
  const from = await memberRole(ws.id, user.id);
  if (from !== "owner" && from !== "admin") throw fail("FORBIDDEN", "只有工作区管理员能移动笔记本");
  if (ws.frozen) throw fail("FORBIDDEN", "工作区已冻结，暂时只读");
  const to = await memberRole(body.workspaceId, user.id);
  if (to !== "owner" && to !== "admin") throw fail("FORBIDDEN", "只能移动到你管理的工作区");
  const [target] = await db.select().from(workspaces).where(eq(workspaces.id, body.workspaceId));
  if (!target) throw fail("NOT_FOUND", "目标工作区不存在");
  if (target.frozen) throw fail("FORBIDDEN", "目标工作区已冻结，暂时只读");
  const moved = await moveNotebook(nb.id, target.id, user.id);
  return ok(c, { ...moved.notebook, moved: { notes: moved.notes, droppedMembers: moved.droppedMembers, slugChanged: moved.slugChanged } });
});

knowledge.get("/notebooks/:id/members",async c=>{const user=await requireUser(c);const{nb,ws}=await loadNotebook(c.req.param("id"));const role=await memberRole(ws.id,user.id);if(role!=="owner"&&role!=="admin"&&nb.createdBy!==user.id)throw fail("FORBIDDEN","无权管理笔记本权限");const rows=await db.select().from(notebookMembers).where(eq(notebookMembers.notebookId,nb.id));return ok(c,{members:rows});});
knowledge.put("/notebooks/:id/members",async c=>{const user=await requireUser(c);const{nb,ws}=await loadNotebook(c.req.param("id"));const role=await memberRole(ws.id,user.id);if(role!=="owner"&&role!=="admin"&&nb.createdBy!==user.id)throw fail("FORBIDDEN","无权管理笔记本权限");if(ws.frozen)throw fail("FORBIDDEN","工作区已冻结");const body=z.object({members:z.array(z.object({userId:z.string().uuid(),role:z.enum(["view","edit"])})).max(500)}).parse(await c.req.json());const workspaceUsers=await db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId,ws.id));if(body.members.some(m=>!workspaceUsers.some(w=>w.userId===m.userId)))throw fail("VALIDATION","白名单成员必须先加入工作区");await db.transaction(async tx=>{await tx.delete(notebookMembers).where(eq(notebookMembers.notebookId,nb.id));if(body.members.length)await tx.insert(notebookMembers).values(body.members.filter(m=>m.userId!==nb.createdBy).map(m=>({notebookId:nb.id,userId:m.userId,role:m.role})));});return ok(c,{});});

knowledge.delete("/notebooks/:id", async (c) => {
  const user = await requireUser(c);
  const { nb, ws } = await loadNotebook(c.req.param("id"));
  const role = await memberRole(ws.id, user.id);
  if (role !== "owner" && role !== "admin") throw fail("FORBIDDEN", "无权删除笔记本");
  if (ws.frozen) throw fail("FORBIDDEN", "工作区已冻结，暂时只读");
  await trashNotebook(nb.id,user.id);
  return ok(c, {});
});

knowledge.post("/notes/:id/move", async (c) => {
  const user = await requireUser(c);
  const body = z.object({
    notebookId: z.string().uuid().optional(),
    folderId: z.string().uuid().nullable().optional(),
  }).parse(await c.req.json());
  const { note } = await noteAccess(c.req.param("id"), user.id, "edit");
  const targetId = body.notebookId ?? note.notebookId;
  const { notebook: nb } = await notebookAccess(targetId, user.id, "edit");
  // 换本时旧目录不属于目标本，没指定 folderId 就落到目标本根上。
  const folderId = body.folderId === undefined
    ? (targetId === note.notebookId ? (note.folderId ?? null) : null)
    : body.folderId;
  const moved = await relocateNote({ note, targetNotebook: nb, folderId, actorId: user.id });
  return ok(c, moved);
});

knowledge.post("/folders", async (c) => {
  const user = await requireUser(c);
  const body = z.object({ notebookId: z.string().uuid(), parentId: z.string().uuid().nullable().optional(), title: z.string().min(1).max(100) }).parse(await c.req.json());
  const {notebook:nb,workspace:ws}=await notebookAccess(body.notebookId,user.id,"edit");
  await assertFolderInNotebook(body.parentId, nb.id);
  await assertFolderDepth(nb.id, body.parentId ?? null);
  const parentId = body.parentId ?? null;
  const siblingKeys = await db.select({ sortKey: folders.sortKey }).from(folders).where(and(
    eq(folders.notebookId, nb.id),
    isNull(folders.trashedAt),
    parentId ? eq(folders.parentId, parentId) : isNull(folders.parentId),
  ));
  const [folder] = await db.insert(folders).values({
    workspaceId: ws.id,
    notebookId: nb.id,
    parentId,
    title: body.title.trim(),
    sortKey: nextSortKey(siblingKeys.map((s) => s.sortKey)),
  }).returning();
  return ok(c, folder, 201);
});

knowledge.patch("/folders/:id", async (c) => {
  const user = await requireUser(c);
  const [folder] = await db.select().from(folders).where(eq(folders.id, c.req.param("id")));
  if (!folder || folder.trashedAt) throw fail("NOT_FOUND", "目录不存在");
  await notebookAccess(folder.notebookId,user.id,"edit");
  const body = z.object({ title: z.string().min(1).max(100).optional(), parentId: z.string().uuid().nullable().optional() }).parse(await c.req.json());
  if (body.parentId !== undefined) {
    await assertFolderInNotebook(body.parentId, folder.notebookId);
    await assertNoFolderCycle(folder.id, body.parentId);
    await assertFolderDepth(folder.notebookId, body.parentId, folder.id);
  }
  const nextParent = body.parentId === undefined ? folder.parentId : body.parentId;
  const parentChanged = (nextParent ?? null) !== (folder.parentId ?? null);
  let sortKey = folder.sortKey;
  if (parentChanged) {
    const siblingKeys = await db.select({ sortKey: folders.sortKey }).from(folders).where(and(
      eq(folders.notebookId, folder.notebookId),
      isNull(folders.trashedAt),
      nextParent ? eq(folders.parentId, nextParent) : isNull(folders.parentId),
    ));
    sortKey = nextSortKey(siblingKeys.map((s) => s.sortKey));
  }
  const [saved] = await db.update(folders).set({
    title: body.title ?? folder.title,
    parentId: nextParent,
    sortKey,
  }).where(eq(folders.id, folder.id)).returning();
  return ok(c, saved);
});

knowledge.delete("/folders/:id", async (c) => {
  const user = await requireUser(c);
  const [folder] = await db.select().from(folders).where(eq(folders.id, c.req.param("id")));
  if (!folder || folder.trashedAt) throw fail("NOT_FOUND", "目录不存在");
  await notebookAccess(folder.notebookId,user.id,"edit");
  await trashFolder(folder.id,user.id);
  return ok(c, {});
});

knowledge.delete("/notes/:id", async (c) => {
  const user = await requireUser(c);
  const {note}=await noteAccess(c.req.param("id"),user.id,"edit");
  await db.update(notes).set({ trashedAt: new Date(),trashedBy:user.id,trashBatchId:crypto.randomUUID() }).where(eq(notes.id, note.id));
  return ok(c, {});
});

knowledge.get("/notes/:id/versions", async (c) => {
  const user = await requireUser(c); const {note}=await noteAccess(c.req.param("id"),user.id,"read"); const [{ value: total }] = await db.select({ value: count() }).from(noteVersions).where(eq(noteVersions.noteId, note.id));
  const rows = await db.select().from(noteVersions).where(eq(noteVersions.noteId, note.id)).orderBy(desc(noteVersions.version)).limit(100);
  return ok(c, { total, versions: rows.map(v => ({ id: v.id, version: v.version, title: v.title, bodyMd: v.bodyMd, source: v.source, createdAt: v.createdAt })) });
});
knowledge.post("/notes/:id/versions/:version/restore", async (c) => {
  const user=await requireUser(c);const {note}=await noteAccess(c.req.param("id"),user.id,"edit");const version=Number(c.req.param("version"));const [old]=await db.select().from(noteVersions).where(and(eq(noteVersions.noteId,note.id),eq(noteVersions.version,version)));if(!old)throw fail("NOT_FOUND","版本不存在");await assertUserStorage(note.createdBy,textBytes(old.title,old.bodyMd)-textBytes(note.title,note.bodyMd));const [saved]=await db.update(notes).set({title:old.title,bodyMd:old.bodyMd,version:note.version+1,updatedBy:user.id,updatedAt:new Date()}).where(eq(notes.id,note.id)).returning();await db.insert(noteVersions).values({noteId:note.id,version:saved.version,title:saved.title,bodyMd:saved.bodyMd,editorId:user.id,source:"restore"});await writeNoteFile({...saved,noteId:saved.id});await rebuildLinks(saved.id,saved.workspaceId,saved.bodyMd);return ok(c,saved);
});

knowledge.get("/notes/:id/backlinks", async (c) => {
  const user = await requireUser(c);
  const [note] = await db.select().from(notes).where(eq(notes.id, c.req.param("id")));
  if (!note || note.trashedAt) throw fail("NOT_FOUND", "笔记不存在");
  await noteAccess(note.id,user.id,"read");
  const rows = await backlinksFor(note.id);const visible=[];for(const r of rows){try{await noteAccess(r.id,user.id,"read");visible.push({id:r.id,title:r.title,snippet:snippetAround(r.bodyMd,r.raw)});}catch{}}
  return ok(c, { items: visible });
});

knowledge.get("/search", async (c) => {
  const user = await requireUser(c);
  const q = (c.req.query("q") ?? "").trim().slice(0, 200);
  if (!q) return ok(c, { hits: [], total: 0 });
  const workspaceId = c.req.query("workspaceId"), notebookId = c.req.query("notebookId"), tag = c.req.query("tag");
  const titleOnly = c.req.query("titleOnly") === "1";
  const aiIndex = c.req.query("aiIndex");                       // "1" 只看进大脑的，"0" 只看没进的
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  const memberships = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, user.id));
  const ids = workspaceId ? [workspaceId] : memberships.map(m => m.workspaceId);
  if (workspaceId && !memberships.some(m => m.workspaceId === workspaceId)) throw fail("FORBIDDEN", "不是工作区成员");
  const parts = tokenize(q);
  const scored = [];
  for (const id of ids) {
    const where = [eq(notes.workspaceId, id), isNull(notes.trashedAt)];
    if (notebookId) where.push(eq(notes.notebookId, notebookId));
    if (aiIndex === "1" || aiIndex === "0") where.push(eq(notes.aiIndex, aiIndex === "1"));
    const rows = await db.select().from(notes).where(and(...where));
    // PDF 抽出来的文本也算正文，附件里的内容才搜得到（规格 06 的 4.3）
    const pdfText = new Map<string, string>();
    if (!titleOnly && rows.length) {
      const files = await db.select({ noteId: attachments.noteId, text: attachments.extractedText }).from(attachments)
        .where(and(eq(attachments.workspaceId, id), eq(attachments.extractStatus, "ok"), isNull(attachments.trashedAt)));
      for (const f of files) if (f.text) pdfText.set(f.noteId, `${pdfText.get(f.noteId) ?? ""}\n${f.text}`);
    }
    for (const n of rows) {
      const tags = ((n.tags as string[]) ?? []);
      if (tag && !tags.some(t => t.toLowerCase() === tag.toLowerCase())) continue;
      const base = scoreNote(parts, { title: n.title, tags, body: titleOnly ? "" : n.bodyMd + (pdfText.get(n.id) ?? "") });
      if (!base) continue;
      const body = n.bodyMd.toLowerCase();
      const needle = parts.map(p => p.raw).concat(parts.flatMap(p => p.grams)).find(t => body.includes(t)) ?? "";
      const at = needle ? body.indexOf(needle) : -1;
      scored.push({ note: n, score: base + recencyBoost(n.updatedAt), snippet: at >= 0 ? n.bodyMd.slice(Math.max(0, at - 60), at + 180) : n.bodyMd.slice(0, 180) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  // ACL 要逐条过，但没必要把全部命中都过一遍：只要凑够「这一页 + 1」就能判断
  // 还有没有下一页。以前是先 break 再算 total，于是 total 恒等于被截断后的条数、
  // hasMore 在最后一页也恒为 true，前端拿到的分页信息一直是错的。
  const want = offset + limit;
  const page = [];
  let allowed = 0;
  let more = false;
  for (const s of scored) {
    let visible = true;
    try { await noteAccess(s.note.id, user.id, "read"); } catch { visible = false; }
    if (!visible) continue;
    allowed++;
    if (allowed > want) { more = true; break; }
    if (allowed > offset) {
      page.push({ id: s.note.id, title: s.note.title, snippet: s.snippet, notebookId: s.note.notebookId, workspaceId: s.note.workspaceId, tags: s.note.tags, score: Math.round(s.score * 100) / 100 });
    }
  }
  const received = [];
  if (!notebookId && !tag && aiIndex == null) {
    const { searchSavedTitles } = await import("../lib/saved-shares.ts");
    received.push(...(await searchSavedTitles(user.id, q, 8)).map(r => ({
      id: r.id, title: r.title, snippet: r.snippet, notebookId: "", workspaceId: "", kind: "saved_share" as const,
    })));
  }
  return ok(c, { hits: [...page, ...received], total: allowed + received.length, hasMore: more });
});

/**
 * 回收站的可见范围。
 *
 * 两道关，缺一不可：
 *  1. 工作区角色 —— owner/admin 看全区，其余人只看自己删的（原有逻辑）；
 *  2. 笔记本可见性 —— 私密 / 受限笔记本里的东西，不该因为「进了回收站」
 *     就对工作区管理员敞开。以前这里只有第 1 道，于是管理员能看到别人私密本
 *     里被删笔记的标题和完整路径，还能恢复、甚至永久销毁它。
 */
async function trashScope(workspaceId: string, userId: string) {
  const role = await memberRole(workspaceId, userId);
  if (!role) throw fail("FORBIDDEN", "不是工作区成员");
  const allNotebooks = await db.select().from(notebooks).where(eq(notebooks.workspaceId, workspaceId));
  const myNbRoles = await db.select({ notebookId: notebookMembers.notebookId, role: notebookMembers.role })
    .from(notebookMembers).where(eq(notebookMembers.userId, userId));
  const roleOf = new Map(myNbRoles.map(m => [m.notebookId, m.role as "edit" | "view"]));
  const visibleNotebook = (id: string) => {
    const nb = allNotebooks.find(x => x.id === id);
    return !!nb && notebookVisibleTo(nb, userId, roleOf.get(id) ?? null);
  };
  return { role, canAll: role === "owner" || role === "admin", allNotebooks, visibleNotebook };
}

knowledge.get("/workspaces/:id/trash", async (c) => {
  const user = await requireUser(c);
  const workspaceId = c.req.param("id");
  const { canAll, allNotebooks, visibleNotebook } = await trashScope(workspaceId, user.id);

  const allNotes = await db.select().from(notes).where(and(eq(notes.workspaceId, workspaceId), isNotNull(notes.trashedAt)));
  const allFolders = await db.select().from(folders).where(and(eq(folders.workspaceId, workspaceId), isNotNull(folders.trashedAt)));
  const mineOnly = <T extends { trashedBy: string | null }>(rows: T[]) => rows.filter(x => canAll || x.trashedBy === user.id);

  const visibleNotes = mineOnly(allNotes).filter(n => visibleNotebook(n.notebookId));
  const visibleFolders = mineOnly(allFolders).filter(f => visibleNotebook(f.notebookId));
  const visibleNotebooks = mineOnly(allNotebooks.filter(n => n.trashedAt)).filter(n => visibleNotebook(n.id));

  const actorIds = [...new Set([...visibleNotes, ...visibleFolders, ...visibleNotebooks].map(x => x.trashedBy).filter((x): x is string => !!x))];
  const people = actorIds.length ? await db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, actorIds)) : [];
  const who = (id: string | null) => people.find(p => p.id === id)?.displayName ?? "已注销用户";
  const nbTitle = (id: string) => allNotebooks.find(x => x.id === id)?.title ?? "已销毁的笔记本";
  const path = (n: typeof allNotes[number]) => {
    const parts = [nbTitle(n.notebookId)];
    let cur = n.folderId ? allFolders.find(f => f.id === n.folderId) : undefined;
    const guard = new Set<string>();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      parts.splice(1, 0, cur.title);
      cur = cur.parentId ? allFolders.find(f => f.id === cur!.parentId) : undefined;
    }
    return parts.join(" / ");
  };
  const meta = (x: { trashedAt: Date | null; trashedBy: string | null }) => ({
    trashedAt: x.trashedAt,
    trashedBy: x.trashedBy,
    trashedByName: who(x.trashedBy),
    purgeAt: x.trashedAt ? new Date(x.trashedAt.getTime() + 30 * 86400000) : null,
  });
  return ok(c, {
    notes: visibleNotes.map(n => ({ id: n.id, title: n.title, path: path(n), ...meta(n) })),
    folders: visibleFolders.map(f => ({ id: f.id, title: f.title, path: nbTitle(f.notebookId), ...meta(f) })),
    notebooks: visibleNotebooks.map(n => ({ id: n.id, title: n.title, path: "整本", ...meta(n) })),
  });
});

/** 恢复 / 销毁的共同前置：工作区角色 + 笔记本可见性 + 「只能动自己删的」。 */
async function trashTarget(
  c: Parameters<typeof requireUser>[0],
  row: { workspaceId: string; trashedAt: Date | null; trashedBy: string | null },
  notebookId: string,
  action: string,
) {
  const user = await requireUser(c);
  if (!row.trashedAt) throw fail("NOT_FOUND", "回收站里没有这一项");
  const { role, canAll, visibleNotebook } = await trashScope(row.workspaceId, user.id);
  if (role === "viewer") throw fail("FORBIDDEN", `无权${action}`);
  if (!visibleNotebook(notebookId)) throw fail("NOT_FOUND", "回收站里没有这一项");
  if (!canAll && row.trashedBy !== user.id) throw fail("FORBIDDEN", `只能${action}自己删除的内容`);
  return user;
}

knowledge.post("/trash/note/:id/restore", async (c) => {
  const [note] = await db.select().from(notes).where(eq(notes.id, c.req.param("id")));
  if (!note) throw fail("NOT_FOUND", "回收站中没有这篇笔记");
  const user = await trashTarget(c, note, note.notebookId, "恢复");
  await assertUserStorage(note.createdBy, textBytes(note.title, note.bodyMd));
  const title = await restoreTitle(note), folderId = await restoreFolderId(note);
  await db.update(notes).set({ trashedAt: null, trashedBy: null, trashBatchId: null, title, folderId }).where(eq(notes.id, note.id));
  await rebuildLinks(note.id, note.workspaceId, note.bodyMd);
  void user;
  return ok(c, { title, folderId, renamed: title !== note.title, movedToRoot: !!note.folderId && !folderId });
});

knowledge.post("/trash/folder/:id/restore", async (c) => {
  const [f] = await db.select().from(folders).where(eq(folders.id, c.req.param("id")));
  if (!f?.trashedAt || !f.trashBatchId) throw fail("NOT_FOUND", "回收站中没有此目录");
  await trashTarget(c, f, f.notebookId, "恢复");
  const affected = await db.select().from(notes).where(eq(notes.trashBatchId, f.trashBatchId));
  for (const n of affected) await assertUserStorage(n.createdBy, textBytes(n.title, n.bodyMd));
  await restoreFolder(f.id, f.trashBatchId);
  for (const n of affected) await rebuildLinks(n.id, n.workspaceId, n.bodyMd);
  return ok(c, {});
});

knowledge.post("/trash/notebook/:id/restore", async (c) => {
  const user = await requireUser(c);
  const [nb] = await db.select().from(notebooks).where(eq(notebooks.id, c.req.param("id")));
  if (!nb?.trashedAt || !nb.trashBatchId) throw fail("NOT_FOUND", "回收站中没有此笔记本");
  const { canAll, visibleNotebook } = await trashScope(nb.workspaceId, user.id);
  if (!visibleNotebook(nb.id)) throw fail("NOT_FOUND", "回收站中没有此笔记本");
  if (!canAll) throw fail("FORBIDDEN", "只有管理员能恢复笔记本");
  const affected = await db.select().from(notes).where(eq(notes.trashBatchId, nb.trashBatchId));
  for (const n of affected) await assertUserStorage(n.createdBy, textBytes(n.title, n.bodyMd));
  await restoreNotebook(nb.id, nb.trashBatchId);
  for (const n of affected) await rebuildLinks(n.id, n.workspaceId, n.bodyMd);
  return ok(c, {});
});

async function purgeTarget(c: Parameters<typeof requireUser>[0], kind: "note" | "folder" | "notebook") {
  const id = c.req.param("id") ?? "";
  const [row] = kind === "note"
    ? await db.select().from(notes).where(eq(notes.id, id))
    : kind === "folder"
      ? await db.select().from(folders).where(eq(folders.id, id))
      : await db.select().from(notebooks).where(eq(notebooks.id, id));
  if (!row || !row.trashedAt) throw fail("NOT_FOUND", "回收站里没有这一项");
  const notebookId = kind === "notebook" ? row.id : (row as { notebookId: string }).notebookId;
  const user = await trashTarget(c, row, notebookId, "销毁");
  if (kind === "note") await purgeNotes([id]);
  else if (kind === "folder") await purgeFolder(id);
  else await purgeNotebook(id);
  await db.insert(auditLogs).values({ userId: user.id, workspaceId: row.workspaceId, actorType: "user", action: `${kind}.purge`, result: "ok", targetType: kind, targetId: id });
  return ok(c, {});
}

knowledge.delete("/trash/note/:id",c=>purgeTarget(c,"note"));
knowledge.delete("/trash/folder/:id",c=>purgeTarget(c,"folder"));
knowledge.delete("/trash/notebook/:id",c=>purgeTarget(c,"notebook"));
