import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, eq, lte, sql } from "drizzle-orm";
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
  await writeFile(tmp, bytes);
  try {
    await rename(tmp, abs);
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
    if (!await exists(abs)) throw new Error(`写入 blob 失败：${abs}`);
  }
}

/**
 * 登记一份物理文件引用。相同 sha256 只落盘一次，refcount +1。
 * 先 upsert 再补写文件：release 把行删了但文件还在时，下一次 put 仍能复用。
 */
export async function putBlob(bytes: Buffer): Promise<BlobRef> {
  const sha256 = hashBytes(bytes);
  const path = blobRelPath(sha256);
  await db.insert(blobStore).values({ sha256, bytes: bytes.length, refcount: 1, path })
    .onConflictDoUpdate({ target: blobStore.sha256, set: { refcount: sql`${blobStore.refcount} + 1` } });
  await writeAtomic(absPath(path), bytes);
  return { sha256, path, bytes: bytes.length };
}

/** 再挂一条引用（圈子帖公开到广场复制附件时）。没有 blob 行则返回 false，调用方走老拷贝。 */
export async function retainBlob(sha256: string) {
  const [row] = await db.update(blobStore)
    .set({ refcount: sql`${blobStore.refcount} + 1` })
    .where(eq(blobStore.sha256, sha256))
    .returning();
  return !!row;
}

/** refcount 减到 0 就删行并试图删文件。删不掉只是留垃圾，比误删正在用的副本安全。 */
export async function releaseBlob(sha256: string) {
  const [row] = await db.update(blobStore)
    .set({ refcount: sql`${blobStore.refcount} - 1` })
    .where(eq(blobStore.sha256, sha256))
    .returning();
  if (!row || row.refcount > 0) return;
  const gone = await db.delete(blobStore)
    .where(and(eq(blobStore.sha256, sha256), lte(blobStore.refcount, 0)))
    .returning();
  if (!gone.length) return;
  await rm(absPath(row.path), { force: true }).catch(() => {});
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
