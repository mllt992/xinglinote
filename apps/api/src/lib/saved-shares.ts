import { and, count, desc, eq } from "drizzle-orm";
import { AppError, fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { attachments, folders, notebooks, savedShares, shareLinks, workspaces } from "../db/schema.ts";
import { noteAccess } from "./note-access.ts";
import { notebookAccess } from "./notebook-access.ts";
import {
  renderShare,
  renderSite,
  shareAuthorName,
  shareChannelTitle,
  shareEffective,
  shareTargetLive,
  siteLive,
  siteOpenPath,
} from "./share-render.ts";

export const SAVED_SHARE_CAP = 200;
const GONE = "内容不存在或已失效";
const gone = () => fail("NOT_FOUND", GONE);

export type SavedShareRow = typeof savedShares.$inferSelect;
export type SavedChannel =
  | { source: "share"; share: typeof shareLinks.$inferSelect; lastNoteId?: string | null }
  | { source: "site"; notebook: typeof notebooks.$inferSelect; workspaceName: string; lastNoteId?: string | null };

/**
 * 自动收下该不该发生。抽出来单测：dismissed 不救活、ACL 已能读就跳过、满员跳过。
 */
export function autoSaveDecision(input: {
  existing: { status: string } | null;
  canReadViaAcl: boolean;
  activeCount: number;
}): "insert" | "touch" | "skip" {
  if (input.existing?.status === "dismissed") return "skip";
  if (input.existing?.status === "active") return "touch";
  if (input.canReadViaAcl) return "skip";
  if (input.activeCount >= SAVED_SHARE_CAP) return "skip";
  return "insert";
}

async function silent<T>(label: string, run: () => Promise<T>): Promise<T | null> {
  try { return await run(); }
  catch (e) {
    console.error(`[saved-shares] ${label}`, e);
    return null;
  }
}

export async function canReadViaWorkspaceAcl(userId: string, channel: SavedChannel): Promise<boolean> {
  try {
    if (channel.source === "site") {
      await notebookAccess(channel.notebook.id, userId, "read");
      return true;
    }
    const share = channel.share;
    if (share.targetType === "notebook") {
      await notebookAccess(share.targetId, userId, "read");
      return true;
    }
    if (share.targetType === "folder") {
      const [folder] = await db.select().from(folders).where(eq(folders.id, share.targetId));
      if (!folder) return false;
      await notebookAccess(folder.notebookId, userId, "read");
      return true;
    }
    if (share.targetType === "attachment") {
      const [file] = await db.select().from(attachments).where(eq(attachments.id, share.targetId));
      if (!file) return false;
      await noteAccess(file.noteId, userId, "read");
      return true;
    }
    await noteAccess(share.targetId, userId, "read");
    return true;
  } catch (e) {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "FORBIDDEN" || e.code === "UNAUTHENTICATED")) return false;
    throw e;
  }
}

async function activeCount(userId: string) {
  const [row] = await db.select({ n: count() }).from(savedShares).where(and(eq(savedShares.userId, userId), eq(savedShares.status, "active")));
  return Number(row?.n ?? 0);
}

async function findRow(userId: string, channel: SavedChannel) {
  if (channel.source === "share") {
    const [row] = await db.select().from(savedShares).where(and(eq(savedShares.userId, userId), eq(savedShares.shareId, channel.share.id)));
    return row ?? null;
  }
  const [row] = await db.select().from(savedShares).where(and(eq(savedShares.userId, userId), eq(savedShares.siteNotebookId, channel.notebook.id)));
  return row ?? null;
}

async function snapshots(channel: SavedChannel) {
  if (channel.source === "share") {
    return {
      titleSnapshot: await shareChannelTitle(channel.share),
      kindSnapshot: channel.share.targetType,
      authorNameSnapshot: await shareAuthorName(channel.share),
    };
  }
  return {
    titleSnapshot: channel.notebook.title,
    kindSnapshot: "site",
    authorNameSnapshot: channel.workspaceName,
  };
}

