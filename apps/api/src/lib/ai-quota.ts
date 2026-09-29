import { and, eq, gte, lt, sql } from "drizzle-orm";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { aiProviders, aiUsage, instanceSettings, users } from "../db/schema.ts";

/**
 * 平台 AI 额度（issue #64，用量与渠道总额见 #68）。
 *
 * - 只统计实际用到平台渠道的请求（ai_usage.platform = true）。自己的渠道不受限。
 * - 按北京时间（UTC+8）自然日，0 点重置。渠道总额也按这个自然日，所有人合计。
 * - 调模型前只检查、不预扣。成功写入 ai_usage 才算；失败不计。
 *   并发时临界点可能多放过一两次。
 * - 一次请求同时受四道限制，任何一道到顶都拒绝：
 *   这个人今天的次数 → 这个人今天的用量（输入+输出 token）→ 这条渠道今天的次数 → 这条渠道今天的用量。
 *   个人设置为空时跟随全站默认；-1 表示这个人不限。渠道上空着表示不限。
 * - 用量行不自动删除。向量化 / 量化不走这里。
 */
export const QUOTA_TIME_ZONE = "Asia/Shanghai";
/** 个人额度里表示「不限」；空表示跟随全站默认。 */
export const UNLIMITED = -1;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function dayStartSql(daysAgo = 0) {
  return sql`(date_trunc('day', now() AT TIME ZONE ${QUOTA_TIME_ZONE}) - ${`${daysAgo} days`}::interval) AT TIME ZONE ${QUOTA_TIME_ZONE}`;
}

export function shanghaiToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: QUOTA_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function addDays(iso: string, days: number) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d!));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** 用量页的时间范围。自定义最长一年，避免一次查出过大的区间；库里的记录不删。 */
export function resolveUsageRange(input: { preset?: string | null; from?: string | null; to?: string | null }, now = new Date()) {
  const today = shanghaiToday(now);
  const preset = input.preset === "today" || input.preset === "30" || input.preset === "custom" ? input.preset : "7";
  if (preset === "today") return { preset, from: today, to: today };
  if (preset === "30") return { preset, from: addDays(today, -29), to: today };
  if (preset === "7") return { preset, from: addDays(today, -6), to: today };
  const from = input.from && DATE_RE.test(input.from) ? input.from : addDays(today, -6);
  const to = input.to && DATE_RE.test(input.to) ? input.to : today;
  if (from > to) return { preset: "custom" as const, from: to, to: from };
  if (addDays(from, 366) < to) return { preset: "custom" as const, from: addDays(to, -366), to };
  return { preset: "custom" as const, from, to };
}

export function rangeStartSql(isoDate: string) {
  return sql`${isoDate}::date AT TIME ZONE ${QUOTA_TIME_ZONE}`;
}
export function rangeEndSql(isoDate: string) {
  return sql`(${isoDate}::date + interval '1 day') AT TIME ZONE ${QUOTA_TIME_ZONE}`;
}

/** 生效的每日上限：个人优先（-1 不限），否则全站默认；null 表示不限。 */
export function effectiveLimit(userLimit: number | null | undefined, defaultLimit: number | null | undefined): number | null {
  if (userLimit === UNLIMITED) return null;
  if (typeof userLimit === "number" && userLimit >= 0) return userLimit;
  return typeof defaultLimit === "number" && defaultLimit >= 0 ? defaultLimit : null;
}

/** 渠道总额：空着不限，0 表示今天不开放这条渠道，正数是上限。 */
export function channelLimit(value: number | null | undefined): number | null {
  return typeof value === "number" && value >= 0 ? value : null;
}

export async function platformAiLimitsFor(userId: string) {
  const [[u], [inst]] = await Promise.all([
    db.select({ requests: users.platformAiDailyLimit, tokens: users.platformAiDailyTokenLimit }).from(users).where(eq(users.id, userId)),
    db.select({ requests: instanceSettings.platformAiDailyLimit, tokens: instanceSettings.platformAiDailyTokenLimit }).from(instanceSettings),
  ]);
  return {
    requests: effectiveLimit(u?.requests, inst?.requests),
    tokens: effectiveLimit(u?.tokens, inst?.tokens),
  };
}

export async function platformAiLimitFor(userId: string) {
  return (await platformAiLimitsFor(userId)).requests;
}

