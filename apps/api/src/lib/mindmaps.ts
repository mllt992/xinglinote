import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import {
  boardPlainText, emptyBoard, extractBoardNoteLinks, fail, MIND_MAP_LIMITS, MindMapDataError, sanitizeBoard,
  type BoardData, type BoardKind,
} from "@kb/shared";
import { recencyBoost, scoreNote, tokenize } from "@kb/core";
import { db } from "../db/client.ts";
import { mindMapNoteLinks, mindMaps, mindMapVersions, notebooks, notes } from "../db/schema.ts";
import { notebookAccess } from "./notebook-access.ts";

/**
 * 思维导图 / 画板（设计 25）的服务端公共逻辑：路由、MCP、回收站、worker 共用。
 * 权限一律跟笔记本走：读 = notebookAccess(read)，写 = notebookAccess(edit)。
 */

export type BoardRow = typeof mindMaps.$inferSelect;
type Tx = Pick<typeof db, "select" | "delete" | "insert" | "update">;
export const BOARD_LABEL: Record<BoardKind, string> = { mindmap: "思维导图", drawio: "画板" };

/** 空串留给「还没回填」的老数据用（见 db/push.ts 的 backfillBoards），所以至少存一个空格。 */
export function searchTextOf(kind: BoardKind, data: BoardData) { return boardPlainText(kind, data) || " "; }

export function boardKind(row: Pick<BoardRow, "kind">): BoardKind { return row.kind === "drawio" ? "drawio" : "mindmap"; }

/** 洗数据 + 查大小。坏数据转成 VALIDATION，别让 500 冒出去。 */
export function cleanBoard(kind: BoardKind, data: unknown): BoardData {
  if (Buffer.byteLength(JSON.stringify(data ?? null)) > MIND_MAP_LIMITS.bytes) throw fail("PAYLOAD_TOO_LARGE", `${BOARD_LABEL[kind]}太大了（含图片最多 12 MB），请压缩图片或拆成几张`);
  try { return sanitizeBoard(kind, data); }
  catch (e) { if (e instanceof MindMapDataError) throw fail("VALIDATION", e.message); throw e; }
}

/** 读库里的数据：老数据或损坏数据也不能让页面打不开，洗不动就给空图。 */
export function readBoardData(row: Pick<BoardRow, "kind" | "data" | "title">): BoardData {
  try { return sanitizeBoard(boardKind(row), row.data); } catch { return emptyBoard(boardKind(row), row.title); }
}

/** 关联表是 data 的派生物：整份重写。指向不存在的笔记的关联不落表（节点上的链接仍保留）。 */
export async function syncBoardLinks(tx: Tx, mindMapId: string, kind: BoardKind, data: BoardData) {
  await tx.delete(mindMapNoteLinks).where(eq(mindMapNoteLinks.mindMapId, mindMapId));
  const links = extractBoardNoteLinks(kind, data);
  if (!links.length) return;
  const alive = new Set((await tx.select({ id: notes.id }).from(notes).where(inArray(notes.id, links.map(l => l.noteId)))).map(n => n.id));
  const rows = links.filter(l => alive.has(l.noteId)).map(l => ({ mindMapId, noteId: l.noteId, nodeId: l.nodeId }));
  if (rows.length) await tx.insert(mindMapNoteLinks).values(rows);
}

const MERGE_WINDOW = 5 * 60_000, MERGE_CAP = 30 * 60_000;
/**
 * 记一版历史。自动保存很频繁：同一人、同一来源、5 分钟内的连续保存并进上一版（最长并 30 分钟），
 * 恢复 / 导入 / AI 这类「事件」总是单独成版，方便回滚。
 */
