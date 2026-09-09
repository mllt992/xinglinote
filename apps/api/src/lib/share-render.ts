import { and, eq, isNull } from "drizzle-orm";
import { buildNoteTree, fail, type NoteTreeNode } from "@kb/shared";
import { sliceHeadingSection, slugifyHeading } from "@kb/shared/markdown";
import { db } from "../db/client.ts";
import { attachments, folders, notebooks, notes, shareLinks, users, workspaces } from "../db/schema.ts";
import { folderSubtree, notebookSubtree } from "./share-target.ts";

export const GONE_SHARE = "分享不存在或已失效";
export const GONE_SITE = "站点不存在";
export const goneShare = () => fail("NOT_FOUND", GONE_SHARE);
export const goneSite = () => fail("NOT_FOUND", GONE_SITE);

export function shareEffective(s: typeof shareLinks.$inferSelect) {
  return s.status === "active" && (!s.expiresAt || s.expiresAt.getTime() > Date.now());
}

/** 标题锚点：和前端渲染用的一套规则，中文直接保留。 */
export const headingSlug = slugifyHeading;

/** 兼容统一标题解析上线前已经生成的分享链接。 */
function sliceLegacyHeading(body: string, anchor: string) {
  const lines = body.split("\n");
  const legacySlug = (text: string) => text.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "");
  const start = lines.findIndex(line => /^#{1,6}\s/.test(line) && legacySlug(line.replace(/^#+\s*/, "")) === anchor);
  if (start < 0) return null;
  const level = lines[start].match(/^#+/)![0].length;
  const next = lines.slice(start + 1).findIndex(line => {
    const match = line.match(/^(#{1,6})\s/);
    return !!match && match[1].length <= level;
  });
  const end = next < 0 ? lines.length : start + 1 + next;
  return lines.slice(start, end).join("\n").trim();
}

/** 单节分享只给这一节：从该标题起，到下一个同级或更高级标题为止。 */
export function sliceHeading(body: string, anchor: string) {
  return sliceHeadingSection(body, anchor) ?? sliceLegacyHeading(body, anchor);
}

export function treePayload(
  title: string,
  dirs: Array<{ id: string; title: string; parentId: string | null }>,
  noteRows: Array<{ id: string; title: string; folderId: string | null; bodyMd: string; updatedAt: Date }>,
  wanted: string | undefined,
) {
  const current = wanted ? noteRows.find(n => n.id === wanted) : noteRows[0];
  if (wanted && !current) return null;
  return {
    title,
    folders: dirs.map(f => ({ id: f.id, title: f.title, parentId: f.parentId })),
    notes: noteRows.map(n => ({ id: n.id, title: n.title, folderId: n.folderId })),
    noteId: current?.id ?? null,
    noteTitle: current?.title ?? null,
    bodyMd: current?.bodyMd ?? "",
    updatedAt: current?.updatedAt ?? null,
  };
}

export async function loadLiveShare(token: string) {
  const [share] = await db.select().from(shareLinks).where(eq(shareLinks.token, token));
  if (!share || !shareEffective(share)) throw goneShare();
  return share;
}

export async function shareChannelTitle(share: typeof shareLinks.$inferSelect): Promise<string> {
  if (share.targetType === "attachment") {
    const [file] = await db.select({ filename: attachments.filename }).from(attachments).where(eq(attachments.id, share.targetId));
    return file?.filename ?? "附件";
  }
  if (share.targetType === "folder") {
    const [folder] = await db.select({ title: folders.title }).from(folders).where(eq(folders.id, share.targetId));
    return folder?.title ?? "目录";
  }
  if (share.targetType === "notebook") {
    const [nb] = await db.select({ title: notebooks.title }).from(notebooks).where(eq(notebooks.id, share.targetId));
    return nb?.title ?? "笔记本";
  }
  const [note] = await db.select({ title: notes.title }).from(notes).where(eq(notes.id, share.targetId));
  return share.targetType === "heading" && note ? `${note.title} · 节选` : (note?.title ?? "笔记");
}

export async function shareAuthorName(share: typeof shareLinks.$inferSelect): Promise<string> {
  const [author] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, share.createdBy));
  return author?.displayName ?? "";
}

export async function shareTargetLive(share: typeof shareLinks.$inferSelect): Promise<boolean> {
  if (!shareEffective(share)) return false;
  if (share.targetType === "attachment") {
    const [file] = await db.select({ trashedAt: attachments.trashedAt, noteId: attachments.noteId }).from(attachments).where(eq(attachments.id, share.targetId));
    if (!file || file.trashedAt) return false;
    const [note] = await db.select({ trashedAt: notes.trashedAt }).from(notes).where(eq(notes.id, file.noteId));
    return !!note && !note.trashedAt;
  }
  if (share.targetType === "folder") {
    const [folder] = await db.select({ trashedAt: folders.trashedAt }).from(folders).where(eq(folders.id, share.targetId));
    return !!folder && !folder.trashedAt;
  }
  if (share.targetType === "notebook") {
    const [nb] = await db.select({ trashedAt: notebooks.trashedAt }).from(notebooks).where(eq(notebooks.id, share.targetId));
    return !!nb && !nb.trashedAt;
  }
  const [note] = await db.select({ trashedAt: notes.trashedAt }).from(notes).where(eq(notes.id, share.targetId));
  return !!note && !note.trashedAt;
}

export async function renderShare(share: typeof shareLinks.$inferSelect, noteId?: string) {
  const common = {
    requiresPassword: false,
    type: share.targetType,
    shareToken: share.token,
    commentsEnabled: share.commentsEnabled,
    correctionsEnabled: share.correctionsEnabled,
    showBacklinks: share.showBacklinks,
  };

  if (share.targetType === "attachment") {
    const [file] = await db.select().from(attachments).where(eq(attachments.id, share.targetId));
    if (!file || file.trashedAt) throw goneShare();
    const [note] = await db.select().from(notes).where(eq(notes.id, file.noteId));
    if (!note || note.trashedAt) throw goneShare();
    return {
      ...common,
      title: file.filename,
      attachment: { filename: file.filename, mime: file.mime, bytes: file.bytes, url: `/api/v1/public/shares/${share.token}/file` },
    };
  }

  if (share.targetType === "folder" || share.targetType === "notebook") {
    const tree = share.targetType === "folder" ? await folderSubtree(share.targetId) : await notebookSubtree(share.targetId);
    if (!tree) throw goneShare();
    const payload = treePayload(tree.root.title, tree.folders, tree.notes, noteId);
    if (!payload) throw goneShare();
    return { ...common, ...payload };
  }

  const [note] = await db.select().from(notes).where(eq(notes.id, share.targetId));
  if (!note || note.trashedAt) throw goneShare();
  const [nb] = await db.select().from(notebooks).where(eq(notebooks.id, note.notebookId));
  const bodyMd = share.targetType === "heading" ? sliceHeading(note.bodyMd, share.headingAnchor ?? "") : note.bodyMd;
  if (bodyMd === null) throw goneShare();
  return {
    ...common,
    noteId: note.id,
    title: share.targetType === "heading" ? `${note.title} · 节选` : note.title,
    bodyMd,
    updatedAt: note.updatedAt,
    notebookTitle: nb?.title ?? "笔记",
  };
}

export async function loadLiveSite(wsSlug: string, nbSlug: string) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, wsSlug));
  if (!ws) throw goneSite();
  const [nb] = await db.select().from(notebooks).where(and(eq(notebooks.workspaceId, ws.id), eq(notebooks.slug, nbSlug)));
  if (!nb?.sitePublished || nb.trashedAt) throw goneSite();
  return { ws, nb };
}

