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
import { attachCollab } from "./routes/collab.ts";
import { workspaceLifecycleRoutes } from "./routes/workspace-lifecycle.ts";
import { db } from "./db/client.ts";
import { instanceSettings } from "./db/schema.ts";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: env.publicUrl,
    credentials: true,
    allowHeaders: ["Content-Type", "X-Requested-With"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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

app.get("/api/healthz", (c) => c.json({ ok: true, service:"knowledge-api" }));
app.get("/api/readyz", async c=>{await db.select({id:instanceSettings.id}).from(instanceSettings).limit(1);return c.json({ok:true,database:true});});
app.route("/api/v1", auth);
app.route("/api/v1", knowledge);
app.route("/api/v1", themeRoutes);
app.route("/api/v1", shareRoutes);
app.route("/api/v1", adminRoutes);
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

const web = mountWeb(app);

await seedBuiltin().catch((e) => {
  console.warn("seed skipped (先跑 pnpm db:push):", (e as Error).message);
});

const server = serve({ fetch: app.fetch, port: env.port }, () => {
  console.log(`api http://127.0.0.1:${env.port}${web ? " (含前端静态托管)" : ""}`);
});

// 协同房间挂在同一个端口上：另开一个端口意味着反向代理、CORS、Cookie 都要再配一遍
attachCollab(server as unknown as Server);
