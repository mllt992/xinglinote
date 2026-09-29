import { Hono } from "hono";
import { and, desc, eq, gte, ilike, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { aiProviders, aiUsage, auditLogs, instanceSettings, users, workspaceAiSettings } from "../db/schema.ts";
import { ok } from "../http.ts";
import { channelDefaultModel } from "../lib/ai.ts";
import { dayStartSql, effectiveLimit, rangeEndSql, rangeStartSql, resolveUsageRange, UNLIMITED } from "../lib/ai-quota.ts";
import { likeContains } from "../lib/like.ts";
import { assertSafeOutboundUrl } from "../lib/net-guard.ts";
import { seal, suffix } from "../lib/secrets.ts";
import { currentUser } from "../lib/session.ts";

/**
 * 平台 AI（issue #64）：实例管理员在后台准备、全站用户都能用的 AI 渠道，以及每人每日次数。
 * 这里是唯一能看到平台渠道地址和密钥尾号的地方；工作区接口只返回名称和模型目录。
 */
export const adminPlatformAiRoutes = new Hono();

async function instanceAdmin(c: Parameters<typeof currentUser>[0]) {
  const user = await currentUser(c);
  if (!user) throw fail("UNAUTHENTICATED", "未登录");
  if (user.roleInstance !== "admin") throw fail("FORBIDDEN", "仅实例管理员可管理平台 AI");
  return user;
}

function keySuffix(value: string | null | undefined) { if (!value) return ""; try { return suffix(value); } catch { return ""; } }
const modelList = z.array(z.string().trim().min(1).max(200)).max(200).transform(xs => [...new Set(xs)]);
const channelBody = z.object({
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().url(),
  apiKey: z.string().max(4000).optional(),
  models: modelList.default([]),
  defaultModel: z.string().trim().max(200).optional(),
  enabled: z.boolean().default(true),
  platformDefault: z.boolean().default(false),
  /** 这条渠道每天的总额度，空着表示不限。按北京时间自然日，所有人合计。 */
  dailyRequestLimit: z.number().int().min(0).max(1_000_000).nullable().optional(),
  dailyTokenLimit: z.number().int().min(0).max(100_000_000).nullable().optional(),
});
const channelPatch = channelBody.partial().extend({ clearApiKey: z.boolean().optional() });
const limitValue = z.number().int().min(0).max(100000).nullable();
const tokenLimitValue = z.number().int().min(0).max(100_000_000).nullable();

function pickDefaultModel(models: string[], wanted: string | undefined, current = "") {
  const model = wanted ?? current;
  if (model && models.includes(model)) return model;
  return models[0] ?? "";
}

async function audit(userId: string, action: string, targetId: string | null, details?: Record<string, unknown>) {
  await db.insert(auditLogs).values({ userId, actorType: "user", actorId: userId, action, targetType: targetId ? "ai_provider" : "instance", targetId, result: "ok", details: details ?? null });
}

async function readDefaultLimits() {
  const [inst] = await db.select({ requests: instanceSettings.platformAiDailyLimit, tokens: instanceSettings.platformAiDailyTokenLimit }).from(instanceSettings);
  return { requests: inst?.requests ?? null, tokens: inst?.tokens ?? null };
}

adminPlatformAiRoutes.get("/admin/ai/platform", async c => {
  await instanceAdmin(c);
  const rows = await db.select().from(aiProviders).where(eq(aiProviders.platform, true)).orderBy(desc(aiProviders.platformDefault), desc(aiProviders.createdAt));
  const ids = rows.map(r => r.id);
  const usage = ids.length ? await db.select({
    providerId: aiUsage.providerId,
    today: sql<number>`count(*) filter (where ${aiUsage.createdAt} >= ${dayStartSql()})::int`,
    week: sql<number>`count(*)::int`,
    tokensToday: sql<number>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens}) filter (where ${aiUsage.createdAt} >= ${dayStartSql()}), 0)::bigint`,
    tokensWeek: sql<number>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens}), 0)::bigint`,
  }).from(aiUsage).where(and(inArray(aiUsage.providerId, ids), gte(aiUsage.createdAt, dayStartSql(6)))).groupBy(aiUsage.providerId) : [];
  const usageById = new Map(usage.map(u => [u.providerId, u]));
  const selections = ids.length ? await db.select({ id: workspaceAiSettings.chatProviderId, n: sql<number>`count(*)::int` })
    .from(workspaceAiSettings).where(inArray(workspaceAiSettings.chatProviderId, ids)).groupBy(workspaceAiSettings.chatProviderId) : [];
  const selectedById = new Map(selections.map(s => [s.id, Number(s.n)]));
  const defaults = await readDefaultLimits();
  return ok(c, {
    defaultDailyLimit: defaults.requests,
    defaultDailyTokenLimit: defaults.tokens,
    channels: rows.map(p => ({
      id: p.id, name: p.name, baseUrl: p.baseUrl, keySuffix: keySuffix(p.apiKey),
      models: Array.isArray(p.chatModels) ? p.chatModels as string[] : [],
      defaultModel: channelDefaultModel(p), enabled: p.enabled, platformDefault: p.platformDefault,
      dailyRequestLimit: p.platformDailyRequestLimit, dailyTokenLimit: p.platformDailyTokenLimit,
      workspaces: selectedById.get(p.id) ?? 0,
      usageToday: Number(usageById.get(p.id)?.today ?? 0), usage7d: Number(usageById.get(p.id)?.week ?? 0),
      tokensToday: Number(usageById.get(p.id)?.tokensToday ?? 0), tokens7d: Number(usageById.get(p.id)?.tokensWeek ?? 0),
      createdAt: p.createdAt.toISOString(),
    })),
  });
});

