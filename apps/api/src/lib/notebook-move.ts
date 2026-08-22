import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { fail, nextSortKey } from "@kb/shared";
import { db } from "../db/client.ts";
import {
  aiChunks, attachments, auditLogs, backgroundJobs, calendarItems, folders, links,
  mcpTokens, notebookMembers, notebooks, notes, posts, shareLinks, workspaceMembers, workspaces,
} from "../db/schema.ts";
import { env } from "../env.ts";
import { isBlobPath } from "./blob-path.ts";
import { noteCandidates, rebuildLinks } from "./links.ts";

export type NotebookMoveResult = {
  notebook: typeof notebooks.$inferSelect;
  /** 跟着搬走的笔记数（含回收站里的）。 */
  notes: number;
  /** 因为不是目标工作区成员而被摘掉的白名单条目数。 */
  droppedMembers: number;
  /** 目标区已经有同名 slug，这本被换了 slug——文档站地址会跟着变。 */
  slugChanged: boolean;
};

/**
 * 把一整本笔记本搬到另一个工作区。
 *
 * 「工作区」是这个产品里几乎所有查询的分区键：笔记、目录、附件、分享、日历条目、
 * 向量块都各自存了一份 `workspace_id`，谁漏改了谁就变成孤儿——搜索里搜不到、
 * 附件读不出来、回收站恢复出来落在别的区。所以这里必须把它们**一起**改掉，
 * 而不是只动 `notebooks.workspace_id` 那一行。
 *
 * 落盘顺序是「先复制文件 → 再提交事务 → 最后删旧文件」。三步都不原子，但这个顺序
 * 保证任何一步炸掉时**库里指的路径上都有文件**：中途失败最多留下几个没人引用的副本，
 * 不会出现「行已经指向新工作区、文件还在老目录」的读不出来。
 */