async function listSiteNotes(notebookId: string) {
  return db.select().from(notes).where(and(
    eq(notes.notebookId, notebookId),
    eq(notes.published, true),
    eq(notes.moderationStatus, "none"),
    isNull(notes.trashedAt),
  ));
}

export async function renderSite(ws: { name: string }, nb: typeof notebooks.$inferSelect) {
  let list = await listSiteNotes(nb.id);
  // issue #38：整本已上线但笔记仍默认 published=false → 空壳站。首次打开时补齐。
  if (!list.length) {
    const { seedSiteNotesIfEmpty } = await import("./site-publish.ts");
    await seedSiteNotesIfEmpty({ notebookId: nb.id, workspaceId: nb.workspaceId, actorUserId: nb.createdBy });
    list = await listSiteNotes(nb.id);
  }
  const allFolders = await db.select().from(folders).where(and(
    eq(folders.notebookId, nb.id),
    isNull(folders.trashedAt),
  ));

  // 公开站点只暴露公开页面所在的目录链，不能让空目录泄露尚未发布的内容结构。
  const folderById = new Map(allFolders.map(folder => [folder.id, folder]));
  const visibleFolderIds = new Set<string>();
  for (const note of list) {
    const trail = new Set<string>();
    for (let folderId = note.folderId; folderId && !trail.has(folderId);) {
      trail.add(folderId);
      const folder = folderById.get(folderId);
      if (!folder) break;
      visibleFolderIds.add(folder.id);
      folderId = folder.parentId;
    }
  }
  const visibleFolders = allFolders.filter(folder => visibleFolderIds.has(folder.id));
  const knownFolders = new Set(visibleFolders.map(folder => folder.id));
  const publicNotes = list.map(note => ({
    ...note,
    folderId: note.folderId && knownFolders.has(note.folderId) ? note.folderId : null,
  }));

  // 和编辑区的“自定义顺序”使用同一棵树，并让站点首页打开树中的第一篇。
  const tree = buildNoteTree(visibleFolders, publicNotes, "custom");
  const orderedIds: string[] = [];
  const collect = (nodes: NoteTreeNode[]) => {
    for (const node of nodes) {
      if (node.kind === "note") orderedIds.push(node.id);
      else collect(node.children);
    }
  };
  collect(tree);
  const noteById = new Map(publicNotes.map(note => [note.id, note]));
  const orderedNotes = orderedIds.map(id => noteById.get(id)).filter((note): note is typeof publicNotes[number] => !!note);
  return {
    workspace: ws.name,
    notebook: nb.title,
    notebookId: nb.id,
    accent: nb.siteAccent,
    folders: visibleFolders.map(folder => ({
      id: folder.id,
      title: folder.title,
      parentId: folder.parentId && knownFolders.has(folder.parentId) ? folder.parentId : null,
      sortKey: folder.sortKey,
    })),
    notes: orderedNotes.map(note => ({
      id: note.id,
      title: note.title,
      bodyMd: note.bodyMd,
      updatedAt: note.updatedAt,
      createdAt: note.createdAt,
      folderId: note.folderId,
      sortKey: note.sortKey,
    })),
  };
}

export async function siteLive(notebookId: string) {
  const [nb] = await db.select({ sitePublished: notebooks.sitePublished, trashedAt: notebooks.trashedAt, title: notebooks.title }).from(notebooks).where(eq(notebooks.id, notebookId));
  return !!nb && nb.sitePublished && !nb.trashedAt;
}

export async function siteOpenPath(notebookId: string, noteId?: string | null) {
  const [nb] = await db.select({ slug: notebooks.slug, workspaceId: notebooks.workspaceId, sitePublished: notebooks.sitePublished, trashedAt: notebooks.trashedAt }).from(notebooks).where(eq(notebooks.id, notebookId));
  if (!nb?.sitePublished || nb.trashedAt) throw goneShare();
  const [ws] = await db.select({ slug: workspaces.slug }).from(workspaces).where(eq(workspaces.id, nb.workspaceId));
  if (!ws) throw goneShare();
  return noteId ? `/s/${ws.slug}/${nb.slug}/${noteId}` : `/s/${ws.slug}/${nb.slug}`;
}