export async function recordBoardVersion(tx: Tx, v: { mindMapId: string; version: number; title: string; data: BoardData; editorId: string; source: string }, now = new Date()) {
  const [last] = await tx.select().from(mindMapVersions).where(eq(mindMapVersions.mindMapId, v.mindMapId)).orderBy(desc(mindMapVersions.version)).limit(1);
  const mergeable = last && (v.source === "edit" || v.source === "mcp") && last.source === v.source && last.editorId === v.editorId
    && now.getTime() - last.updatedAt.getTime() < MERGE_WINDOW && now.getTime() - last.createdAt.getTime() < MERGE_CAP;
  if (mergeable) await tx.update(mindMapVersions).set({ version: v.version, title: v.title, data: v.data, updatedAt: now }).where(eq(mindMapVersions.id, last.id));
  else await tx.insert(mindMapVersions).values({ mindMapId: v.mindMapId, version: v.version, title: v.title, data: v.data, editorId: v.editorId, source: v.source, createdAt: now, updatedAt: now });
}

const KEEP_RECENT = 100, DAY = 86_400_000, KEEP_DAILY_DAYS = 90;
/** 与笔记版本同一策略：最近 100 版全留；更早的每天留最新一版，留 90 天。 */
export async function pruneBoardVersions(now = Date.now()) {
  const busy = await db.select({ id: mindMapVersions.mindMapId }).from(mindMapVersions).groupBy(mindMapVersions.mindMapId).having(sql`count(*) > ${KEEP_RECENT}`);
  let removed = 0;
  for (const { id } of busy) {
    const all = await db.select({ id: mindMapVersions.id, createdAt: mindMapVersions.createdAt }).from(mindMapVersions).where(eq(mindMapVersions.mindMapId, id)).orderBy(desc(mindMapVersions.version));
    const doomed: string[] = [], days = new Set<number>();
    all.forEach((v, i) => {
      if (i < KEEP_RECENT) return;
      const at = v.createdAt.getTime();
      if (at < now - KEEP_DAILY_DAYS * DAY) return void doomed.push(v.id);
      const day = Math.floor(at / DAY);
      if (days.has(day)) return void doomed.push(v.id);
      days.add(day);
    });
    for (let i = 0; i < doomed.length; i += 200) await db.delete(mindMapVersions).where(inArray(mindMapVersions.id, doomed.slice(i, i + 200)));
    removed += doomed.length;
  }
  return removed;
}

/** 回收站里超过 30 天的导图 / 画板彻底删除（版本、关联随外键级联）。 */
export async function purgeTrashedBoards(cutoff = new Date(Date.now() - 30 * DAY)) {
  const rows = await db.delete(mindMaps).where(and(isNotNull(mindMaps.trashedAt), lt(mindMaps.trashedAt, cutoff))).returning({ id: mindMaps.id });
  return rows.length;
}

