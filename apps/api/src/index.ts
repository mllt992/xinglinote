import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import { fail } from "@kb/shared";
import { seedBuiltin } from "./db/seed.ts";
import { env } from "./env.ts";
import { onError } from "./http.ts";
import { mountWeb } from "./lib/static-web.ts";
import { auth } from "./routes/auth.ts";
import { knowledge } from "./routes/notes.ts";
import { themeRoutes } from "./routes/themes.ts";
import { shareRoutes } from "./routes/shares.ts";
import { adminRoutes } from "./routes/admin.ts";
import { serviceRoutes } from "./routes/services.ts";
import { agentRoutes } from "./routes/agents.ts";
import { memberRoutes } from "./routes/members.ts";
import { interactionRoutes } from "./routes/interactions.ts";
import { feedRoutes } from "./routes/feeds.ts";
import { aiRoutes } from "./routes/ai.ts";
import { moderationRoutes } from "./routes/moderation.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { oauthRoutes, wellKnownRoutes } from "./routes/oauth.ts";
import { fileRoutes } from "./routes/files.ts";
import { opsRoutes } from "./routes/ops.ts";
import { workbenchRoutes } from "./routes/workbench.ts";
import { backupRoutes } from "./routes/backups.ts";
import { calendarFeedRoutes, calendarRoutes } from "./routes/calendar.ts";
import { pushRoutes } from "./routes/push.ts";
import { navRoutes } from "./routes/nav.ts";
import { attachCollab } from "./routes/collab.ts";
import { workspaceLifecycleRoutes } from "./routes/workspace-lifecycle.ts";
import { db } from "./db/client.ts";
import { instanceSettings } from "./db/schema.ts";

const app = new Hono();

/**
 * 安全响应头。这是个渲染用户 Markdown、还对外开公开分享页和文档站的应用：
 * DOMPurify 只是第一道，CSP 是它被绕过时的第二道。
 *
 * - script-src 'self'：构建产物里没有内联脚本（apps/web/index.html 只有一个 module src）。
 * - style-src 允许 inline：mermaid 的 SVG 和 KaTeX 都会写行内样式，去不掉。
 * - connect-src 'self'：CSP3 里 'self' 同时覆盖同源的 ws:／wss:，协同编辑走的就是它。
 * - frame-ancestors 'none'：全站不打算被别人嵌，顺手把点击劫持堵上。
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
].join("; ");

app.use("*", async (c, next) => {
  await next();
  c.header("Content-Security-Policy", CSP);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  // HSTS 只在确实跑在 https 上时发，否则本地 http 调试会被浏览器记住并强制升级
  if (env.publicUrl.startsWith("https:")) {
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
});

app.use(
  "*",
  cors({
    origin: env.publicUrl,
    credentials: true,
    allowHeaders: ["Authorization", "Content-Type", "Content-Length", "X-Content-SHA256", "X-Requested-With"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.onError((e, c) => {
  if (e instanceof ZodError) {
    return onError(fail("VALIDATION", e.issues[0]?.message ?? "参数错误"), c);
  }
  return onError(e, c);
});

app.route("/", wellKnownRoutes);
app.route("/", calendarFeedRoutes);

app.get("/api/healthz", (c) => c.json({ ok: true, service: "knowledge-api" }));
app.get("/api/readyz", async (c) => {
  await db.select({ id: instanceSettings.id }).from(instanceSettings).limit(1);
  return c.json({ ok: true, database: true });
});
app.route("/api/v1", auth);
app.route("/api/v1", knowledge);
app.route("/api/v1", themeRoutes);
app.route("/api/v1", shareRoutes);
app.route("/api/v1", adminRoutes);
app.route("/api/v1", serviceRoutes);
app.route("/api/v1", agentRoutes);
app.route("/api/v1", memberRoutes);
app.route("/api/v1", interactionRoutes);
app.route("/api/v1", feedRoutes);
app.route("/api/v1", aiRoutes);
app.route("/api/v1", moderationRoutes);
app.route("/api/v1", mcpRoutes);
app.route("/api/v1", oauthRoutes);
app.route("/api/v1", fileRoutes);
app.route("/api/v1", opsRoutes);
app.route("/api/v1", workbenchRoutes);
app.route("/api/v1", workspaceLifecycleRoutes);
app.route("/api/v1", backupRoutes);
app.route("/api/v1", calendarRoutes);
app.route("/api/v1", pushRoutes);
app.route("/api/v1", navRoutes);

const web = mountWeb(app);

await seedBuiltin().catch((e) => {
  console.warn("seed skipped (先跑 pnpm db:push):", (e as Error).message);
});

const server = serve({ fetch: app.fetch, port: env.port }, () => {
  console.log(`api http://127.0.0.1:${env.port}${web ? " (含前端静态托管)" : ""}`);
});

const http = server as unknown as Server;

// Node 默认 keepAliveTimeout 只有 5 秒，比任何反向代理的空闲复用窗口都短。代理刚把一个请求
// 写进复用连接、Node 同一时刻把这条连接关掉，就是一次凭空的 502——而 POST 不可安全重试，
// MCP 的每次工具调用又都是 POST，这条竞态表现出来就是「偶发失败、重试一下又好了」。
// 规矩是让代理永远先关：docker/Caddyfile 那边压到 30s，这里留足 75s。
// headersTimeout 必须比它更大，否则读头超时会抢在 keep-alive 之前把连接断掉。
http.keepAliveTimeout = 75_000;
http.headersTimeout = 80_000;

// 协同房间挂在同一个端口上：另开一个端口意味着反向代理、CORS、Cookie 都要再配一遍
attachCollab(http);
