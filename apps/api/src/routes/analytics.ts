import { Hono } from "hono";
import { fail, type WorkspaceAnalytics } from "@kb/shared";
import { z } from "zod";
import { db } from "../db/client.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";
import { analyticsQuerySchema, buildAnalyticsQuery } from "../lib/analytics.ts";

export const analyticsRoutes = new Hono();

analyticsRoutes.get("/workspaces/:id/analytics", async c => {
  // 包括错误响应也不让浏览器/代理复用旧 ACL 下的数据。
  c.header("Cache-Control", "private, no-store");
  const user = await currentUser(c);
  if (!user) throw fail("UNAUTHENTICATED", "请先登录，再查看统计");
  const workspace = z.string().uuid().safeParse(c.req.param("id"));
  const query = analyticsQuerySchema.safeParse(c.req.query());
  if (!workspace.success || !query.success) throw fail("VALIDATION", "统计参数无效，请选择 7 天或 30 天和有效的笔记本");
  const [row] = await db.execute<{
    workspace: WorkspaceAnalytics["workspace"] | null;
    scopeValid: boolean;
    data: Omit<WorkspaceAnalytics, "workspace">;
  }>(buildAnalyticsQuery({ workspaceId: workspace.data, userId: user.id, notebookId: query.data.notebookId, days: query.data.days === "7" ? 7 : 30 }));
  if (!row?.workspace || !row.scopeValid) throw fail("NOT_FOUND", "统计范围不存在或你没有读取权限");
  return ok(c, { workspace: row.workspace, ...row.data });
});