export async function moveNotebook(notebookId: string, targetWorkspaceId: string, actorId: string): Promise<NotebookMoveResult> {
  const [nb] = await db.select().from(notebooks).where(eq(notebooks.id, notebookId));
  if (!nb || nb.trashedAt) throw fail("NOT_FOUND", "笔记本不存在");
  if (nb.workspaceId === targetWorkspaceId) throw fail("VALIDATION", "笔记本已经在这个工作区里");
  const [dst] = await db.select().from(workspaces).where(eq(workspaces.id, targetWorkspaceId));
  if (!dst) throw fail("NOT_FOUND", "目标工作区不存在");
  const srcWorkspaceId = nb.workspaceId;

  // 私密 / 指定成员的可见性是相对工作区算的：创建者不在目标区里，
  // 搬过去之后这本对谁都不可见，等于凭空消失。宁可先拦下来。
  const dstMembers = new Set(
    (await db.select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, dst.id)))
      .map(m => m.userId),
  );
  if (nb.visibility !== "open" && !dstMembers.has(nb.createdBy)) {
    throw fail("VALIDATION", "私密 / 指定成员的笔记本，创建者必须先是目标工作区的成员");
  }

  const noteRows = await db.select({ id: notes.id, aiIndex: notes.aiIndex, trashedAt: notes.trashedAt })
    .from(notes).where(eq(notes.notebookId, nb.id));
  const noteIds = noteRows.map(n => n.id);
  const folderIds = (await db.select({ id: folders.id }).from(folders).where(eq(folders.notebookId, nb.id))).map(f => f.id);
  const files = noteIds.length ? await db.select().from(attachments).where(inArray(attachments.noteId, noteIds)) : [];
  // 指进这本的双链来自哪些「留在原地」的笔记——它们的链接行要一起重建，
  // 否则反向链接会跨工作区把标题露出去。
  const inbound = noteIds.length
    ? [...new Set((await db.select({ id: links.fromNoteId }).from(links).where(inArray(links.targetNoteId, noteIds))).map(r => r.id))]
      .filter(id => !noteIds.includes(id))
    : [];

  // (workspace_id, slug) 是唯一键，而每个工作区的第一本都叫 `inbox`——不换 slug 直接撞。
  const [clash] = await db.select({ id: notebooks.id }).from(notebooks)
    .where(and(eq(notebooks.workspaceId, dst.id), eq(notebooks.slug, nb.slug)));
  const slug = clash ? `nb-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}` : nb.slug;
  const keys = await db.select({ sortKey: notebooks.sortKey }).from(notebooks)
    .where(and(eq(notebooks.workspaceId, dst.id), isNull(notebooks.trashedAt)));
  const sortKey = nextSortKey(keys.map(k => k.sortKey));

  // —— 第一步：把文件复制到新位置。这一步不删任何东西，失败了回滚就是删掉副本。——
  const notesFrom = join(env.dataDir, "workspaces", srcWorkspaceId, "notes", nb.id);
  const notesTo = join(env.dataDir, "workspaces", dst.id, "notes", nb.id);
  const copied: string[] = [];
  try {
    if (await cp(notesFrom, notesTo, { recursive: true, force: true }).then(() => true, missing)) copied.push(notesTo);
    const legacyFiles = files.filter(a => !isBlobPath(a.storedName));
    if (legacyFiles.length) await mkdir(join(env.dataDir, "attachments", dst.id), { recursive: true });
    for (const a of legacyFiles) {
      const to = join(env.dataDir, "attachments", dst.id, a.storedName);
      if (await copyFile(join(env.dataDir, "attachments", a.workspaceId, a.storedName), to).then(() => true, missing)) copied.push(to);
    }
  } catch (e) {
    await discard(copied);
    throw e;
  }

  // —— 第二步：一个事务改完所有带 workspace_id 的行。——
  const acl = await db.select().from(notebookMembers).where(eq(notebookMembers.notebookId, nb.id));
  const dropped = acl.filter(m => !dstMembers.has(m.userId));
  let saved: typeof notebooks.$inferSelect;
  try {
    saved = await db.transaction(async tx => {
      const [row] = await tx.update(notebooks).set({ workspaceId: dst.id, slug, sortKey }).where(eq(notebooks.id, nb.id)).returning();
      await tx.update(folders).set({ workspaceId: dst.id }).where(eq(folders.notebookId, nb.id));
      await tx.update(notes).set({ workspaceId: dst.id }).where(eq(notes.notebookId, nb.id));
      if (noteIds.length) {
        await tx.update(attachments).set({ workspaceId: dst.id }).where(inArray(attachments.noteId, noteIds));
        // 向量是拿**原工作区**那套 embedding 模型算出来的，跨区再比距离没有意义。
        // 删掉重排队，让目标区自己的模型重建；目标区没配 AI 就一直空着，也对。
        await tx.delete(aiChunks).where(inArray(aiChunks.noteId, noteIds));
        for (const n of noteRows) {
          if (n.aiIndex && !n.trashedAt) await tx.insert(backgroundJobs).values({ type: "index_note", payload: { noteId: n.id } });
        }
        // 留在原区的圈子动态还挂着这些笔记，而动态列表是不做鉴权直接把标题显出来的。
        await tx.update(posts).set({ noteId: null })
          .where(and(eq(posts.visibility, "workspace"), eq(posts.workspaceId, srcWorkspaceId), inArray(posts.noteId, noteIds)));
        await tx.update(shareLinks).set({ workspaceId: dst.id })
          .where(and(inArray(shareLinks.targetType, ["note", "heading"]), inArray(shareLinks.targetId, noteIds)));
        await tx.update(calendarItems).set({ workspaceId: dst.id })
          .where(or(eq(calendarItems.notebookId, nb.id), inArray(calendarItems.sourceNoteId, noteIds)));
        // 跨区之后旧的链接行要么指错、要么在反向链接里漏标题。先删干净，出了事务再解析回来。
        await tx.delete(links).where(or(inArray(links.fromNoteId, noteIds), inArray(links.targetNoteId, noteIds)));
      } else {
        await tx.update(calendarItems).set({ workspaceId: dst.id }).where(eq(calendarItems.notebookId, nb.id));
      }
      if (folderIds.length) {
        await tx.update(shareLinks).set({ workspaceId: dst.id })
          .where(and(eq(shareLinks.targetType, "folder"), inArray(shareLinks.targetId, folderIds)));
      }
      if (files.length) {
        await tx.update(shareLinks).set({ workspaceId: dst.id })
          .where(and(eq(shareLinks.targetType, "attachment"), inArray(shareLinks.targetId, files.map(a => a.id))));
      }
      for (const m of dropped) {
        await tx.delete(notebookMembers).where(and(eq(notebookMembers.notebookId, nb.id), eq(notebookMembers.userId, m.userId)));
      }
      // 原区的 MCP 钥匙白名单里还留着这本，钥匙面板上会显示成一本点不开的幽灵笔记本。
      const tokens = await tx.select().from(mcpTokens).where(eq(mcpTokens.workspaceId, srcWorkspaceId));
      for (const t of tokens) {
        const list = t.notebookIds as string[];
        if (list.includes(nb.id)) await tx.update(mcpTokens).set({ notebookIds: list.filter(id => id !== nb.id) }).where(eq(mcpTokens.id, t.id));
      }
      for (const workspaceId of [srcWorkspaceId, dst.id]) {
        await tx.insert(auditLogs).values({
          userId: actorId, workspaceId, actorType: "user", actorId, action: "notebook.move",
          targetType: "notebook", targetId: nb.id, result: "ok",
          details: { title: nb.title, from: srcWorkspaceId, to: dst.id, notes: noteIds.length, droppedMembers: dropped.length, slugChanged: slug !== nb.slug },
        });
      }
      return row;
    });
  } catch (e) {
    await discard(copied);
    throw e;
  }

  // —— 第三步：收尾。旧文件删不掉只是留了垃圾，双链重建失败只是少几条反向链接，
  //     都不该把一次已经成功的搬迁回报成失败。——
  await discard([notesFrom, ...files.filter(a => !isBlobPath(a.storedName)).map(a => join(env.dataDir, "attachments", srcWorkspaceId, a.storedName))]);
  try {
    await relinkAll(noteIds, dst.id);
    await relinkAll(inbound, srcWorkspaceId);
  } catch { /* 下次保存这几篇时自己会重建 */ }

  return { notebook: saved, notes: noteIds.length, droppedMembers: dropped.length, slugChanged: slug !== nb.slug };
}

/** 源文件不存在不算错——从没写过正文的笔记本在盘上就没有目录。 */
function missing(e: unknown) {
  if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return false;
  throw e;
}

async function discard(paths: string[]) {
  for (const p of paths) await rm(p, { recursive: true, force: true }).catch(() => {});
}

/**
 * 逐篇重建双链。候选集只查一次传进去，别让每篇都去扫一遍全工作区的笔记，
 * 不然一本上千篇的笔记本要跑 N² 次比对。
 */
async function relinkAll(ids: string[], workspaceId: string) {
  if (!ids.length) return;
  const pool = await noteCandidates(workspaceId);
  for (const id of ids) {
    const [n] = await db.select({ bodyMd: notes.bodyMd }).from(notes).where(eq(notes.id, id));
    if (n) await rebuildLinks(id, workspaceId, n.bodyMd, pool);
  }
}
