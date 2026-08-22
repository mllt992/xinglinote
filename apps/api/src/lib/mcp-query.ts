import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { folders, notebooks, notes } from "../db/schema.ts";
import { retrieve } from "./knowledge-ai.ts";
import { likeContains } from "./like.ts";

export { likeContains };

export function likeClause(query: string) {
  const pat = likeContains(query);
  return or(
    sql`${notes.title} ILIKE ${pat} ESCAPE ${"\\"}`,
    sql`${notes.bodyMd} ILIKE ${pat} ESCAPE ${"\\"}`,
  );
}

export async function buildNotePaths(
  workspaceId: string,
  rows: Array<{ id: string; notebookId: string; folderId: string | null; title: string }>,
) {
  const out = new Map<string, string[]>();
  if (!rows.length) return out;
  const nbs = await db.select({ id: notebooks.id, title: notebooks.title }).from(notebooks)
    .where(eq(notebooks.workspaceId, workspaceId));
  const fs = await db.select({ id: folders.id, title: folders.title, parentId: folders.parentId }).from(folders)
    .where(and(eq(folders.workspaceId, workspaceId), isNull(folders.trashedAt)));
  const nbTitle = new Map(nbs.map(n => [n.id, n.title]));
  const byId = new Map(fs.map(f => [f.id, f]));
  for (const row of rows) {
    const parts = [nbTitle.get(row.notebookId) ?? "笔记本"];
    const stack: string[] = [];
    let cur = row.folderId ? byId.get(row.folderId) : undefined;
    const guard = new Set<string>();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      stack.unshift(cur.title);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    parts.push(...stack, row.title);
    out.set(row.id, parts);
  }
  return out;
}

export async function searchNotesInScope(input: {
  workspaceId: string;
  userId: string;
  query: string;
  notebookId?: string;
  tag?: string;
  mode: "keyword" | "semantic" | "hybrid";
  limit: number;
  accept: (noteId: string) => Promise<boolean>;
}) {
  const hits = new Map<string, { id: string; title: string; snippet: string; notebookId: string; folderId: string | null; score: number }>();

  const take = async (id: string, title: string, snippet: string, notebookId: string, folderId: string | null, score: number) => {
    if (input.notebookId && notebookId !== input.notebookId) return;
    if (!(await input.accept(id))) return;
    const old = hits.get(id);
    if (!old || score > old.score) hits.set(id, { id, title, snippet: snippet.slice(0, 240), notebookId, folderId, score });
  };

  if (input.mode !== "semantic") {
    const rows = await db.select().from(notes).where(and(
      eq(notes.workspaceId, input.workspaceId),
      isNull(notes.trashedAt),
      likeClause(input.query),
    )).limit(80);
    let rank = 0;
    for (const n of rows) {
      const tags = n.tags as string[];
      if (input.tag && !tags.includes(input.tag)) continue;
      await take(n.id, n.title, n.bodyMd, n.notebookId, n.folderId, 1 / (60 + rank++));
    }
  }

  if (input.mode !== "keyword") {
    const rows = await retrieve({
      workspaceId: input.workspaceId,
      userId: input.userId,
      query: input.query,
      notebookId: input.notebookId,
      mode: input.mode === "hybrid" ? "semantic" : input.mode,
      limit: input.limit,
      filterNoteId: input.accept,
    });
    for (const r of rows) {
      const [n] = await db.select().from(notes).where(eq(notes.id, r.noteId));
      if (!n || n.trashedAt) continue;
      const tags = n.tags as string[];
      if (input.tag && !tags.includes(input.tag)) continue;
      await take(n.id, n.title, r.excerpt, n.notebookId, n.folderId, 1 + r.score);
    }
  }

  const sorted = [...hits.values()].sort((a, b) => b.score - a.score).slice(0, input.limit);
  const paths = await buildNotePaths(input.workspaceId, sorted);
  return sorted.map(h => ({ id: h.id, title: h.title, path: paths.get(h.id) ?? [h.title], snippet: h.snippet }));
}

export async function listRecentNotes(input: {
  workspaceId: string;
  since?: Date;
  limit: number;
  accept: (noteId: string) => Promise<boolean>;
}) {
  const conds = [eq(notes.workspaceId, input.workspaceId), isNull(notes.trashedAt)];
  if (input.since) conds.push(gte(notes.updatedAt, input.since));
  const rows = await db.select({
    id: notes.id, title: notes.title, notebookId: notes.notebookId, folderId: notes.folderId,
    version: notes.version, updatedAt: notes.updatedAt,
  }).from(notes).where(and(...conds)).orderBy(desc(notes.updatedAt)).limit(Math.min(200, input.limit * 6));
  const kept = [];
  for (const n of rows) {
    if (!(await input.accept(n.id))) continue;
    kept.push(n);
    if (kept.length >= input.limit) break;
  }
  const paths = await buildNotePaths(input.workspaceId, kept);
  return kept.map(n => ({
    id: n.id,
    title: n.title,
    path: paths.get(n.id) ?? [n.title],
    version: n.version,
    updated_at: n.updatedAt,
  }));
}