async function writeActive(userId: string, channel: SavedChannel, existing: SavedShareRow | null) {
  const snap = await snapshots(channel);
  const lastNoteId = channel.lastNoteId ?? existing?.lastNoteId ?? null;
  const now = new Date();
  if (existing) {
    const [saved] = await db.update(savedShares).set({
      ...snap,
      lastNoteId,
      lastOpenedAt: now,
      status: "active",
      dismissedAt: null,
    }).where(eq(savedShares.id, existing.id)).returning();
    return saved;
  }
  const [created] = await db.insert(savedShares).values({
    userId,
    source: channel.source,
    shareId: channel.source === "share" ? channel.share.id : null,
    siteNotebookId: channel.source === "site" ? channel.notebook.id : null,
    lastNoteId,
    ...snap,
    status: "active",
    lastOpenedAt: now,
  }).returning();
  return created;
}

/** 公开读取成功后顺手收下。失败只打日志，绝不抛给调用方。 */
export async function maybeAutoSave(user: { id: string; status: string } | null, channel: SavedChannel): Promise<SavedShareRow | null> {
  return silent("auto-save", async () => {
    if (!user || user.status === "banned" || user.status === "deleted") return null;
    const existing = await findRow(user.id, channel);
    const canRead = await canReadViaWorkspaceAcl(user.id, channel);
    const decision = autoSaveDecision({ existing, canReadViaAcl: canRead, activeCount: existing ? 0 : await activeCount(user.id) });
    if (decision === "skip") return existing;
    return writeActive(user.id, channel, existing);
  });
}

export async function peekSaved(userId: string, channel: SavedChannel) {
  return findRow(userId, channel);
}

export async function reactivateSaved(userId: string, id: string) {
  const row = await owned(userId, id);
  if (row.status === "active") return row;
  if (await activeCount(userId) >= SAVED_SHARE_CAP) throw fail("QUOTA", "已分享已满，先移出一些");
  if (row.source === "share" && row.shareId) {
    const [share] = await db.select().from(shareLinks).where(eq(shareLinks.id, row.shareId));
    if (!share || !shareEffective(share) || !await shareTargetLive(share)) throw gone();
  } else if (row.source === "site" && row.siteNotebookId) {
    if (!await siteLive(row.siteNotebookId)) throw gone();
  } else throw gone();
  const [saved] = await db.update(savedShares).set({ status: "active", dismissedAt: null, lastOpenedAt: new Date() }).where(eq(savedShares.id, row.id)).returning();
  return saved;
}

export async function saveManually(userId: string, channel: SavedChannel) {
  if (channel.source === "share" && !shareEffective(channel.share)) throw gone();
  if (channel.source === "site" && !(await siteLive(channel.notebook.id))) throw gone();
  const existing = await findRow(userId, channel);
  if (!existing && await activeCount(userId) >= SAVED_SHARE_CAP) throw fail("QUOTA", "已分享已满，先移出一些");
  return writeActive(userId, channel, existing);
}

export async function dismissSaved(userId: string, id: string) {
  const row = await owned(userId, id);
  if (row.status !== "active") throw gone();
  const [saved] = await db.update(savedShares).set({ status: "dismissed", dismissedAt: new Date() }).where(eq(savedShares.id, row.id)).returning();
  return saved;
}

async function owned(userId: string, id: string) {
  const [row] = await db.select().from(savedShares).where(eq(savedShares.id, id));
  if (!row || row.userId !== userId) throw gone();
  return row;
}

export async function requireActive(userId: string, id: string) {
  const row = await owned(userId, id);
  if (row.status !== "active") throw gone();
  return row;
}

async function liveTitle(row: SavedShareRow): Promise<{ live: boolean; title: string; authorName: string }> {
  if (row.source === "share" && row.shareId) {
    const [share] = await db.select().from(shareLinks).where(eq(shareLinks.id, row.shareId));
    if (!share || !await shareTargetLive(share)) return { live: false, title: row.titleSnapshot, authorName: row.authorNameSnapshot };
    return { live: true, title: await shareChannelTitle(share), authorName: await shareAuthorName(share) };
  }
  if (row.source === "site" && row.siteNotebookId) {
    const [nb] = await db.select({ title: notebooks.title, sitePublished: notebooks.sitePublished, trashedAt: notebooks.trashedAt, workspaceId: notebooks.workspaceId }).from(notebooks).where(eq(notebooks.id, row.siteNotebookId));
    if (!nb || !nb.sitePublished || nb.trashedAt) return { live: false, title: row.titleSnapshot, authorName: row.authorNameSnapshot };
    return { live: true, title: nb.title, authorName: row.authorNameSnapshot };
  }
  return { live: false, title: row.titleSnapshot, authorName: row.authorNameSnapshot };
}

