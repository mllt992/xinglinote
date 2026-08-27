import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { backgroundJobs } from "../db/schema.ts";

type DbLike = Pick<typeof db, "select" | "insert" | "update" | "delete">;

/** 已有向量的笔记保存后，要再等这么久没改动才重嵌。 */
export const INDEX_NOTE_DEBOUNCE_MS = 5 * 60 * 1000;

export function indexNoteDelayMs(opts: { immediate?: boolean; hasChunks?: boolean }) {
  if (opts.immediate || !opts.hasChunks) return 0;
  return INDEX_NOTE_DEBOUNCE_MS;
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
export async function enqueueIndexNote(tx: DbLike, noteId: string) {
  const [pending] = await tx.select({ id: backgroundJobs.id }).from(backgroundJobs).where(pendingIndexNote(noteId)).limit(1);
  if (pending) {
    await tx.update(backgroundJobs).set({ runAfter: new Date() }).where(eq(backgroundJobs.id, pending.id));
    return;
  }
  await tx.insert(backgroundJobs).values({ type: "index_note", payload: { noteId }, runAfter: new Date() });
}

export async function cancelIndexNote(tx: DbLike, noteId: string) {
  await tx.update(backgroundJobs).set({ status: "done", finishedAt: new Date() }).where(pendingIndexNote(noteId));
}
