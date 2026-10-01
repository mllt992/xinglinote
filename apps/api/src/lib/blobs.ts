import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { blobStore } from "../db/schema.ts";
import { env } from "../env.ts";
import { blobRelPath, hashBytes, isBlobPath, storedFilePath } from "./blob-path.ts";

export { blobRelPath, hashBytes, isBlobPath, storedFilePath };
export type BlobRef = { sha256: string; path: string; bytes: number };

function absPath(rel: string) {
  return join(env.dataDir, rel.replaceAll("\\", "/"));
}

async function exists(path: string) {
  return stat(path).then(() => true, () => false);
}

/** 同内容写到同一路径是安全的；先写临时文件再 rename，避免读到半截。 */
async function writeAtomic(abs: string, bytes: Buffer) {
  await mkdir(dirname(abs), { recursive: true });
  if (await exists(abs)) return;
  const tmp = `${abs}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, abs);
  } catch {
    if (!await exists(abs)) throw new Error(`写入 blob 失败：${abs}`);
  } finally {
    await rm(tmp, { force: true });
  }
}

type BlobTransaction = Pick<typeof db, "insert" | "execute">;

/** 跨进程统一哈希锁；写入、回收、补偿必须走同一把事务锁。 */
async function lockBlob(tx: Pick<typeof db, "execute">, sha256: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`blob:${sha256}`}, 0))`);
}

/** 仅在调用方事务结束后调用，不能在持有其它连接/行锁时再借连接。 */
export async function cleanupUnreferencedBlob(sha256: string) {
  await db.transaction(async tx => {
    await lockBlob(tx, sha256);
    const [row] = await tx.select({ refcount: blobStore.refcount }).from(blobStore).where(eq(blobStore.sha256, sha256));
    // 并发上传已提交则保留；其尚未提交时本锁会等它提交/回滚后才检查。
    if (row && row.refcount > 0) return;
    await rm(absPath(blobRelPath(sha256)), { force: true });
    if (row) await tx.delete(blobStore).where(eq(blobStore.sha256, sha256));
  });
}

/** 相同内容只落盘一次。传入事务时，调用方负责回滚后的无引用物理文件清理。 */
export async function putBlob(bytes: Buffer, transaction?: BlobTransaction): Promise<BlobRef> {
  const sha256 = hashBytes(bytes);
  const path = blobRelPath(sha256);
  const write = async (tx: BlobTransaction) => {
    await lockBlob(tx, sha256);
    await tx.insert(blobStore).values({ sha256, bytes: bytes.length, refcount: 1, path })
      .onConflictDoUpdate({ target: blobStore.sha256, set: { refcount: sql`${blobStore.refcount} + 1` } });
    await writeAtomic(absPath(path), bytes);
    return { sha256, path, bytes: bytes.length };
  };
  if (transaction) return write(transaction);
  try { return await db.transaction(write); }
  catch (error) { await cleanupUnreferencedBlob(sha256); throw error; }
}

/** 再挂一条引用（圈子帖公开到广场复制附件时）。没有 blob 行则返回 false。 */
export async function retainBlob(sha256: string) {
  return db.transaction(async tx => {
    await lockBlob(tx, sha256);
    const [row] = await tx.update(blobStore)
      .set({ refcount: sql`${blobStore.refcount} + 1` })
      .where(and(eq(blobStore.sha256, sha256), gt(blobStore.refcount, 0))).returning();
    return !!row;
  });
}

/** 先提交 refcount=0 墓碑，再排他清理；删除文件后崩溃不能复活正引用。 */
export async function releaseBlob(sha256: string) {
  const unused = await db.transaction(async tx => {
    await lockBlob(tx, sha256);
    const [row] = await tx.update(blobStore)
      .set({ refcount: sql`${blobStore.refcount} - 1` })
      .where(and(eq(blobStore.sha256, sha256), gt(blobStore.refcount, 0))).returning();
    return !row || row.refcount <= 0;
  });
  if (unused) await cleanupUnreferencedBlob(sha256);
}

/**
 * 硬销毁一条附件/动态文件。
 * 走 blob 的按哈希减引用；老路径带 UUID，本来就不共享，直接 rm。
 */
export async function releaseStoredFile(input: {
  sha256: string;
  storedName: string;
  workspaceId?: string;
  postAssetId?: string;
}) {
  if (isBlobPath(input.storedName)) {
    await releaseBlob(input.sha256);
    return;
  }
  await rm(storedFilePath(env.dataDir, input), { force: true }).catch(() => {});
}

export function attachmentDiskPath(a: { storedName: string; workspaceId: string }) {
  return storedFilePath(env.dataDir, a);
}

export function postAssetDiskPath(a: { storedName: string; id: string }) {
  return storedFilePath(env.dataDir, { storedName: a.storedName, postAssetId: a.id });
}

export async function readStoredFile(input: { storedName: string; workspaceId?: string; postAssetId?: string }) {
  return readFile(storedFilePath(env.dataDir, input));
}
