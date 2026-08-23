import { Hono } from "hono";
import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { serviceRequests, users } from "../db/schema.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";
import { userStorage } from "../lib/quota.ts";
import {
  assignStorage, cancelOwnRequest, decideRequest, listOwnRequests, publicRequest,
  storageDto, storagePolicy, submitStorageRequest,
} from "../lib/service-requests.ts";

function pageQuery(c: { req: { query: (k: string) => string | undefined } }) {
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query("pageSize") ?? 20) || 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

async function admin(c: Parameters<typeof currentUser>[0]) {
  const u = await currentUser(c);
  if (!u) throw fail("UNAUTHENTICATED", "未登录");
  if (u.roleInstance !== "admin") throw fail("FORBIDDEN", "仅实例管理员可操作");
  return u;
}

export const serviceRoutes = new Hono();

serviceRoutes.get("/me/storage", async c => {
  const u = await currentUser(c);
  if (!u) throw fail("UNAUTHENTICATED", "未登录");
  const [usage, policy, pending] = await Promise.all([
    userStorage(u.id),
    storagePolicy(),
    db.select().from(serviceRequests).where(and(eq(serviceRequests.userId, u.id), eq(serviceRequests.status, "pending"))).limit(1),
  ]);
  const canRequest = u.status === "active" && policy.allow && !pending[0] && usage.quotaBytes < 1_099_511_627_776;
  return ok(c, {
    ...storageDto(usage),
    canRequest,
    requestClosedReason: u.status !== "active" ? "当前账号状态不能申请"
      : !policy.allow ? "本实例暂不接受在线申请，请联系管理员"
        : pending[0] ? "你已有一条待审批的申请"
          : undefined,
    pendingRequest: pending[0] ? publicRequest(pending[0]) : null,
  });
});

serviceRoutes.get("/me/service-requests", async c => {
  const u = await currentUser(c);
  if (!u) throw fail("UNAUTHENTICATED", "未登录");
  const rows = await listOwnRequests(u.id);
  return ok(c, { requests: rows.map(publicRequest) });
});

serviceRoutes.post("/me/service-requests", async c => {
  const u = await currentUser(c);
  if (!u) throw fail("UNAUTHENTICATED", "未登录");
  const body = z.object({
    kind: z.literal("storage").default("storage"),
    requestedBytes: z.number().int(),
    reason: z.string().trim().max(500).nullable().optional(),
  }).parse(await c.req.json());
  const row = await submitStorageRequest(u, body.requestedBytes, body.reason?.trim() || null);
  return ok(c, publicRequest(row), 201);
});

serviceRoutes.delete("/me/service-requests/:id", async c => {
  const u = await currentUser(c);
  if (!u) throw fail("UNAUTHENTICATED", "未登录");
  const saved = await cancelOwnRequest(u.id, c.req.param("id"));
  return ok(c, publicRequest(saved));
});

serviceRoutes.get("/admin/users/:id", async c => {
  await admin(c);
  const id = c.req.param("id");
  const [target] = await db.select().from(users).where(eq(users.id, id));
  if (!target) throw fail("NOT_FOUND", "用户不存在");
  const { passwordHash: _, ...safe } = target;
  const [usage, requests] = await Promise.all([userStorage(id), listOwnRequests(id)]);
  return ok(c, { user: safe, storage: storageDto(usage), requests: requests.map(publicRequest) });
});

serviceRoutes.get("/admin/service-requests", async c => {
  await admin(c);
  const { page, pageSize, offset } = pageQuery(c);
  const q = c.req.query("q")?.replace(/[%_]/g, "").trim() ?? "";
  const like = q ? `%${q}%` : null;
  const status = z.enum(["pending", "approved", "rejected", "cancelled"]).optional().catch(undefined).parse(c.req.query("status") || undefined);
  const where = and(
    status ? eq(serviceRequests.status, status) : undefined,
    like ? or(ilike(users.displayName, like), ilike(users.handle, like), ilike(users.email, like)) : undefined,
  );
  const rows = await db.select({
    request: serviceRequests,
    displayName: users.displayName,
    handle: users.handle,
    email: users.email,
  }).from(serviceRequests).innerJoin(users, eq(users.id, serviceRequests.userId))
    .where(where).orderBy(desc(serviceRequests.createdAt)).limit(pageSize).offset(offset);
  const [{ value: total }] = await db.select({ value: count() }).from(serviceRequests)
    .innerJoin(users, eq(users.id, serviceRequests.userId)).where(where);
  return ok(c, {
    requests: rows.map(r => ({
      ...publicRequest(r.request),
      user: { id: r.request.userId, displayName: r.displayName, handle: r.handle, email: r.email },
    })),
    total, page, pageSize,
  });
});

serviceRoutes.patch("/admin/service-requests/:id", async c => {
  const actor = await admin(c);
  const body = z.object({
    status: z.enum(["approved", "rejected"]),
    grantedQuotaBytes: z.number().int().optional(),
    adminNote: z.string().trim().max(500).nullable().optional(),
  }).parse(await c.req.json());
  const saved = await decideRequest(actor, c.req.param("id"), body.status, body.grantedQuotaBytes, body.adminNote?.trim() || null);
  return ok(c, publicRequest(saved));
});

serviceRoutes.post("/admin/users/:id/storage", async c => {
  const actor = await admin(c);
  const body = z.object({
    storageQuotaBytes: z.number().int().nullable(),
  }).parse(await c.req.json());
  const result = await assignStorage(actor, c.req.param("id"), body.storageQuotaBytes);
  return ok(c, result);
});