async function summed(where: ReturnType<typeof and>) {
  const [row] = await db.select({
    requests: sql<number>`count(*)::int`,
    tokens: sql<number>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens}), 0)::bigint`,
  }).from(aiUsage).where(where);
  return { requests: Number(row?.requests ?? 0), tokens: Number(row?.tokens ?? 0) };
}

export async function platformAiUsedToday(userId: string) {
  return (await summed(and(eq(aiUsage.userId, userId), eq(aiUsage.platform, true), gte(aiUsage.createdAt, dayStartSql())))).requests;
}

export async function platformAiQuotaStatus(userId: string) {
  const [limits, used] = await Promise.all([
    platformAiLimitsFor(userId),
    summed(and(eq(aiUsage.userId, userId), eq(aiUsage.platform, true), gte(aiUsage.createdAt, dayStartSql()))),
  ]);
  const remain = (limit: number | null, n: number) => limit === null ? null : Math.max(0, limit - n);
  return {
    limit: limits.requests,
    used: used.requests,
    remaining: remain(limits.requests, used.requests),
    tokens: { limit: limits.tokens, used: used.tokens, remaining: remain(limits.tokens, used.tokens) },
  };
}

const ownAi = "你可以在工作区的「AI 与自动化」里配置自己的 AI。";

export function quotaExceededMessage(limit: number) {
  return limit === 0
    ? `管理员还没有给你开放平台提供的 AI。${ownAi}`
    : `今天平台提供的 AI 已用满 ${limit} 次，明天 0 点（北京时间）恢复。着急的话，${ownAi}`;
}

export function tokenQuotaMessage(limit: number) {
  return limit === 0
    ? `管理员还没有给你开放平台提供的 AI 用量。${ownAi}`
    : `今天平台提供的 AI 用量已用满，明天 0 点（北京时间）恢复。着急的话，${ownAi}`;
}

export function channelQuotaMessage(kind: "requests" | "tokens") {
  return kind === "requests"
    ? `这条平台渠道今天的次数已用完，明天 0 点（北京时间）恢复。可以换一条渠道，或配置自己的 AI。`
    : `这条平台渠道今天的用量已用完，明天 0 点（北京时间）恢复。可以换一条渠道，或配置自己的 AI。`;
}

/**
 * 平台渠道调用前的检查。providerId 传了才会看这条渠道今天的总额。
 */
export async function assertPlatformAiQuota(userId: string, providerId?: string | null) {
  const limits = await platformAiLimitsFor(userId);
  const needUser = limits.requests !== null || limits.tokens !== null;
  const [channel] = providerId
    ? await db.select({ requests: aiProviders.platformDailyRequestLimit, tokens: aiProviders.platformDailyTokenLimit }).from(aiProviders).where(eq(aiProviders.id, providerId))
    : [undefined];
  const channelRequests = channelLimit(channel?.requests);
  const channelTokens = channelLimit(channel?.tokens);
  const needChannel = channelRequests !== null || channelTokens !== null;
  if (!needUser && !needChannel) return;

  const [userUsed, channelUsed] = await Promise.all([
    needUser ? summed(and(eq(aiUsage.userId, userId), eq(aiUsage.platform, true), gte(aiUsage.createdAt, dayStartSql()))) : Promise.resolve({ requests: 0, tokens: 0 }),
    needChannel && providerId ? summed(and(eq(aiUsage.providerId, providerId), eq(aiUsage.platform, true), gte(aiUsage.createdAt, dayStartSql()))) : Promise.resolve({ requests: 0, tokens: 0 }),
  ]);

  if (limits.requests !== null && (limits.requests === 0 || userUsed.requests >= limits.requests)) throw fail("AI_QUOTA_EXCEEDED", quotaExceededMessage(limits.requests));
  if (limits.tokens !== null && (limits.tokens === 0 || userUsed.tokens >= limits.tokens)) throw fail("AI_QUOTA_EXCEEDED", tokenQuotaMessage(limits.tokens));
  if (channelRequests !== null && (channelRequests === 0 || channelUsed.requests >= channelRequests)) throw fail("AI_QUOTA_EXCEEDED", channelQuotaMessage("requests"));
  if (channelTokens !== null && (channelTokens === 0 || channelUsed.tokens >= channelTokens)) throw fail("AI_QUOTA_EXCEEDED", channelQuotaMessage("tokens"));
}

export async function usageBetween(from: string, to: string, extra?: ReturnType<typeof eq>) {
  return summed(and(eq(aiUsage.platform, true), gte(aiUsage.createdAt, rangeStartSql(from)), lt(aiUsage.createdAt, rangeEndSql(to)), extra));
}
