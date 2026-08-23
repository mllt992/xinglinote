import { and, inArray, isNull, sql } from "drizzle-orm";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { attachments, instanceSettings, notes, postAssets, users } from "../db/schema.ts";

export const MIN_QUOTA_BYTES = 1_048_576;
export const MAX_QUOTA_BYTES = 1_099_511_627_776;
export const DEFAULT_QUOTA_BYTES = 1_073_741_824;

export type StorageUsage = {
  usedBytes: number;
  quotaBytes: number;
  remainingBytes: number;
  noteBytes: number;
  attachmentBytes: number;
  quotaOverride: boolean;
  defaultQuotaBytes: number;
};

export function textBytes(title: string, body: string) {
  return Buffer.byteLength(title, "utf8") + Buffer.byteLength(body, "utf8");
}

async function defaultQuota() {
  const [settings] = await db.select({ defaultQuota: instanceSettings.defaultUserStorageBytes }).from(instanceSettings);
  return settings?.defaultQuota ?? DEFAULT_QUOTA_BYTES;
}

function pack(used: { noteBytes: number; attachmentBytes: number }, quota: number | null | undefined, fallback: number): StorageUsage {
  const noteBytes = used.noteBytes;
  const attachmentBytes = used.attachmentBytes;
  const usedBytes = noteBytes + attachmentBytes;
  const quotaBytes = quota ?? fallback;
  return {
    usedBytes,
    quotaBytes,
    remainingBytes: Math.max(0, quotaBytes - usedBytes),
    noteBytes,
    attachmentBytes,
    quotaOverride: quota != null,
    defaultQuotaBytes: fallback,
  };
}

export async function userStorage(userId: string): Promise<StorageUsage> {
  const map = await userStorageMany([userId]);
  const usage = map.get(userId);
  if (!usage) throw fail("NOT_FOUND", "用户不存在");
  return usage;
}

/** 列表页一次算完一页人的用量，避免 20 次 userStorage。 */
export async function userStorageMany(userIds: string[]): Promise<Map<string, StorageUsage>> {
  const out = new Map<string, StorageUsage>();
  if (!userIds.length) return out;
  const fallback = await defaultQuota();
  const rows = await db.select({ id: users.id, quota: users.storageQuotaBytes }).from(users).where(inArray(users.id, userIds));
  const noteRows = await db
    .select({
      userId: notes.createdBy,
      bytes: sql<number>`coalesce(sum(octet_length(${notes.title}) + octet_length(${notes.bodyMd})), 0)::bigint`,
    })
    .from(notes)
    .where(and(inArray(notes.createdBy, userIds), isNull(notes.trashedAt)))
    .groupBy(notes.createdBy);
  const fileRows = await db
    .select({
      userId: attachments.createdBy,
      bytes: sql<number>`coalesce(sum(${attachments.bytes}), 0)::bigint`,
    })
    .from(attachments)
    .where(and(inArray(attachments.createdBy, userIds), isNull(attachments.trashedAt)))
    .groupBy(attachments.createdBy);
  const postRows = await db
    .select({
      userId: postAssets.createdBy,
      bytes: sql<number>`coalesce(sum(${postAssets.bytes}), 0)::bigint`,
    })
    .from(postAssets)
    .where(and(inArray(postAssets.createdBy, userIds), isNull(postAssets.trashedAt)))
    .groupBy(postAssets.createdBy);
  const notesBy = new Map(noteRows.map(r => [r.userId, Number(r.bytes ?? 0)]));
  const filesBy = new Map(fileRows.map(r => [r.userId, Number(r.bytes ?? 0)]));
  const postsBy = new Map(postRows.map(r => [r.userId, Number(r.bytes ?? 0)]));
  for (const row of rows) {
    out.set(row.id, pack({
      noteBytes: notesBy.get(row.id) ?? 0,
      attachmentBytes: (filesBy.get(row.id) ?? 0) + (postsBy.get(row.id) ?? 0),
    }, row.quota, fallback));
  }
  return out;
}

export async function assertUserStorage(userId: string, additionalBytes: number) {
  if (additionalBytes <= 0) return userStorage(userId);
  const usage = await userStorage(userId);
  if (usage.usedBytes + additionalBytes > usage.quotaBytes) {
    throw fail("QUOTA", `存储空间不足：还剩 ${formatBytes(usage.remainingBytes)}，本次需要 ${formatBytes(additionalBytes)}。可到「存储与服务」申请扩容`);
  }
  return usage;
}

export function assertQuotaBytes(bytes: number) {
  if (!Number.isInteger(bytes) || bytes < MIN_QUOTA_BYTES || bytes > MAX_QUOTA_BYTES) {
    throw fail("VALIDATION", `配额须在 ${formatBytes(MIN_QUOTA_BYTES)} 到 ${formatBytes(MAX_QUOTA_BYTES)} 之间`);
  }
  return bytes;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
