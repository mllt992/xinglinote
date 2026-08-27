import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { backgroundJobs } from "../db/schema.ts";

type DbLike = Pick<typeof db, "select" | "insert" | "update" | "delete">;

/** 已有向量的笔记保存后，要再等这么久没改动才重嵌。 */
export const INDEX_NOTE_DEBOUNCE_MS = 5 * 60 * 1000;
export type IndexState = "indexed" | "pending" | "running" | "stale" | "missing" | "failed" | "excluded";

/** Queue state wins over stored chunks; otherwise compare the latest chunk with the note edit time. */
export function classifyIndexState(input: { aiIndex: boolean; chunks: number; jobStatus?: string | null; indexedAt?: Date | string | null; updatedAt: Date | string }): IndexState {
  if (!input.aiIndex) return "excluded";
  if (input.jobStatus === "running") return "running";
  if (input.jobStatus === "pending") return "pending";
  if (input.jobStatus === "failed") return "failed";
  if (!input.chunks) return "missing";
  if (input.indexedAt && new Date(input.indexedAt).getTime() < new Date(input.updatedAt).getTime()) return "stale";
  return "indexed";
}

export function indexNoteDelayMs(opts: { immediate?: boolean; hasChunks?: boolean }) {
  if (opts.immediate || !opts.hasChunks) return 0;
  return INDEX_NOTE_DEBOUNCE_MS;
}

/** 自动任务尊重 autoEmbed；设置页手动发起的任务可以显式强制执行。 */
export function shouldRunIndexNoteJob(input: { embeddingModel?: string | null; autoEmbed?: boolean; force?: boolean }) {
  return !!input.embeddingModel && (input.force === true || input.autoEmbed !== false);
}

function pendingIndexNote(noteId: string) {
  return and(
    eq(backgroundJobs.type, "index_note"),
    eq(backgroundJobs.status, "pending"),
    sql`${backgroundJobs.payload}->>'noteId' = ${noteId}`,
  );
}

/**
 * 同一篇只留一条 pending。
 * 应用层入队（换模型、搬家、PDF 抽完）一律立刻跑；保存路径的 5 分钟防抖在触发器里。
 */
export async function enqueueIndexNote(tx: DbLike, noteId: string, opts: { force?: boolean } = {}) {
  const [pending] = await tx.select({ id: backgroundJobs.id }).from(backgroundJobs).where(pendingIndexNote(noteId)).limit(1);
  if (pending) {
    await tx.update(backgroundJobs).set({
      runAfter: new Date(),
      ...(opts.force ? { payload: { noteId, force: true } } : {}),
    }).where(eq(backgroundJobs.id, pending.id));
    return;
  }
  await tx.insert(backgroundJobs).values({
    type: "index_note",
    payload: opts.force ? { noteId, force: true } : { noteId },
    runAfter: new Date(),
  });
}

export async function cancelIndexNote(tx: DbLike, noteId: string) {
  await tx.update(backgroundJobs).set({ status: "done", finishedAt: new Date() }).where(pendingIndexNote(noteId));
}
