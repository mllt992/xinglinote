import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { postAssets, posts } from "../db/schema.ts";
import { env } from "../env.ts";
import { assertAttachmentType } from "./file-type.ts";
import { assertUserStorage } from "./quota.ts";
import { assertCanSeePost } from "./post-access.ts";
import { postAssetDiskPath, putBlob, readStoredFile, releaseBlob, releaseStoredFile, retainBlob } from "./blobs.ts";
import { hashBytes, isBlobPath } from "./blob-path.ts";

export const POST_ASSET_MAX = 9;
const IMAGE_MAX = 5 * 1024 * 1024;
const VIDEO_MAX = 50 * 1024 * 1024;
const FILE_MAX = 25 * 1024 * 1024;

export type PostAssetRow = typeof postAssets.$inferSelect;

export function assetKind(mime: string): "image" | "video" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

export function assetDto(a: PostAssetRow) {
  return { id: a.id, filename: a.filename, mime: a.mime, bytes: a.bytes, kind: assetKind(a.mime), url: `/api/v1/posts/attachments/${a.id}` };
}

function byteLimit(mime: string) {
  if (mime.startsWith("image/")) return IMAGE_MAX;
  if (mime.startsWith("video/")) return VIDEO_MAX;
  return FILE_MAX;
}

function safeName(name: string) {
  const base = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
  return `${crypto.randomUUID()}-${base}`;
}

/** 超过 24 小时还没发出去的暂存清掉，免得配额被草稿占着。 */
export async function sweepStalePostAssets(userId: string) {
  const cutoff = new Date(Date.now() - 24 * 86_400_000);
  const stale = await db.select().from(postAssets).where(and(
    eq(postAssets.createdBy, userId), isNull(postAssets.postId), isNull(postAssets.trashedAt), lt(postAssets.createdAt, cutoff),
  ));
  for (const a of stale) await trashAsset(a, true);
}

type UploadFile = { name: string; size: number; type: string; arrayBuffer(): Promise<ArrayBuffer> };

export async function savePostAsset(input: { userId: string; file: UploadFile }) {
  const { userId, file } = input;
  if (file.size <= 0) throw fail("VALIDATION", "空文件");
  const limit = byteLimit(file.type);
  if (file.size > limit) throw fail("QUOTA", `${assetKind(file.type) === "image" ? "图片" : assetKind(file.type) === "video" ? "视频" : "文件"}不能超过 ${Math.round(limit / 1024 / 1024)}MB`);
  await sweepStalePostAssets(userId);
  const pending = await db.select({ id: postAssets.id }).from(postAssets).where(and(
    eq(postAssets.createdBy, userId), isNull(postAssets.postId), isNull(postAssets.trashedAt),
  ));
  if (pending.length >= POST_ASSET_MAX) throw fail("VALIDATION", `一条动态最多 ${POST_ASSET_MAX} 个附件`);
  await assertUserStorage(userId, file.size);
  const bytes = Buffer.from(await file.arrayBuffer());
  const mime = assertAttachmentType(file.type, bytes);
  const sha = hashBytes(bytes);
  const blob = await putBlob(bytes);
  try {
    const [row] = await db.insert(postAssets).values({
      postId: null, filename: file.name || "file", storedName: blob.path, mime, bytes: file.size, sha256: sha, createdBy: userId,
    }).returning();
    return row;
  } catch (e) {
    await releaseBlob(blob.sha256);
    throw e;
  }
}

export async function bindPostAssets(postId: string, userId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length > POST_ASSET_MAX) throw fail("VALIDATION", `一条动态最多 ${POST_ASSET_MAX} 个附件`);
  if (!unique.length) return [];
  const rows = await db.select().from(postAssets).where(and(inArray(postAssets.id, unique), isNull(postAssets.trashedAt)));
  if (rows.length !== unique.length) throw fail("VALIDATION", "有的附件不存在或已删除");
  for (const a of rows) {
    if (a.createdBy !== userId) throw fail("FORBIDDEN", "不能使用别人的附件");
    if (a.postId && a.postId !== postId) throw fail("VALIDATION", "这个附件已经挂在别的动态上");
  }
  await db.update(postAssets).set({ postId }).where(inArray(postAssets.id, unique));
  return rows;
}

export async function listPostAssets(postIds: string[]) {
  if (!postIds.length) return [] as PostAssetRow[];
  return db.select().from(postAssets).where(and(inArray(postAssets.postId, postIds), isNull(postAssets.trashedAt)));
}

export async function readPostAsset(id: string, viewerId?: string) {
  const [a] = await db.select().from(postAssets).where(eq(postAssets.id, id));
  if (!a || a.trashedAt) throw fail("NOT_FOUND", "附件不存在");
  if (!a.postId) {
    if (a.createdBy !== viewerId) throw fail("NOT_FOUND", "附件不存在");
  } else {
    const [post] = await db.select().from(posts).where(eq(posts.id, a.postId));
    await assertCanSeePost(post, viewerId);
  }
  return { asset: a, data: await readStoredFile({ storedName: a.storedName, postAssetId: a.id }) };
}

export async function removeStagedAsset(id: string, userId: string) {
  const [a] = await db.select().from(postAssets).where(eq(postAssets.id, id));
  if (!a || a.trashedAt) throw fail("NOT_FOUND", "附件不存在");
  if (a.createdBy !== userId) throw fail("FORBIDDEN", "无权删除");
  if (a.postId) throw fail("VALIDATION", "已经发出去的附件不能单独删，请删整条动态");
  await trashAsset(a, true);
}

export async function trashPostAssets(postId: string) {
  const rows = await db.select().from(postAssets).where(and(eq(postAssets.postId, postId), isNull(postAssets.trashedAt)));
  for (const a of rows) await trashAsset(a, false);
}

async function trashAsset(a: PostAssetRow, unlinkFile: boolean) {
  await db.update(postAssets).set({ trashedAt: new Date() }).where(eq(postAssets.id, a.id));
  if (unlinkFile) await releaseStoredFile({ sha256: a.sha256, storedName: a.storedName, postAssetId: a.id });
}

/** 圈子公开到广场：附件复制一份逻辑行。物理文件走 blob 引用，老路径才真拷。 */
export async function copyPostAssets(fromPostId: string, toPostId: string, userId: string) {
  const rows = await listPostAssets([fromPostId]);
  for (const a of rows) {
    if (isBlobPath(a.storedName) && await retainBlob(a.sha256)) {
      await db.insert(postAssets).values({
        postId: toPostId, filename: a.filename, storedName: a.storedName, mime: a.mime, bytes: a.bytes, sha256: a.sha256, createdBy: userId,
      });
      continue;
    }
    const stored = safeName(a.filename);
    const [copy] = await db.insert(postAssets).values({
      postId: toPostId, filename: a.filename, storedName: stored, mime: a.mime, bytes: a.bytes, sha256: a.sha256, createdBy: userId,
    }).returning();
    await mkdir(join(env.dataDir, "feed", copy.id), { recursive: true });
    await copyFile(postAssetDiskPath(a), join(env.dataDir, "feed", copy.id, stored));
  }
}
