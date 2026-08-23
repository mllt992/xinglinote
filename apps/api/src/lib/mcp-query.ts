import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { folders, notebooks, notes } from "../db/schema.ts";
import { retrieve, snippetAround } from "./knowledge-ai.ts";
import { tokenize } from "@kb/core";
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
  workspaceIds: string | string[],
  rows: Array<{ id: string; notebookId: string; folderId: string | null; title: string }>,
) {
  const out = new Map<string, string[]>();
  if (!rows.length) return out;
  const ids = Array.isArray(workspaceIds) ? workspaceIds : [workspaceIds];
  if (!ids.length) return out;
  const nbs = await db.select({ id: notebooks.id, title: notebooks.title }).from(notebooks)
    .where(inArray(notebooks.workspaceId, ids));
  const fs = await db.select({ id: folders.id, title: folders.title, parentId: folders.parentId }).from(folders)
    .where(and(inArray(folders.workspaceId, ids), isNull(folders.trashedAt)));
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
  workspaceIds: string[];
  userId: string;
  query: string;
  notebookId?: string;
  tag?: string;
  mode: "keyword" | "semantic" | "hybrid";
  limit: number;
  accept: (noteId: string) => Promise<boolean>;
}) {
  const hits = new Map<string, { id: string; title: string; snippet: string; notebookId: string; folderId: string | null; score: number }>();
  if (!input.workspaceIds.length) return [];

  const take = async (id: string, title: string, snippet: string, notebookId: string, folderId: string | null, score: number) => {
    if (input.notebookId && notebookId !== input.notebookId) return;
    if (!(await input.accept(id))) return;
    const old = hits.get(id);
    if (!old || score > old.score) hits.set(id, { id, title, snippet: snippet.slice(0, 240), notebookId, folderId, score });
  };

  if (input.mode !== "semantic") {
    const rows = await db.select({
      id: notes.id, title: notes.title, bodyMd: notes.bodyMd, tags: notes.tags,
      notebookId: notes.notebookId, folderId: notes.folderId,
    }).from(notes).where(and(
      inArray(notes.workspaceId, input.workspaceIds),
      isNull(notes.trashedAt),
      likeClause(input.query),
    )).limit(80);
    const parts = tokenize(input.query);
    let rank = 0;
    for (const n of rows) {
      const tags = n.tags as string[];
      if (input.tag && !tags.includes(input.tag)) continue;
      await take(n.id, n.title, snippetAround(n.bodyMd, parts), n.notebookId, n.folderId, 1 / (60 + rank++));
    }
  }

  if (input.mode !== "keyword") {
    for (const workspaceId of input.workspaceIds) {
      const rows = await retrieve({
        workspaceId,
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
  }

  const sorted = [...hits.values()].sort((a, b) => b.score - a.score).slice(0, input.limit);
  const paths = await buildNotePaths(input.workspaceIds, sorted);
  return sorted.map(h => ({ id: h.id, title: h.title, path: paths.get(h.id) ?? [h.title], snippet: h.snippet }));
}

export async function listRecentNotes(input: {
  workspaceIds: string[];
  since?: Date;
  limit: number;
  after?: { updatedAt: Date; id: string };
  accept: (noteId: string) => Promise<boolean>;
}) {
  if (!input.workspaceIds.length) return [];
  const conds = [inArray(notes.workspaceId, input.workspaceIds), isNull(notes.trashedAt)];
  if (input.since) conds.push(gte(notes.updatedAt, input.since));
  let after=input.after;
  const kept:Array<{id:string;title:string;notebookId:string;folderId:string|null;version:number;updatedAt:Date}>=[];
  while(kept.length<input.limit){
    const pageConds=[...conds];
    if(after)pageConds.push(or(lt(notes.updatedAt,after.updatedAt),and(eq(notes.updatedAt,after.updatedAt),lt(notes.id,after.id)))!);
    const batch=Math.min(200,Math.max(40,(input.limit-kept.length)*4));
    const rows=await db.select({id:notes.id,title:notes.title,notebookId:notes.notebookId,folderId:notes.folderId,version:notes.version,updatedAt:notes.updatedAt}).from(notes).where(and(...pageConds)).orderBy(desc(notes.updatedAt),desc(notes.id)).limit(batch);
    for(const n of rows){if(await input.accept(n.id)){kept.push(n);if(kept.length>=input.limit)break;}}
    if(rows.length<batch)break;
    const last=rows.at(-1)!;after={updatedAt:last.updatedAt,id:last.id};
  }
  const paths = await buildNotePaths(input.workspaceIds, kept);
  return kept.map(n => ({
    id: n.id,
    title: n.title,
    path: paths.get(n.id) ?? [n.title],
    version: n.version,
    updated_at: n.updatedAt,
  }));
}
