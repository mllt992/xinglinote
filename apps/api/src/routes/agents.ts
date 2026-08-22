import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { agents } from "../db/schema.ts";
import { ok } from "../http.ts";
import { adminAgent, assertAgentHandle, listPublicAgents, publicAgent, sealAgentKey } from "../lib/agents.ts";
import { assertSafeOutboundUrl } from "../lib/net-guard.ts";
import { currentUser } from "../lib/session.ts";

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
  systemPrompt: z.string().trim().min(1).max(4000),
  enabled: z.boolean().optional(),
  allowSquare: z.boolean().optional(),
  allowCircle: z.boolean().optional(),
  knowledgeEnabled: z.boolean().optional(),
  baseUrl: z.string().url(),
  chatModel: z.string().trim().min(1).max(120),
  apiKey: z.string().max(400).optional(),
});

agentRoutes.get("/agents", async c => {
  const scope = z.enum(["square", "circle"]).optional().catch(undefined).parse(c.req.query("scope") || undefined);
  return ok(c, { agents: await listPublicAgents(scope) });
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

export { publicAgent };
