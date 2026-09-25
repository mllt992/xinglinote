import { Hono } from "hono";
import { and, desc, eq, gte, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { aiProviders, aiUsage, auditLogs, instanceSettings, users, workspaceAiSettings } from "../db/schema.ts";
import { ok } from "../http.ts";
import { channelDefaultModel } from "../lib/ai.ts";
import { dayStartSql, effectiveLimit, UNLIMITED } from "../lib/ai-quota.ts";
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
});
const channelPatch = channelBody.partial().extend({ clearApiKey: z.boolean().optional() });
const limitValue = z.number().int().min(0).max(100000).nullable();

function pickDefaultModel(models: string[], wanted: string | undefined, current = "") {
  const model = wanted ?? current;
  if (model && models.includes(model)) return model;
  return models[0] ?? "";
}

async function audit(userId: string, action: string, targetId: string | null, details?: Record<string, unknown>) {
  await db.insert(auditLogs).values({ userId, actorType: "user", actorId: userId, action, targetType: targetId ? "ai_provider" : "instance", targetId, result: "ok", details: details ?? null });
}

async function readDefaultLimit() {
  const [inst] = await db.select({ limit: instanceSettings.platformAiDailyLimit }).from(instanceSettings);
  return inst?.limit ?? null;
}

adminPlatformAiRoutes.get("/admin/ai/platform", async c => {
  await instanceAdmin(c);
  const rows = await db.select().from(aiProviders).where(eq(aiProviders.platform, true)).orderBy(desc(aiProviders.platformDefault), desc(aiProviders.createdAt));
  const ids = rows.map(r => r.id);
  const usage = ids.length ? await db.select({
    providerId: aiUsage.providerId,
    today: sql<number>`count(*) filter (where ${aiUsage.createdAt} >= ${dayStartSql()})::int`,
    week: sql<number>`count(*)::int`,
  }).from(aiUsage).where(and(inArray(aiUsage.providerId, ids), gte(aiUsage.createdAt, dayStartSql(6)))).groupBy(aiUsage.providerId) : [];
  const usageById = new Map(usage.map(u => [u.providerId, u]));
  const selections = ids.length ? await db.select({ id: workspaceAiSettings.chatProviderId, n: sql<number>`count(*)::int` })
    .from(workspaceAiSettings).where(inArray(workspaceAiSettings.chatProviderId, ids)).groupBy(workspaceAiSettings.chatProviderId) : [];
  const selectedById = new Map(selections.map(s => [s.id, Number(s.n)]));
  return ok(c, {
    defaultDailyLimit: await readDefaultLimit(),
    channels: rows.map(p => ({
      id: p.id, name: p.name, baseUrl: p.baseUrl, keySuffix: keySuffix(p.apiKey),
      models: Array.isArray(p.chatModels) ? p.chatModels as string[] : [],
      defaultModel: channelDefaultModel(p), enabled: p.enabled, platformDefault: p.platformDefault,
      workspaces: selectedById.get(p.id) ?? 0,
      usageToday: Number(usageById.get(p.id)?.today ?? 0), usage7d: Number(usageById.get(p.id)?.week ?? 0),
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
  const body = z.object({ defaultDailyLimit: limitValue }).parse(await c.req.json());
  await db.insert(instanceSettings).values({ id: 1, platformAiDailyLimit: body.defaultDailyLimit })
    .onConflictDoUpdate({ target: instanceSettings.id, set: { platformAiDailyLimit: body.defaultDailyLimit } });
  await audit(u.id, "platform_ai.limit.default", null, { limit: body.defaultDailyLimit });
  return ok(c, { defaultDailyLimit: body.defaultDailyLimit });
});

/** 每人用量：今天 / 近 7 天（含今天）。默认列出近 7 天用过平台 AI 或单独设置过次数的人；带 q 时按姓名、账号、邮箱搜索所有人。 */
adminPlatformAiRoutes.get("/admin/ai/usage", async c => {
  await instanceAdmin(c);
  const q = c.req.query("q")?.trim();
  const like = q ? likeContains(q) : null;
  const defaultLimit = await readDefaultLimit();
  const usage = await db.select({
    userId: aiUsage.userId,
    today: sql<number>`count(*) filter (where ${aiUsage.createdAt} >= ${dayStartSql()})::int`,
    week: sql<number>`count(*)::int`,
    tokens: sql<number>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens}),0)::bigint`,
    lastUsedAt: sql<string>`max(${aiUsage.createdAt})`,
  }).from(aiUsage).where(and(eq(aiUsage.platform, true), gte(aiUsage.createdAt, dayStartSql(6)))).groupBy(aiUsage.userId);
  const byUser = new Map(usage.map(r => [r.userId, r]));
  const where = like
    ? or(ilike(users.displayName, like), ilike(users.handle, like), ilike(users.email, like))
    : or(isNotNull(users.platformAiDailyLimit), usage.length ? inArray(users.id, usage.map(r => r.userId)) : sql`false`);
  const people = await db.select({ id: users.id, displayName: users.displayName, handle: users.handle, email: users.email, roleInstance: users.roleInstance, limit: users.platformAiDailyLimit })
    .from(users).where(where).limit(200);
  const rows = people.map(p => {
    const u = byUser.get(p.id);
    return {
      id: p.id, displayName: p.displayName, handle: p.handle, email: p.email, admin: p.roleInstance === "admin",
      override: p.limit, effectiveLimit: effectiveLimit(p.limit, defaultLimit),
      today: Number(u?.today ?? 0), last7d: Number(u?.week ?? 0), tokens7d: Number(u?.tokens ?? 0),
      lastUsedAt: u?.lastUsedAt ? new Date(u.lastUsedAt).toISOString() : null,
    };
  }).sort((a, b) => b.today - a.today || b.last7d - a.last7d || a.displayName.localeCompare(b.displayName, "zh-CN"));
  const totals = usage.reduce((s, r) => ({ today: s.today + Number(r.today), last7d: s.last7d + Number(r.week), users: s.users + (Number(r.today) > 0 ? 1 : 0) }), { today: 0, last7d: 0, users: 0 });
  return ok(c, { defaultDailyLimit: defaultLimit, totals, users: rows });
});

adminPlatformAiRoutes.patch("/admin/users/:id/ai-limit", async c => {
  const u = await instanceAdmin(c);
  const body = z.object({ limit: z.number().int().min(UNLIMITED).max(100000).nullable() }).parse(await c.req.json());
  const [row] = await db.update(users).set({ platformAiDailyLimit: body.limit, updatedAt: new Date() }).where(eq(users.id, c.req.param("id"))).returning({ id: users.id });
  if (!row) throw fail("NOT_FOUND", "用户不存在");
  await audit(u.id, "platform_ai.limit.user", null, { userId: row.id, limit: body.limit });
  return ok(c, { limit: body.limit, effectiveLimit: effectiveLimit(body.limit, await readDefaultLimit()) });
});
