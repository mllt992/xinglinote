import { and, eq, gte, sql } from "drizzle-orm";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { aiUsage, instanceSettings, users } from "../db/schema.ts";

/**
 * 平台 AI 的每人每日额度（issue #64）。
 *
 * - 只统计实际用到平台渠道的请求（ai_usage.platform = true），自己配的渠道不受限。
 * - 按北京时间（UTC+8）自然日计算，零点重置。
 * - 调模型前只检查、不预扣；成功后写 ai_usage 才算一次，失败的请求不占次数。
 *   并发请求可能在临界点多放过一两次，换来的是不用在每个入口加锁。
 * - 向量化 / 量化是后台任务，不走这里，也不计次数。
 */
export const QUOTA_TIME_ZONE = "Asia/Shanghai";
/** users.platform_ai_daily_limit 里表示「这个人不限」的值；null 表示跟随全站默认。 */
export const UNLIMITED = -1;

export function dayStartSql(daysAgo = 0) {
  return sql`(date_trunc('day', now() AT TIME ZONE ${QUOTA_TIME_ZONE}) - ${`${daysAgo} days`}::interval) AT TIME ZONE ${QUOTA_TIME_ZONE}`;
}

/** 生效的每日次数：个人设置优先（-1 为不限），否则用全站默认；null 表示不限。 */
export function effectiveLimit(userLimit: number | null | undefined, defaultLimit: number | null | undefined): number | null {
  if (userLimit === UNLIMITED) return null;
  if (typeof userLimit === "number" && userLimit >= 0) return userLimit;
  return typeof defaultLimit === "number" && defaultLimit >= 0 ? defaultLimit : null;
}

export async function platformAiLimitFor(userId: string) {
  const [[u], [inst]] = await Promise.all([
    db.select({ limit: users.platformAiDailyLimit }).from(users).where(eq(users.id, userId)),
    db.select({ limit: instanceSettings.platformAiDailyLimit }).from(instanceSettings),
  ]);
  return effectiveLimit(u?.limit, inst?.limit);
}

export async function platformAiUsedToday(userId: string) {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(aiUsage)
    .where(and(eq(aiUsage.userId, userId), eq(aiUsage.platform, true), gte(aiUsage.createdAt, dayStartSql())));
  return Number(row?.n ?? 0);
}

export async function platformAiQuotaStatus(userId: string) {
  const [limit, used] = await Promise.all([platformAiLimitFor(userId), platformAiUsedToday(userId)]);
  return { limit, used, remaining: limit === null ? null : Math.max(0, limit - used) };
}

export function quotaExceededMessage(limit: number) {
  return limit === 0
    ? "管理员还没有给你开放平台提供的 AI。你可以在工作区的「AI 与自动化」里配置自己的 AI。"
    : `今天平台提供的 AI 已用满 ${limit} 次，明天 0 点（北京时间）恢复。着急的话，可以在工作区的「AI 与自动化」里配置自己的 AI。`;
}

export async function assertPlatformAiQuota(userId: string) {
  const limit = await platformAiLimitFor(userId);
  if (limit === null) return;
  const used = limit === 0 ? 0 : await platformAiUsedToday(userId);
  if (limit === 0 || used >= limit) throw fail("AI_QUOTA_EXCEEDED", quotaExceededMessage(limit));
}
