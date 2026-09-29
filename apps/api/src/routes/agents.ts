import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { agents, aiProviders, aiUsage, blobStore, workspaces } from "../db/schema.ts";
import { env } from "../env.ts";
import { ok } from "../http.ts";
import { adminAgent, assertAgentHandle, listPublicAgents, publicAgent, resolveAgentModel, sealAgentKey } from "../lib/agents.ts";
import { chatAi, usageMeta } from "../lib/ai.ts";
import { assertPlatformAiQuota } from "../lib/ai-quota.ts";
import { putBlob, releaseBlob } from "../lib/blobs.ts";
import { assertAttachmentType } from "../lib/file-type.ts";
import { assertSafeOutboundUrl } from "../lib/net-guard.ts";
import { limit } from "../lib/rate-limit.ts";
import { currentUser } from "../lib/session.ts";
import { sanitizeAgentReply } from "../lib/agents-text.ts";

export const agentRoutes = new Hono();

async function admin(c: Parameters<typeof currentUser>[0]) {
  const u = await currentUser(c);
  if (!u) throw fail("UNAUTHENTICATED", "未登录");
  if (u.roleInstance !== "admin") throw fail("FORBIDDEN", "仅实例管理员可操作");
  return u;
}

const upsert = z.object({
  handle: z.string().min(3).max(32),
  displayName: z.string().trim().min(1).max(40),
  bio: z.string().max(200).nullable().optional(),
  avatarEmoji: z.string().trim().min(1).max(16).optional(),
  avatarSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  avatarMime: z.string().max(40).nullable().optional(),
  systemPrompt: z.string().trim().min(1).max(4000),
  enabled: z.boolean().optional(),
  allowSquare: z.boolean().optional(),
  allowCircle: z.boolean().optional(),
  knowledgeEnabled: z.boolean().optional(),
  /** own 自己的接口；platform 平台渠道；auto 回复时按工作区规则选择。 */
  aiSource: z.enum(["own", "platform", "auto"]).default("own"),
  providerId: z.string().uuid().nullable().optional(),
  baseUrl: z.string().max(500).optional(),
  chatModel: z.string().trim().max(120).optional(),
  apiKey: z.string().max(400).optional(),
});


async function withProviders(rows: Array<typeof agents.$inferSelect>) {
  const ids = [...new Set(rows.map(r => r.providerId).filter((id): id is string => !!id))];
  const found = ids.length ? await db.select({ id: aiProviders.id, name: aiProviders.name }).from(aiProviders).where(inArray(aiProviders.id, ids)) : [];
  const byId = new Map(found.map(p => [p.id, p]));
  return rows.map(r => adminAgent(r, r.providerId ? byId.get(r.providerId) ?? null : null));
}

