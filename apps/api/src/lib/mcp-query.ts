import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { AppError } from "@kb/shared";
import { db } from "../db/client.ts";
import { folders, notebooks, notes } from "../db/schema.ts";
import { retrieve, snippetAround } from "./knowledge-ai.ts";
import { toMcpSource } from "./mcp-source.ts";
import type { KnowledgeSourceHit } from "./knowledge-ai.ts";
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
  excerptMaxChars?: number;
  snippetOnly?: boolean;
  accept: (noteId: string) => Promise<boolean>;
}) {
  const hits = new Map<string, KnowledgeSourceHit>();
  if (!input.workspaceIds.length) return { hits: [], degraded: false };
  const excerptCap = Math.min(2000, Math.max(40, input.excerptMaxChars ?? 360));

  const take = async (hit: KnowledgeSourceHit) => {
    if (input.notebookId && hit.notebookId !== input.notebookId) return;
    if (!(await input.accept(hit.noteId))) return;
    const old = hits.get(hit.noteId);
    if (!old || hit.score > old.score) hits.set(hit.noteId, { ...hit, excerpt: hit.excerpt.slice(0, excerptCap) });
  };

  if (input.mode !== "semantic") {
    const rows = await db.select({
      id: notes.id, title: notes.title, bodyMd: notes.bodyMd, tags: notes.tags,
      workspaceId: notes.workspaceId, notebookId: notes.notebookId, folderId: notes.folderId,
      version: notes.version, updatedAt: notes.updatedAt,
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
      await take({
        noteId: n.id,
        title: n.title,
        workspaceId: n.workspaceId,
        notebookId: n.notebookId,
        folderId: n.folderId,
        version: n.version,
        updatedAt: n.updatedAt,
        excerpt: snippetAround(n.bodyMd, parts),
        score: 1 / (60 + rank++),
      });
    }
  }

  let degraded = false;
  if (input.mode !== "keyword") {
    for (const workspaceId of input.workspaceIds) {
      try {
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
          await take({ ...r, title: n.title, excerpt: r.excerpt, score: 1 + r.score });
        }
      } catch (e) {
        // hybrid 已经在上面跑过关键词；这里 retrieve 走的是 semantic，失败就丢掉向量支。
        if (input.mode === "semantic" || !(e instanceof AppError) || e.code !== "AI_PROVIDER_ERROR") throw e;
        degraded = true;
        console.warn("MCP 语义检索失败，已用关键词结果：", e.message);
      }
    }
  }

  const sorted = [...hits.values()].sort((a, b) => b.score - a.score).slice(0, input.limit);
  const pathRows = sorted.map(h => ({ id: h.noteId, title: h.title, notebookId: h.notebookId, folderId: h.folderId }));
  const paths = await buildNotePaths(input.workspaceIds, pathRows);
  return {
    hits: sorted.map(h => {
      const src = toMcpSource(h, paths.get(h.noteId) ?? [h.title], excerptCap);
      if (input.snippetOnly) {
        const { excerpt: _drop, ...rest } = src;
        return rest;
      }
      return src;
    }),
    degraded,
  };
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
