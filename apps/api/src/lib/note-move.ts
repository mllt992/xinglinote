import { unlink } from "node:fs/promises";
import { and, eq, isNull } from "drizzle-orm";
import { fail, nextSortKey, normalizeTitle } from "@kb/shared";
import { db } from "../db/client.ts";
import { aiChunks, auditLogs, calendarItems, folders, notes } from "../db/schema.ts";
import { notePath, writeNoteFile } from "./files.ts";

/**
 * 把一篇笔记改到另一个目录（可顺带换本）。
 *
 * 权限由调用方先查：源笔记和目标本都要 can_edit。这里只保证：
 * 不跨工作区、目录属于目标本、同目录标题不撞。
 * 换本时文件按 notebookId 分目录，旧文件顺手清掉，避免留下一份幽灵 md。
 * 向量块和日历条目各自存了一份 notebook_id，漏改会在旧本里搜到、新本里看不见。
 */
export async function relocateNote(input: {
  note: typeof notes.$inferSelect;
  targetNotebook: { id: string; workspaceId: string };
  folderId: string | null;
  actorId: string;
}): Promise<{ id: string; notebookId: string; folderId: string | null; version: number }> {
  const { note: n, targetNotebook: nb, folderId, actorId } = input;
  if (nb.workspaceId !== n.workspaceId) throw fail("VALIDATION", "不能跨工作区移动笔记");
  if (folderId) {
    const [folder] = await db.select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.id, folderId), eq(folders.notebookId, nb.id), isNull(folders.trashedAt)));
    if (!folder) throw fail("VALIDATION", "目录不属于目标笔记本");
  }
  if (n.notebookId === nb.id && (n.folderId ?? null) === folderId) {
    return { id: n.id, notebookId: n.notebookId, folderId: n.folderId ?? null, version: n.version };
  }

  const siblings = await db
    .select({ id: notes.id, title: notes.title, folderId: notes.folderId, sortKey: notes.sortKey })
    .from(notes)
    .where(and(eq(notes.notebookId, nb.id), isNull(notes.trashedAt)));
  const clash = siblings.some((s) =>
    s.id !== n.id
    && (s.folderId ?? null) === folderId
    && normalizeTitle(s.title) === normalizeTitle(n.title));
  if (clash) throw fail("VALIDATION", "目标目录已有同名笔记");

  const changedNotebook = n.notebookId !== nb.id;
  const saved = await db.transaction(async (tx) => {
    const [row] = await tx.update(notes).set({
      notebookId: nb.id,
      folderId,
      sortKey: nextSortKey(siblings.map((s) => s.sortKey)),
      version: n.version + 1,
      updatedBy: actorId,
      updatedAt: new Date(),
    }).where(eq(notes.id, n.id)).returning();
    if (changedNotebook) {
      await tx.update(aiChunks).set({ notebookId: nb.id }).where(eq(aiChunks.noteId, n.id));
      await tx.update(calendarItems).set({ notebookId: nb.id }).where(eq(calendarItems.sourceNoteId, n.id));
    }
    await tx.insert(auditLogs).values({
      userId: actorId,
      workspaceId: n.workspaceId,
      actorType: "user",
      actorId,
      action: "note.move",
      targetType: "note",
      targetId: n.id,
      result: "ok",
      details: { fromNotebookId: n.notebookId, toNotebookId: nb.id, folderId, title: n.title },
    });
    return row;
  });

  await writeNoteFile({ ...saved, noteId: saved.id, bodyMd: saved.bodyMd });
  if (changedNotebook) {
    try { await unlink(notePath(n.workspaceId, n.notebookId, n.id)); }
    catch { /* 旧文件清不掉也不挡搬家，最多留一份没人引用的 md */ }
  }
  return { id: saved.id, notebookId: saved.notebookId, folderId: saved.folderId ?? null, version: saved.version };
}