/** 按来源整理要写入的连接信息。平台渠道和自动都不保存地址和密钥。 */
async function modelValues(body: { aiSource?: "own" | "platform" | "auto"; providerId?: string | null; baseUrl?: string; chatModel?: string; apiKey?: string }, current?: typeof agents.$inferSelect) {
  const source = body.aiSource ?? current?.aiSource ?? "own";
  if (source === "platform") {
    const providerId = body.providerId === undefined ? current?.providerId : body.providerId;
    if (!providerId) throw fail("VALIDATION", "请选择一条平台渠道");
    const [p] = await db.select().from(aiProviders).where(and(eq(aiProviders.id, providerId), eq(aiProviders.platform, true), eq(aiProviders.enabled, true)));
    if (!p) throw fail("VALIDATION", "这条平台渠道不可用");
    const models = Array.isArray(p.chatModels) ? p.chatModels.filter((m): m is string => typeof m === "string") : [];
    const chatModel = (body.chatModel ?? current?.chatModel ?? "").trim();
    if (!chatModel || !models.includes(chatModel)) throw fail("VALIDATION", "请从平台提供的模型里选择");
    return { aiSource: "platform" as const, providerId: p.id, baseUrl: "", chatModel, apiKey: current?.apiKey ?? sealAgentKey("") };
  }
  if (source === "auto") return { aiSource: "auto" as const, providerId: null, baseUrl: "", chatModel: "", apiKey: current?.apiKey ?? sealAgentKey("") };
  const baseUrl = (body.baseUrl ?? current?.baseUrl ?? "").trim().replace(/\/$/, "");
  const chatModel = (body.chatModel ?? current?.chatModel ?? "").trim();
  if (!baseUrl || !chatModel) throw fail("VALIDATION", "请填写接口地址和模型名");
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw fail("VALIDATION", "接口地址不正确"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw fail("VALIDATION", "接口地址不正确");
  await assertSafeOutboundUrl(baseUrl, "智能体模型地址");
  const apiKey = body.apiKey?.trim() && !body.apiKey.startsWith("••") ? sealAgentKey(body.apiKey) : current?.apiKey;
  if (!apiKey) throw fail("VALIDATION", "请填写密钥");
  return { aiSource: "own" as const, providerId: null, baseUrl, chatModel, apiKey };
}

const AVATAR_MAX = 1024 * 1024;
const AVATAR_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

async function attachAvatar(sha256: string | null | undefined, mime: string | null | undefined) {
  if (!sha256) return { avatarSha256: null, avatarMime: null };
  const [blob] = await db.select().from(blobStore).where(eq(blobStore.sha256, sha256));
  if (!blob) throw fail("VALIDATION", "请先上传头像");
  return { avatarSha256: sha256, avatarMime: mime?.trim() || "image/png" };
}

agentRoutes.get("/agents", async c => {
  const scope = z.enum(["square", "circle"]).optional().catch(undefined).parse(c.req.query("scope") || undefined);
  return ok(c, { agents: await listPublicAgents(scope) });
});

agentRoutes.get("/agents/:id/avatar", async c => {
  const [row] = await db.select().from(agents).where(eq(agents.id, c.req.param("id")));
  if (!row?.avatarSha256) throw fail("NOT_FOUND", "还没有头像");
  const [blob] = await db.select().from(blobStore).where(eq(blobStore.sha256, row.avatarSha256));
  if (!blob) throw fail("NOT_FOUND", "还没有头像");
  const bytes = await readFile(join(env.dataDir, blob.path));
  c.header("Content-Type", row.avatarMime || "image/png");
  c.header("Cache-Control", "public, max-age=86400");
  c.header("X-Content-Type-Options", "nosniff");
  return c.body(bytes);
});

agentRoutes.get("/admin/agents", async c => {
  await admin(c);
  const rows = await db.select().from(agents).where(isNull(agents.deletedAt)).orderBy(desc(agents.createdAt));
  return ok(c, { agents: await withProviders(rows) });
});

agentRoutes.post("/admin/agents", async c => {
  const u = await admin(c);
  const body = upsert.parse(await c.req.json());
  const handle = await assertAgentHandle(body.handle);
  const model = await modelValues(body);
  const [row] = await db.insert(agents).values({
    handle,
    displayName: body.displayName,
    bio: body.bio?.trim() || null,
    avatarEmoji: body.avatarEmoji?.trim() || "🤖",
    ...(await attachAvatar(body.avatarSha256, body.avatarMime)),
    systemPrompt: body.systemPrompt,
    enabled: body.enabled ?? true,
    allowSquare: body.allowSquare ?? true,
    allowCircle: body.allowCircle ?? true,
    knowledgeEnabled: body.knowledgeEnabled ?? false,
    ...model,
    createdBy: u.id,
  }).returning();
  return ok(c, (await withProviders([row]))[0], 201);
});

agentRoutes.patch("/admin/agents/:id", async c => {
  await admin(c);
  const [cur] = await db.select().from(agents).where(and(eq(agents.id, c.req.param("id")), isNull(agents.deletedAt)));
  if (!cur) throw fail("NOT_FOUND", "智能体不存在");
  const body = upsert.partial().parse(await c.req.json());
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (body.handle !== undefined) values.handle = await assertAgentHandle(body.handle, cur.id);
  if (body.displayName !== undefined) values.displayName = body.displayName;
  if (body.bio !== undefined) values.bio = body.bio?.trim() || null;
  if (body.avatarEmoji !== undefined) values.avatarEmoji = body.avatarEmoji.trim() || "🤖";
  if (body.avatarSha256 !== undefined) {
    const next = await attachAvatar(body.avatarSha256, body.avatarMime);
    if (cur.avatarSha256 && cur.avatarSha256 !== next.avatarSha256) await releaseBlob(cur.avatarSha256);
    values.avatarSha256 = next.avatarSha256;
    values.avatarMime = next.avatarMime;
  }
  if (body.systemPrompt !== undefined) values.systemPrompt = body.systemPrompt;
  if (body.enabled !== undefined) values.enabled = body.enabled;
  if (body.allowSquare !== undefined) values.allowSquare = body.allowSquare;
  if (body.allowCircle !== undefined) values.allowCircle = body.allowCircle;
  if (body.knowledgeEnabled !== undefined) values.knowledgeEnabled = body.knowledgeEnabled;
  Object.assign(values, await modelValues(body, cur));
  const [saved] = await db.update(agents).set(values).where(eq(agents.id, cur.id)).returning();
  return ok(c, (await withProviders([saved]))[0]);
});

agentRoutes.delete("/admin/agents/:id", async c => {
  await admin(c);
  const [cur] = await db.select().from(agents).where(and(eq(agents.id, c.req.param("id")), isNull(agents.deletedAt)));
  if (!cur) throw fail("NOT_FOUND", "智能体不存在");
  await db.update(agents).set({ deletedAt: new Date(), enabled: false, updatedAt: new Date() }).where(eq(agents.id, cur.id));
  return ok(c, {});
});

agentRoutes.post("/admin/agents/avatar", async c => {
  const actor = await admin(c);
  limit(`agent-avatar:${actor.id}`, 20, 600_000);
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw fail("VALIDATION", "请选择图片");
  if (file.size > AVATAR_MAX) throw fail("QUOTA", "头像不能超过 1MB");
  const bytes = Buffer.from(await file.arrayBuffer());
  const declared = AVATAR_MIME.has(file.type) ? file.type : "image/png";
  const mime = assertAttachmentType(declared, bytes);
  if (!AVATAR_MIME.has(mime)) throw fail("VALIDATION", "请上传 png / jpeg / webp / gif");
  const blob = await putBlob(bytes);
  return ok(c, { sha256: blob.sha256, mime }, 201);
});

agentRoutes.post("/admin/agents/:id/test", async c => {
  const u = await admin(c);
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, c.req.param("id")), isNull(agents.deletedAt)));
  if (!agent) throw fail("NOT_FOUND", "智能体不存在");
  const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.personalUserId, u.id)).limit(1);
  const model = await resolveAgentModel(agent, { userId: u.id, workspaceId: ws?.id ?? null });
  if (model.platform) await assertPlatformAiQuota(u.id, model.providerId);
  await assertSafeOutboundUrl(model.baseUrl, "智能体模型地址");
  const out = await chatAi({
    baseUrl: model.baseUrl.replace(/\/$/, ""),
    chatModel: model.chatModel,
    apiKey: model.apiKey,
  }, [
    { role: "system", content: "只回一个词：pong。不要解释。" },
    { role: "user", content: "ping" },
  ], { temperature: 0.2, timeoutMs: 60_000, maxTokens: 32 });
  const reply = sanitizeAgentReply(out.content);
  if (!reply) throw fail("AI_PROVIDER_ERROR", "模型没有返回文字");
  if (model.platform && ws) {
    await db.insert(aiUsage).values({
      userId: u.id, workspaceId: ws.id, action: "agent:test", model: model.chatModel,
      inputTokens: out.usage.prompt_tokens ?? 0, outputTokens: out.usage.completion_tokens ?? 0,
      ...usageMeta({ id: model.providerId ?? undefined, platform: true }),
    });
  }
  return ok(c, { reply });
});

export { publicAgent };