adminPlatformAiRoutes.post("/admin/ai/platform/channels", async c => {
  const u = await instanceAdmin(c);
  const body = channelBody.parse(await c.req.json());
  const baseUrl = body.baseUrl.replace(/\/$/, "");
  await assertSafeOutboundUrl(baseUrl, "AI 接口地址");
  const [first] = await db.select({ id: aiProviders.id }).from(aiProviders).where(eq(aiProviders.platform, true)).limit(1);
  // 第一条平台渠道自动成为默认，免得管理员忘了勾选导致「自动」找不到渠道。
  const makeDefault = body.platformDefault || !first;
  const row = await db.transaction(async tx => {
    if (makeDefault) await tx.update(aiProviders).set({ platformDefault: false }).where(and(eq(aiProviders.platform, true), eq(aiProviders.platformDefault, true)));
    const [p] = await tx.insert(aiProviders).values({
      workspaceId: null, workspaceIds: [], ownerUserId: null, platform: true, platformDefault: makeDefault,
      name: body.name, baseUrl, chatModel: pickDefaultModel(body.models, body.defaultModel), chatModels: body.models,
      embeddingModel: null, embeddingBaseUrl: null, embeddingApiKey: null, autoEmbed: false,
      apiKey: seal(body.apiKey ?? ""), enabled: body.enabled,
      platformDailyRequestLimit: body.dailyRequestLimit ?? null, platformDailyTokenLimit: body.dailyTokenLimit ?? null,
    }).returning();
    return p!;
  });
  await audit(u.id, "platform_ai.channel.create", row.id, { name: row.name });
  return ok(c, { id: row.id, keySuffix: keySuffix(row.apiKey), platformDefault: row.platformDefault }, 201);
});

