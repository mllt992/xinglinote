import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { db } from "../db/client.ts";
import { folders, notebooks, notes, shareLinks, workspaces } from "../db/schema.ts";

export type PublicWikiBook = {
  id: string;
  title: string;
  workspace: string;
  url: string;
  noteCount: number;
  updatedAt: Date;
  accent: string | null;
  kind: "folder" | "notebook";
};

function folderIdsInTree(rootId: string, dirs: Array<{ id: string; parentId: string | null }>) {
  const ids = new Set([rootId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of dirs) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true; }
  }
  return ids;
}

function latest(dates: Array<Date | null | undefined>, fallback: Date) {
  return dates.reduce<Date>((acc, d) => d && d.getTime() > acc.getTime() ? d : acc, fallback);
}

/** 勾选收录、无密码、仍有效的目录 / 整本分享。已发布成文档站的本不再占一行。 */
export async function listPublicWikiBooks(): Promise<PublicWikiBook[]> {
  const now = new Date();
  const rows = await db.select().from(shareLinks).where(and(
    inArray(shareLinks.targetType, ["folder", "notebook"]),
    eq(shareLinks.status, "active"),
    eq(shareLinks.allowRobots, true),
    isNull(shareLinks.passwordHash),
    or(isNull(shareLinks.expiresAt), gt(shareLinks.expiresAt, now)),
  )).orderBy(desc(shareLinks.createdAt));
  const seen = new Set<string>();
  const unique = rows.filter(s => {
    const key = `${s.targetType}:${s.targetId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!unique.length) return [];

  const folderIds = unique.filter(s => s.targetType === "folder").map(s => s.targetId);
  const notebookIds = unique.filter(s => s.targetType === "notebook").map(s => s.targetId);
  const [folderRows, notebookRows] = await Promise.all([
    folderIds.length
      ? db.select({ id: folders.id, title: folders.title, workspaceId: folders.workspaceId, notebookId: folders.notebookId, trashedAt: folders.trashedAt }).from(folders).where(inArray(folders.id, folderIds))
      : Promise.resolve([]),
    notebookIds.length
      ? db.select({ id: notebooks.id, title: notebooks.title, workspaceId: notebooks.workspaceId, sitePublished: notebooks.sitePublished, trashedAt: notebooks.trashedAt }).from(notebooks).where(inArray(notebooks.id, notebookIds))
      : Promise.resolve([]),
  ]);
  const liveFolders = new Map(folderRows.filter(f => !f.trashedAt).map(f => [f.id, f]));
  const liveNotebooks = new Map(notebookRows.filter(n => !n.trashedAt && !n.sitePublished).map(n => [n.id, n]));
  const involvedNbIds = [...new Set([
    ...[...liveFolders.values()].map(f => f.notebookId),
    ...liveNotebooks.keys(),
  ])];
  const [allDirs, allNotes, spaces] = await Promise.all([
    involvedNbIds.length
      ? db.select({ id: folders.id, parentId: folders.parentId, notebookId: folders.notebookId }).from(folders).where(and(inArray(folders.notebookId, involvedNbIds), isNull(folders.trashedAt)))
      : Promise.resolve([]),
    involvedNbIds.length
      ? db.select({ id: notes.id, folderId: notes.folderId, notebookId: notes.notebookId, updatedAt: notes.updatedAt }).from(notes).where(and(inArray(notes.notebookId, involvedNbIds), isNull(notes.trashedAt)))
      : Promise.resolve([]),
    (() => {
      const wsIds = [...new Set([
        ...[...liveFolders.values()].map(f => f.workspaceId),
        ...[...liveNotebooks.values()].map(n => n.workspaceId),
      ])];
      return wsIds.length
        ? db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(inArray(workspaces.id, wsIds))
        : Promise.resolve([]);
    })(),
  ]);
  const wsName = (id: string) => spaces.find(s => s.id === id)?.name ?? "";

  const out: PublicWikiBook[] = [];
  for (const share of unique) {
    if (share.targetType === "folder") {
      const folder = liveFolders.get(share.targetId);
      if (!folder) continue;
      const ids = folderIdsInTree(folder.id, allDirs);
      const ns = allNotes.filter(n => n.folderId && ids.has(n.folderId));
      out.push({
        id: share.id,
        title: folder.title,
        workspace: wsName(folder.workspaceId),
        url: `/p/${share.token}`,
        noteCount: ns.length,
        updatedAt: latest(ns.map(n => n.updatedAt), share.createdAt),
        accent: null,
        kind: "folder",
      });
      continue;
    }
    const notebook = liveNotebooks.get(share.targetId);
    if (!notebook) continue;
    const ns = allNotes.filter(n => n.notebookId === notebook.id);
    out.push({
      id: share.id,
      title: notebook.title,
      workspace: wsName(notebook.workspaceId),
      url: `/p/${share.token}`,
      noteCount: ns.length,
      updatedAt: latest(ns.map(n => n.updatedAt), share.createdAt),
      accent: null,
      kind: "notebook",
    });
  }
  return out;
}
