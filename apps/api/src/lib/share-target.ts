import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.ts";
import { folders, notebooks, notes } from "../db/schema.ts";

/** 目录分享是实时子树：之后新建的笔记也会出现在链接里。 */
export async function folderSubtree(folderId: string) {
  const [root] = await db.select().from(folders).where(eq(folders.id, folderId));
  if (!root || root.trashedAt) return null;
  const all = await db.select().from(folders).where(and(eq(folders.notebookId, root.notebookId), isNull(folders.trashedAt)));
  const ids = new Set([root.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of all) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true; }
  }
  const rows = await db.select().from(notes).where(and(eq(notes.notebookId, root.notebookId), isNull(notes.trashedAt)));
  return { root, folders: all.filter(f => ids.has(f.id)), notes: rows.filter(n => n.folderId && ids.has(n.folderId)) };
}

/** 整本分享：本里全部未删除的目录和笔记，含根上的篇。 */
export async function notebookSubtree(notebookId: string) {
  const [root] = await db.select().from(notebooks).where(eq(notebooks.id, notebookId));
  if (!root || root.trashedAt) return null;
  const dirs = await db.select().from(folders).where(and(eq(folders.notebookId, root.id), isNull(folders.trashedAt)));
  const rows = await db.select().from(notes).where(and(eq(notes.notebookId, root.id), isNull(notes.trashedAt)));
  return { root, folders: dirs, notes: rows };
}

/** 这条分享能不能覆盖这篇笔记（评论 / 纠错挂载用）。 */
export async function shareCoversNote(share: { targetType: string; targetId: string }, noteId: string) {
  if (share.targetType === "note" || share.targetType === "heading") return share.targetId === noteId;
  if (share.targetType === "notebook") {
    const [note] = await db.select({ id: notes.id, notebookId: notes.notebookId, trashedAt: notes.trashedAt }).from(notes).where(eq(notes.id, noteId));
    return !!note && !note.trashedAt && note.notebookId === share.targetId;
  }
  if (share.targetType === "folder") {
    const tree = await folderSubtree(share.targetId);
    return !!tree?.notes.some(n => n.id === noteId);
  }
  return false;
}