export function publicSaved(row: SavedShareRow, extra: { live: boolean; title: string; authorName: string }) {
  return {
    id: row.id,
    source: row.source,
    kind: extra.live ? (row.source === "site" ? "site" : row.kindSnapshot) : row.kindSnapshot,
    title: extra.title,
    authorName: extra.authorName,
    lastNoteId: row.lastNoteId,
    lastOpenedAt: row.lastOpenedAt,
    createdAt: row.createdAt,
    live: extra.live,
  };
}

export async function listSaved(userId: string) {
  const rows = await db.select().from(savedShares)
    .where(and(eq(savedShares.userId, userId), eq(savedShares.status, "active")))
    .orderBy(desc(savedShares.lastOpenedAt));
  return Promise.all(rows.map(async row => publicSaved(row, await liveTitle(row))));
}

export async function getSaved(userId: string, id: string) {
  const row = await requireActive(userId, id);
  return { row, item: publicSaved(row, await liveTitle(row)) };
}

export async function renderSavedContent(userId: string, id: string, noteId?: string) {
  const row = await requireActive(userId, id);
  if (row.source === "share") {
    if (!row.shareId) throw gone();
    const [share] = await db.select().from(shareLinks).where(eq(shareLinks.id, row.shareId));
    if (!share || !shareEffective(share)) throw gone();
    const payload = await renderShare(share, noteId ?? row.lastNoteId ?? undefined);
    const opened = "noteId" in payload ? (payload.noteId as string | null) : null;
    if (opened && opened !== row.lastNoteId) {
      await db.update(savedShares).set({ lastNoteId: opened, lastOpenedAt: new Date() }).where(eq(savedShares.id, row.id));
    } else {
      await db.update(savedShares).set({ lastOpenedAt: new Date() }).where(eq(savedShares.id, row.id));
    }
    const { shareToken: _drop, ...rest } = payload as typeof payload & { shareToken?: string };
    return { ...rest, savedId: row.id, source: "share" as const, kind: share.targetType };
  }
  if (!row.siteNotebookId) throw gone();
  const [nb] = await db.select().from(notebooks).where(eq(notebooks.id, row.siteNotebookId));
  if (!nb?.sitePublished || nb.trashedAt) throw gone();
  const [space] = await db.select().from(workspaces).where(eq(workspaces.id, nb.workspaceId));
  if (!space) throw gone();
  const payload = await renderSite(space, nb);
  const pick = noteId ?? row.lastNoteId ?? payload.notes[0]?.id ?? null;
  if (pick && !payload.notes.some(n => n.id === pick) && noteId) throw gone();
  await db.update(savedShares).set({ lastNoteId: pick, lastOpenedAt: new Date() }).where(eq(savedShares.id, row.id));
  return { ...payload, savedId: row.id, source: "site" as const, kind: "site" as const, noteId: pick };
}

export async function openLocation(userId: string, id: string, noteId?: string) {
  const row = await requireActive(userId, id);
  if (row.source === "share") {
    if (!row.shareId) throw gone();
    const [share] = await db.select().from(shareLinks).where(eq(shareLinks.id, row.shareId));
    if (!share || !shareEffective(share) || !await shareTargetLive(share)) throw gone();
    const pick = noteId ?? row.lastNoteId;
    return pick ? `/p/${share.token}?noteId=${pick}` : `/p/${share.token}`;
  }
  if (!row.siteNotebookId) throw gone();
  return siteOpenPath(row.siteNotebookId, noteId ?? row.lastNoteId);
}

export async function searchSavedTitles(userId: string, q: string, limit: number) {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const rows = await db.select().from(savedShares)
    .where(and(eq(savedShares.userId, userId), eq(savedShares.status, "active")))
    .orderBy(desc(savedShares.lastOpenedAt));
  return rows
    .filter(r => r.titleSnapshot.toLowerCase().includes(needle) || r.authorNameSnapshot.toLowerCase().includes(needle))
    .slice(0, limit)
    .map(r => ({
      id: r.id,
      title: r.titleSnapshot,
      snippet: r.authorNameSnapshot ? `已分享 · ${r.authorNameSnapshot}` : "已分享",
      kind: "saved_share" as const,
      savedShareId: r.id,
    }));
}

