import { and, eq, isNull, sql } from "drizzle-orm";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { attachments, instanceSettings, notes, users } from "../db/schema.ts";

export function textBytes(title: string, body: string) {
  return Buffer.byteLength(title, "utf8") + Buffer.byteLength(body, "utf8");
}

export async function userStorage(userId: string) {
  const [user] = await db.select({ quota: users.storageQuotaBytes }).from(users).where(eq(users.id, userId));
  if (!user) throw fail("NOT_FOUND", "用户不存在");
  const [settings] = await db.select({ defaultQuota: instanceSettings.defaultUserStorageBytes }).from(instanceSettings);
  const ownedNotes = await db.select({ title: notes.title, body: notes.bodyMd }).from(notes)
    .where(and(eq(notes.createdBy, userId), isNull(notes.trashedAt)));
  const [{ bytes: attachmentBytes }] = await db.select({ bytes: sql<number>`coalesce(sum(${attachments.bytes}), 0)::bigint` }).from(attachments)
    .where(and(eq(attachments.createdBy, userId), isNull(attachments.trashedAt)));
  const noteBytes = ownedNotes.reduce((sum, n) => sum + textBytes(n.title, n.body), 0);
  const usedBytes = noteBytes + Number(attachmentBytes ?? 0);
  const quotaBytes = user.quota ?? settings?.defaultQuota ?? 1073741824;
  return { usedBytes, quotaBytes, remainingBytes: Math.max(0, quotaBytes - usedBytes), noteBytes, attachmentBytes: Number(attachmentBytes ?? 0) };
}

export async function assertUserStorage(userId: string, additionalBytes: number) {
  if (additionalBytes <= 0) return userStorage(userId);
  const usage = await userStorage(userId);
  if (usage.usedBytes + additionalBytes > usage.quotaBytes) {
    throw fail("QUOTA", `存储空间不足：还剩 ${formatBytes(usage.remainingBytes)}，本次需要 ${formatBytes(additionalBytes)}`);
  }
  return usage;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