adminPlatformAiRoutes.patch("/admin/ai/platform/channels/:id", async c => {
  const u = await instanceAdmin(c);
  const [p] = await db.select().from(aiProviders).where(and(eq(aiProviders.id, c.req.param("id")), eq(aiProviders.platform, true)));
  if (!p) throw fail("NOT_FOUND", "渠道不存在");
  const body = channelPatch.parse(await c.req.json());
  const baseUrl = (body.baseUrl ?? p.baseUrl).replace(/\/$/, "");
  if (body.baseUrl !== undefined) await assertSafeOutboundUrl(baseUrl, "AI 接口地址");
  const models = body.models ?? (Array.isArray(p.chatModels) ? p.chatModels as string[] : []);
  const enabled = body.enabled ?? p.enabled;
  const platformDefault = enabled ? (body.platformDefault ?? p.platformDefault) : false;
  const refs = await db.select().from(workspaceAiSettings).where(or(eq(workspaceAiSettings.chatProviderId, p.id), eq(workspaceAiSettings.embeddingProviderId, p.id)));
  if (!enabled && refs.some(r => r.embeddingProviderId === p.id)) throw fail("VALIDATION", "这个渠道正用于全站知识检索，请先在「AI 量化」里换一个渠道再停用");
  const removedModels = refs.filter(r => r.chatProviderId === p.id && r.chatModel && !models.includes(r.chatModel));
  const row = await db.transaction(async tx => {
    if (platformDefault && !p.platformDefault) await tx.update(aiProviders).set({ platformDefault: false }).where(and(eq(aiProviders.platform, true), eq(aiProviders.platformDefault, true)));
    const [saved] = await tx.update(aiProviders).set({
      name: body.name ?? p.name, baseUrl, chatModels: models, chatModel: pickDefaultModel(models, body.defaultModel, p.chatModel),
      apiKey: body.clearApiKey ? seal("") : body.apiKey !== undefined ? seal(body.apiKey) : p.apiKey,
      enabled, platformDefault, updatedAt: new Date(),
      platformDailyRequestLimit: body.dailyRequestLimit === undefined ? p.platformDailyRequestLimit : body.dailyRequestLimit,
      platformDailyTokenLimit: body.dailyTokenLimit === undefined ? p.platformDailyTokenLimit : body.dailyTokenLimit,
    }).where(eq(aiProviders.id, p.id)).returning();
    // 停用渠道或下架模型后，选了它的工作区回到「自动」，而不是直接不能用。
    if (!enabled) await tx.update(workspaceAiSettings).set({ chatProviderId: null, chatModel: null, updatedAt: new Date() }).where(eq(workspaceAiSettings.chatProviderId, p.id));
    else if (removedModels.length) await tx.update(workspaceAiSettings).set({ chatProviderId: null, chatModel: null, updatedAt: new Date() })
      .where(inArray(workspaceAiSettings.workspaceId, removedModels.map(r => r.workspaceId)));
    return saved!;
  });
  await audit(u.id, "platform_ai.channel.update", p.id, { name: row.name, enabled: row.enabled, platformDefault: row.platformDefault });
  return ok(c, { id: row.id, keySuffix: keySuffix(row.apiKey), enabled: row.enabled, platformDefault: row.platformDefault, resetWorkspaces: !enabled ? refs.filter(r => r.chatProviderId === p.id).length : removedModels.length });
});

adminPlatformAiRoutes.delete("/admin/ai/platform/channels/:id", async c => {
  const u = await instanceAdmin(c);
  const [p] = await db.select().from(aiProviders).where(and(eq(aiProviders.id, c.req.param("id")), eq(aiProviders.platform, true)));
  if (!p) throw fail("NOT_FOUND", "渠道不存在");
  const [embeddingRef] = await db.select({ id: workspaceAiSettings.workspaceId }).from(workspaceAiSettings).where(eq(workspaceAiSettings.embeddingProviderId, p.id)).limit(1);
  const [inst] = await db.select({ id: instanceSettings.embeddingProviderId }).from(instanceSettings);
  if (embeddingRef || inst?.id === p.id) throw fail("VALIDATION", "这个渠道正用于全站知识检索，请先在「AI 量化」里换一个渠道再删除");
  // workspace_ai_settings.chat_provider_id 是 ON DELETE SET NULL，选了它的工作区会回到「自动」。
  await db.delete(aiProviders).where(eq(aiProviders.id, p.id));
  await audit(u.id, "platform_ai.channel.delete", p.id, { name: p.name });
  return ok(c, {});
});

