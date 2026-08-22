import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { agents, blobStore } from "../db/schema.ts";
import { env } from "../env.ts";
import { ok } from "../http.ts";
import { adminAgent, assertAgentHandle, listPublicAgents, publicAgent, sealAgentKey } from "../lib/agents.ts";
import { chatAi } from "../lib/ai.ts";
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
  baseUrl: z.string().url(),
  chatModel: z.string().trim().min(1).max(120),
  apiKey: z.string().max(400).optional(),
});

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
  return ok(c, { agents: rows.map(adminAgent) });
});

agentRoutes.post("/admin/agents", async c => {
  const u = await admin(c);
  const body = upsert.parse(await c.req.json());
  const handle = await assertAgentHandle(body.handle);
  if (!body.apiKey?.trim() || body.apiKey.startsWith("••")) throw fail("VALIDATION", "请填写模型 API Key", { apiKey: "必填" });
  const baseUrl = body.baseUrl.replace(/\/$/, "");
  await assertSafeOutboundUrl(baseUrl, "智能体模型地址");
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
    baseUrl,
    chatModel: body.chatModel,
    apiKey: sealAgentKey(body.apiKey),
    createdBy: u.id,
  }).returning();
  return ok(c, adminAgent(row), 201);
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
  if (body.chatModel !== undefined) values.chatModel = body.chatModel;
  if (body.baseUrl !== undefined) {
    const baseUrl = body.baseUrl.replace(/\/$/, "");
    await assertSafeOutboundUrl(baseUrl, "智能体模型地址");
    values.baseUrl = baseUrl;
  }
  if (body.apiKey !== undefined && body.apiKey.trim() && !body.apiKey.startsWith("••")) {
    values.apiKey = sealAgentKey(body.apiKey);
  }
  const [saved] = await db.update(agents).set(values).where(eq(agents.id, cur.id)).returning();
  return ok(c, adminAgent(saved));
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
  await admin(c);
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, c.req.param("id")), isNull(agents.deletedAt)));
  if (!agent) throw fail("NOT_FOUND", "智能体不存在");
  await assertSafeOutboundUrl(agent.baseUrl, "智能体模型地址");
  const out = await chatAi({
    baseUrl: agent.baseUrl.replace(/\/$/, ""),
    chatModel: agent.chatModel,
    apiKey: agent.apiKey,
  }, [
    { role: "system", content: "只回一个词：pong。不要解释。" },
    { role: "user", content: "ping" },
  ], { temperature: 0.2, timeoutMs: 60_000, maxTokens: 32 });
  const reply = sanitizeAgentReply(out.content);
  if (!reply) throw fail("AI_PROVIDER_ERROR", "模型没有返回文字");
  return ok(c, { reply });
});

export { publicAgent };