export async function canEditNotebook(notebookId: string, userId: string) {
  try { await notebookAccess(notebookId, userId, "edit"); return true; } catch { return false; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 取导图并按笔记本判权限。看不见一律 NOT_FOUND；看得见但只能读时说清楚。回收站里的当作不存在。 */
export async function loadBoard(id: string, userId: string, mode: "read" | "edit") {
  if (!UUID.test(id)) throw fail("NOT_FOUND", "内容不存在");
  const [map] = await db.select().from(mindMaps).where(eq(mindMaps.id, id));
  if (!map || map.trashedAt) throw fail("NOT_FOUND", "思维导图不存在，可能已被删除");
  try {
    return { map, ...await notebookAccess(map.notebookId, userId, mode) };
  } catch {
    if (mode === "edit") {
      try { await notebookAccess(map.notebookId, userId, "read"); } catch { throw fail("NOT_FOUND", "思维导图不存在，可能已被删除"); }
      throw fail("FORBIDDEN", "你对这个笔记本只有查看权限");
    }
    throw fail("NOT_FOUND", "思维导图不存在，可能已被删除");
  }
}

export function briefBoard(map: BoardRow) {
  return { id: map.id, kind: boardKind(map), notebookId: map.notebookId, title: map.title, version: map.version, createdAt: map.createdAt, updatedAt: map.updatedAt, updatedBy: map.updatedBy };
}

export async function createBoard(v: { notebookId: string; kind: BoardKind; title: string; data: BoardData; userId: string; source: string }) {
  return db.transaction(async tx => {
    const [row] = await tx.insert(mindMaps).values({
      notebookId: v.notebookId, kind: v.kind, title: v.title, data: v.data, searchText: searchTextOf(v.kind, v.data),
      createdBy: v.userId, updatedBy: v.userId,
    }).returning();
    await syncBoardLinks(tx, row!.id, v.kind, v.data);
    await recordBoardVersion(tx, { mindMapId: row!.id, version: 1, title: v.title, data: v.data, editorId: v.userId, source: v.source });
    return row!;
  });
}

/**
 * 乐观锁保存：expectedVersion 撞了返回 null，由调用方报 CONFLICT_VERSION。
 * data / title / notebookId 都可选；只改标题或挪笔记本不记历史版本。
 */
export async function saveBoard(map: BoardRow, v: { userId: string; expectedVersion: number; title?: string; data?: BoardData; notebookId?: string; source: string }) {
  const kind = boardKind(map);
  return db.transaction(async tx => {
    const [row] = await tx.update(mindMaps).set({
      ...(v.title !== undefined ? { title: v.title } : {}),
      ...(v.notebookId ? { notebookId: v.notebookId } : {}),
      ...(v.data ? { data: v.data, searchText: searchTextOf(kind, v.data) } : {}),
      version: v.expectedVersion + 1, updatedBy: v.userId, updatedAt: new Date(),
    }).where(and(eq(mindMaps.id, map.id), eq(mindMaps.version, v.expectedVersion), isNull(mindMaps.trashedAt))).returning();
    if (!row) return null;
    if (v.data) {
      await syncBoardLinks(tx, row.id, kind, v.data);
      await recordBoardVersion(tx, { mindMapId: row.id, version: row.version, title: row.title, data: v.data, editorId: v.userId, source: v.source });
    }
    return row;
  });
}

/** 这个人在这些工作区里能读的笔记本（未进回收站）。 */
export async function readableNotebooks(userId: string, workspaceIds: string[]) {
  if (!workspaceIds.length) return [];
  const nbs = await db.select().from(notebooks).where(and(inArray(notebooks.workspaceId, workspaceIds), isNull(notebooks.trashedAt)));
  const out: Array<typeof nbs[number]> = [];
  for (const nb of nbs) { try { await notebookAccess(nb.id, userId, "read"); out.push(nb); } catch { /* 看不见 */ } }
  return out;
}

/** 全局搜索里的导图 / 画板：标题 + 节点文字 + 备注，按笔记本可见性过滤。 */
export async function searchBoards(userId: string, workspaceIds: string[], q: string, opts: { notebookId?: string; titleOnly?: boolean; limit?: number } = {}) {
  const parts = tokenize(q);
  if (!parts.length) return [];
  const nbs = (await readableNotebooks(userId, workspaceIds)).filter(nb => !opts.notebookId || nb.id === opts.notebookId);
  if (!nbs.length) return [];
  const byId = new Map(nbs.map(nb => [nb.id, nb]));
  const rows = await db.select({ id: mindMaps.id, kind: mindMaps.kind, title: mindMaps.title, notebookId: mindMaps.notebookId, searchText: mindMaps.searchText, updatedAt: mindMaps.updatedAt })
    .from(mindMaps).where(and(inArray(mindMaps.notebookId, [...byId.keys()]), isNull(mindMaps.trashedAt)));
  const scored = [];
  for (const r of rows) {
    const body = opts.titleOnly ? "" : r.searchText;
    const base = scoreNote(parts, { title: r.title, tags: [], body });
    if (!base) continue;
    const lower = body.toLowerCase();
    const needle = parts.map(p => p.raw).concat(parts.flatMap(p => p.grams)).find(t => lower.includes(t)) ?? "";
    const at = needle ? lower.indexOf(needle) : -1;
    const snippet = (at >= 0 ? body.slice(Math.max(0, at - 40), at + 120) : body.slice(0, 120)).replace(/\s*\n\s*/g, " · ");
    const nb = byId.get(r.notebookId)!;
    scored.push({ id: r.id, kind: r.kind === "drawio" ? "drawio" as const : "mindmap" as const, title: r.title, notebookId: r.notebookId, notebookTitle: nb.title, workspaceId: nb.workspaceId, snippet, updatedAt: r.updatedAt, score: Math.round((base + recencyBoost(r.updatedAt)) * 100) / 100 });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 20);
}