adminPlatformAiRoutes.patch("/admin/ai/limits", async c => {
  const u = await instanceAdmin(c);
  const body = z.object({ defaultDailyLimit: limitValue.optional(), defaultDailyTokenLimit: tokenLimitValue.optional() }).parse(await c.req.json());
  const current = await readDefaultLimits();
  const requests = body.defaultDailyLimit === undefined ? current.requests : body.defaultDailyLimit;
  const tokens = body.defaultDailyTokenLimit === undefined ? current.tokens : body.defaultDailyTokenLimit;
  await db.insert(instanceSettings).values({ id: 1, platformAiDailyLimit: requests, platformAiDailyTokenLimit: tokens })
    .onConflictDoUpdate({ target: instanceSettings.id, set: { platformAiDailyLimit: requests, platformAiDailyTokenLimit: tokens } });
  await audit(u.id, "platform_ai.limit.default", null, { requests, tokens });
  return ok(c, { defaultDailyLimit: requests, defaultDailyTokenLimit: tokens });
});

/** 用量记录不自动删除。今天和近 7 天始终返回；range 是管理员选的区间（今天 / 7 天 / 30 天 / 自定义，最长一年）。 */
adminPlatformAiRoutes.get("/admin/ai/usage", async c => {
  await instanceAdmin(c);
  const q = c.req.query("q")?.trim();
  const like = q ? likeContains(q) : null;
  const range = resolveUsageRange({ preset: c.req.query("preset"), from: c.req.query("from"), to: c.req.query("to") });
  const defaults = await readDefaultLimits();
  const inRange = and(gte(aiUsage.createdAt, rangeStartSql(range.from)), lt(aiUsage.createdAt, rangeEndSql(range.to)));
  const usage = await db.select({
    userId: aiUsage.userId,
    today: sql<number>`count(*) filter (where ${aiUsage.createdAt} >= ${dayStartSql()})::int`,
    week: sql<number>`count(*) filter (where ${aiUsage.createdAt} >= ${dayStartSql(6)})::int`,
    tokensToday: sql<number>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens}) filter (where ${aiUsage.createdAt} >= ${dayStartSql()}), 0)::bigint`,
    tokensWeek: sql<number>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens}) filter (where ${aiUsage.createdAt} >= ${dayStartSql(6)}), 0)::bigint`,
    rangeRequests: sql<number>`count(*) filter (where ${inRange})::int`,
    rangeTokens: sql<number>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens}) filter (where ${inRange}), 0)::bigint`,
    lastUsedAt: sql<string>`max(${aiUsage.createdAt})`,
  }).from(aiUsage).where(and(
    eq(aiUsage.platform, true),
    or(gte(aiUsage.createdAt, dayStartSql(6)), inRange),
  )).groupBy(aiUsage.userId);
  const byUser = new Map(usage.map(r => [r.userId, r]));
  const where = like
    ? or(ilike(users.displayName, like), ilike(users.handle, like), ilike(users.email, like))
    : or(isNotNull(users.platformAiDailyLimit), isNotNull(users.platformAiDailyTokenLimit), usage.length ? inArray(users.id, usage.map(r => r.userId)) : sql`false`);
  const people = await db.select({
    id: users.id, displayName: users.displayName, handle: users.handle, email: users.email, roleInstance: users.roleInstance,
    limit: users.platformAiDailyLimit, tokenLimit: users.platformAiDailyTokenLimit,
  }).from(users).where(where).limit(200);
  const rows = people.map(p => {
    const u = byUser.get(p.id);
    return {
      id: p.id, displayName: p.displayName, handle: p.handle, email: p.email, admin: p.roleInstance === "admin",
      override: p.limit, effectiveLimit: effectiveLimit(p.limit, defaults.requests),
      tokenOverride: p.tokenLimit, effectiveTokenLimit: effectiveLimit(p.tokenLimit, defaults.tokens),
      today: Number(u?.today ?? 0), last7d: Number(u?.week ?? 0),
      tokensToday: Number(u?.tokensToday ?? 0), tokens7d: Number(u?.tokensWeek ?? 0),
      rangeRequests: Number(u?.rangeRequests ?? 0), rangeTokens: Number(u?.rangeTokens ?? 0),
      lastUsedAt: u?.lastUsedAt ? new Date(u.lastUsedAt).toISOString() : null,
    };
  }).sort((a, b) => b.rangeRequests - a.rangeRequests || b.today - a.today || a.displayName.localeCompare(b.displayName, "zh-CN"));
  const totals = usage.reduce((s, r) => ({
    today: s.today + Number(r.today), last7d: s.last7d + Number(r.week),
    todayTokens: s.todayTokens + Number(r.tokensToday), last7dTokens: s.last7dTokens + Number(r.tokensWeek),
    rangeRequests: s.rangeRequests + Number(r.rangeRequests), rangeTokens: s.rangeTokens + Number(r.rangeTokens),
    users: s.users + (Number(r.today) > 0 ? 1 : 0),
  }), { today: 0, last7d: 0, todayTokens: 0, last7dTokens: 0, rangeRequests: 0, rangeTokens: 0, users: 0 });
  const channels = await db.select({
    id: aiUsage.providerId,
    requests: sql<number>`count(*)::int`,
    tokens: sql<number>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens}), 0)::bigint`,
  }).from(aiUsage).where(and(eq(aiUsage.platform, true), inRange, sql`${aiUsage.providerId} is not null`)).groupBy(aiUsage.providerId);
  const names = channels.length
    ? await db.select({ id: aiProviders.id, name: aiProviders.name }).from(aiProviders).where(inArray(aiProviders.id, channels.map(c => c.id).filter((id): id is string => !!id)))
    : [];
  const nameById = new Map(names.map(n => [n.id, n.name]));
  return ok(c, {
    defaultDailyLimit: defaults.requests, defaultDailyTokenLimit: defaults.tokens, range,
    totals, users: rows,
    channels: channels.map(c => ({ id: c.id, name: nameById.get(c.id ?? "") ?? "已删除的渠道", requests: Number(c.requests), tokens: Number(c.tokens) }))
      .sort((a, b) => b.requests - a.requests),
  });
});

