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
  // 字节数交给 PG 算。以前是把这个人所有笔记的标题和正文全查出来在 Node 里
  // Buffer.byteLength 求和——而 /me 每次打开页面都会调它，每次保存笔记、
  // 每次传附件前的 assertUserStorage 也都会调。
  const [{ bytes: noteBytesRaw }] = await db
    .select({ bytes: sql<number>`coalesce(sum(octet_length(${notes.title}) + octet_length(${notes.bodyMd})), 0)::bigint` })
    .from(notes)
    .where(and(eq(notes.createdBy, userId), isNull(notes.trashedAt)));
  const [{ bytes: attachmentBytes }] = await db.select({ bytes: sql<number>`coalesce(sum(${attachments.bytes}), 0)::bigint` }).from(attachments)
    .where(and(eq(attachments.createdBy, userId), isNull(attachments.trashedAt)));
  const noteBytes = Number(noteBytesRaw ?? 0);
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
