import { and, count, desc, eq, gte, inArray } from "drizzle-orm";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { auditLogs, instanceSettings, notifications, serviceRequests, users } from "../db/schema.ts";
import { assertQuotaBytes, formatBytes, userStorage, type StorageUsage } from "./quota.ts";

export const SERVICE_KINDS = ["storage"] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

const DAY_MS = 86_400_000;
const MAX_REQUESTS_PER_DAY = 3;

export type ServiceRequestRow = typeof serviceRequests.$inferSelect;

export function publicRequest(row: ServiceRequestRow) {
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    requestedBytes: row.requestedBytes,
    currentQuotaBytes: row.currentQuotaBytes,
    usedBytes: row.usedBytes,
    reason: row.reason,
    status: row.status,
    adminNote: row.adminNote,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    grantedQuotaBytes: row.grantedQuotaBytes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function storagePolicy() {
  const [settings] = await db.select({
    allow: instanceSettings.allowStorageRequests,
    defaultQuota: instanceSettings.defaultUserStorageBytes,
  }).from(instanceSettings);
  return { allow: settings?.allow !== false, defaultQuota: settings?.defaultQuota ?? 1_073_741_824 };
}

async function notifyAdmins(exceptUserId: string, title: string, body: string, href: string) {
  const admins = await db.select({ id: users.id }).from(users).where(and(eq(users.roleInstance, "admin"), eq(users.status, "active")));
  const ids = admins.map(a => a.id).filter(id => id !== exceptUserId);
  if (!ids.length) return;
  await db.insert(notifications).values(ids.map(userId => ({ userId, type: "service_request", title, body, href })));
}

async function notifyUser(userId: string, title: string, body: string, href: string) {
  await db.insert(notifications).values({ userId, type: "service_request_decided", title, body, href });
}

export async function submitStorageRequest(user: { id: string; status: string; displayName: string; handle: string }, requestedBytes: number, reason: string | null) {
  if (user.status !== "active") throw fail("FORBIDDEN", "当前账号状态不能申请服务");
  const policy = await storagePolicy();
  if (!policy.allow) throw fail("FORBIDDEN", "本实例暂不接受在线申请，请联系管理员");
  assertQuotaBytes(requestedBytes);
  const usage = await userStorage(user.id);
  if (requestedBytes <= usage.quotaBytes) throw fail("VALIDATION", `申请量须大于当前配额 ${formatBytes(usage.quotaBytes)}`);

  const [pending] = await db.select({ id: serviceRequests.id }).from(serviceRequests)
    .where(and(eq(serviceRequests.userId, user.id), eq(serviceRequests.kind, "storage"), eq(serviceRequests.status, "pending")))
    .limit(1);
  if (pending) throw fail("VALIDATION", "你已有一条待审批的申请，请等待处理或先取消");

  const since = new Date(Date.now() - DAY_MS);
  const [{ value: recent }] = await db.select({ value: count() }).from(serviceRequests)
    .where(and(eq(serviceRequests.userId, user.id), eq(serviceRequests.kind, "storage"), gte(serviceRequests.createdAt, since)));
  if (Number(recent) >= MAX_REQUESTS_PER_DAY) throw fail("RATE_LIMIT", "24 小时内最多提交 3 条申请");

  const [row] = await db.insert(serviceRequests).values({
    userId: user.id,
    kind: "storage",
    requestedBytes,
    currentQuotaBytes: usage.quotaBytes,
    usedBytes: usage.usedBytes,
    reason,
  }).returning();
  await db.insert(auditLogs).values({
    userId: user.id, actorType: "user", actorId: user.id, action: "service_request.submit",
    targetType: "service_request", targetId: row.id, result: "ok",
    details: { kind: "storage", requestedBytes, currentQuotaBytes: usage.quotaBytes },
  });
  await notifyAdmins(user.id, `${user.displayName} 申请扩容到 ${formatBytes(requestedBytes)}`,
    reason ? `当前 ${formatBytes(usage.quotaBytes)}，已用 ${formatBytes(usage.usedBytes)}。${reason}` : `当前 ${formatBytes(usage.quotaBytes)}，已用 ${formatBytes(usage.usedBytes)}。`,
    "/admin?tab=requests");
  return row;
}

export async function cancelOwnRequest(userId: string, id: string) {
  const [row] = await db.select().from(serviceRequests).where(eq(serviceRequests.id, id));
  if (!row || row.userId !== userId) throw fail("NOT_FOUND", "申请不存在");
  if (row.status !== "pending") throw fail("VALIDATION", "只能取消待审批的申请");
  const now = new Date();
  const [saved] = await db.update(serviceRequests).set({
    status: "cancelled", decidedBy: userId, decidedAt: now, updatedAt: now,
  }).where(eq(serviceRequests.id, id)).returning();
  await db.insert(auditLogs).values({
    userId, actorType: "user", actorId: userId, action: "service_request.cancel",
    targetType: "service_request", targetId: id, result: "ok",
  });
  return saved;
}

export async function decideRequest(actor: { id: string }, id: string, decision: "approved" | "rejected", grantedQuotaBytes: number | undefined, adminNote: string | null) {
  const [row] = await db.select().from(serviceRequests).where(eq(serviceRequests.id, id));
  if (!row) throw fail("NOT_FOUND", "申请不存在");
  if (row.status !== "pending") throw fail("VALIDATION", "这条申请已经处理过了");
  const now = new Date();
  if (decision === "rejected") {
    const [saved] = await db.update(serviceRequests).set({
      status: "rejected", adminNote, decidedBy: actor.id, decidedAt: now, updatedAt: now,
    }).where(eq(serviceRequests.id, id)).returning();
    await db.insert(auditLogs).values({
      userId: actor.id, actorType: "user", actorId: actor.id, action: "service_request.reject",
      targetType: "service_request", targetId: id, result: "ok", details: { adminNote },
    });
    await notifyUser(row.userId, "存储扩容未通过", adminNote || "管理员未通过这次申请。你可以改一改再提，或直接联系管理员。", "/settings/account");
    return saved;
  }
  const granted = assertQuotaBytes(grantedQuotaBytes ?? row.requestedBytes ?? 0);
  await db.update(users).set({ storageQuotaBytes: granted, updatedAt: now }).where(eq(users.id, row.userId));
  const [saved] = await db.update(serviceRequests).set({
    status: "approved", adminNote, decidedBy: actor.id, decidedAt: now, grantedQuotaBytes: granted, updatedAt: now,
  }).where(eq(serviceRequests.id, id)).returning();
  await db.insert(auditLogs).values({
    userId: actor.id, actorType: "user", actorId: actor.id, action: "service_request.approve",
    targetType: "service_request", targetId: id, result: "ok",
    details: { grantedQuotaBytes: granted, userId: row.userId },
  });
  await notifyUser(row.userId, `存储配额已调整为 ${formatBytes(granted)}`, adminNote || "管理员通过了你的扩容申请。", "/settings/account");
  return saved;
}

/** 管理员直接改配额。newQuota=null 表示恢复跟随实例默认。 */
export async function assignStorage(actor: { id: string }, userId: string, newQuota: number | null) {
  const [target] = await db.select({ id: users.id, status: users.status, storageQuotaBytes: users.storageQuotaBytes }).from(users).where(eq(users.id, userId));
  if (!target) throw fail("NOT_FOUND", "用户不存在");
  if (target.status === "deleted") throw fail("FORBIDDEN", "已注销的账号不能改配额");
  if (newQuota != null) assertQuotaBytes(newQuota);
  const now = new Date();
  await db.update(users).set({ storageQuotaBytes: newQuota, updatedAt: now }).where(eq(users.id, userId));
  const usage = await userStorage(userId);
  await db.insert(auditLogs).values({
    userId: actor.id, actorType: "user", actorId: actor.id, action: "user.storage_grant",
    targetType: "user", targetId: userId, result: "ok",
    details: { from: target.storageQuotaBytes, to: newQuota, effective: usage.quotaBytes },
  });
  const pending = await db.select().from(serviceRequests)
    .where(and(eq(serviceRequests.userId, userId), eq(serviceRequests.kind, "storage"), eq(serviceRequests.status, "pending")));
  const auto: string[] = [];
  for (const req of pending) {
    if (req.requestedBytes != null && usage.quotaBytes >= req.requestedBytes) {
      await db.update(serviceRequests).set({
        status: "approved", decidedBy: actor.id, decidedAt: now, grantedQuotaBytes: usage.quotaBytes,
        adminNote: req.adminNote ?? "管理员已直接调整配额", updatedAt: now,
      }).where(eq(serviceRequests.id, req.id));
      auto.push(req.id);
    }
  }
  const label = newQuota == null ? `已恢复跟随实例默认（${formatBytes(usage.quotaBytes)}）` : `存储配额已调整为 ${formatBytes(usage.quotaBytes)}`;
  await notifyUser(userId, label, auto.length ? "你提交的扩容申请已一并结案。" : "管理员调整了你的存储配额。", "/settings/account");
  return { usage, autoApproved: auto };
}

export async function listOwnRequests(userId: string) {
  return db.select().from(serviceRequests).where(eq(serviceRequests.userId, userId)).orderBy(desc(serviceRequests.createdAt)).limit(50);
}

export async function pendingOf(userIds: string[]) {
  if (!userIds.length) return [];
  return db.select().from(serviceRequests).where(and(
    inArray(serviceRequests.userId, userIds),
    eq(serviceRequests.status, "pending"),
    eq(serviceRequests.kind, "storage"),
  ));
}

export function storageDto(usage: StorageUsage) {
  const { usedBytes, quotaBytes, remainingBytes, noteBytes, attachmentBytes, quotaOverride, defaultQuotaBytes } = usage;
  return { usedBytes, quotaBytes, remainingBytes, noteBytes, attachmentBytes, quotaOverride, defaultQuotaBytes };
}