adminPlatformAiRoutes.patch("/admin/users/:id/ai-limit", async c => {
  const u = await instanceAdmin(c);
  const body = z.object({
    limit: z.number().int().min(UNLIMITED).max(100000).nullable().optional(),
    tokenLimit: z.number().int().min(UNLIMITED).max(100_000_000).nullable().optional(),
  }).refine(v => v.limit !== undefined || v.tokenLimit !== undefined, { message: "请填写要改的额度" }).parse(await c.req.json());
  const set: { platformAiDailyLimit?: number | null; platformAiDailyTokenLimit?: number | null; updatedAt: Date } = { updatedAt: new Date() };
  if (body.limit !== undefined) set.platformAiDailyLimit = body.limit;
  if (body.tokenLimit !== undefined) set.platformAiDailyTokenLimit = body.tokenLimit;
  const [row] = await db.update(users).set(set).where(eq(users.id, c.req.param("id"))).returning({ id: users.id, limit: users.platformAiDailyLimit, tokenLimit: users.platformAiDailyTokenLimit });
  if (!row) throw fail("NOT_FOUND", "用户不存在");
  const defaults = await readDefaultLimits();
  await audit(u.id, "platform_ai.limit.user", null, { userId: row.id, limit: row.limit, tokenLimit: row.tokenLimit });
  return ok(c, {
    limit: row.limit, tokenLimit: row.tokenLimit,
    effectiveLimit: effectiveLimit(row.limit, defaults.requests),
    effectiveTokenLimit: effectiveLimit(row.tokenLimit, defaults.tokens),
  });
});
