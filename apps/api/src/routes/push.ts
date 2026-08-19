import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { instanceSettings, pushSubscriptions } from "../db/schema.ts";
import { ok } from "../http.ts";
import { limit } from "../lib/rate-limit.ts";
import { seal } from "../lib/secrets.ts";
import { currentUser } from "../lib/session.ts";
import { pushConfig, pushToUser } from "../lib/push.ts";
import { generateVapidKeys } from "../lib/webpush.ts";

export const pushRoutes = new Hono();

const MAX_DEVICES = 10;

async function requireUser(c: Parameters<typeof currentUser>[0]) {
  const u = await currentUser(c);
  if (!u) throw fail("UNAUTHENTICATED", "未登录");
  return u;
}

function deviceDto(row: typeof pushSubscriptions.$inferSelect) {
  // endpoint 是这台设备的推送凭证，只回一个指纹给前端认自己，不回原文
  return { id: row.id, userAgent: row.userAgent, status: row.status, failCount: row.failCount, lastOkAt: row.lastOkAt, createdAt: row.createdAt, fingerprint: row.endpoint.slice(-16) };
}

/** 前端拿公钥去 `pushManager.subscribe`。没开推送就回 enabled=false，UI 直接不显示这个开关。 */
pushRoutes.get("/push/config", async c => {
  await requireUser(c);
  const [s] = await db.select().from(instanceSettings);
  const enabled = !!(s?.pushEnabled && s.vapidPublicKey && s.vapidPrivateKey);
  return ok(c, { enabled, publicKey: enabled ? s!.vapidPublicKey : null });
});

pushRoutes.get("/push/devices", async c => {
  const u = await requireUser(c);
  const rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, u.id)).orderBy(desc(pushSubscriptions.createdAt));
  return ok(c, { devices: rows.map(deviceDto), max: MAX_DEVICES });
});

pushRoutes.post("/push/devices", async c => {
  const u = await requireUser(c);
  if (!await pushConfig()) throw fail("FORBIDDEN", "实例没有开启推送");
  const body = z.object({
    endpoint: z.string().url().max(2000),
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(64),
    userAgent: z.string().max(300).optional(),
  }).parse(await c.req.json());
  if (!/^https:/.test(body.endpoint)) throw fail("VALIDATION", "推送端点必须是 https");

  // 同一台设备重新授权会换 endpoint 之外的密钥，按 endpoint upsert 而不是插一条新的
  const [existing] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, body.endpoint));
  if (existing) {
    if (existing.userId !== u.id) throw fail("FORBIDDEN", "这个推送端点属于另一个账号");
    const [row] = await db.update(pushSubscriptions).set({ p256dh: body.p256dh, auth: body.auth, userAgent: body.userAgent ?? existing.userAgent, status: "active", failCount: 0 }).where(eq(pushSubscriptions.id, existing.id)).returning();
    return ok(c, deviceDto(row!));
  }
  const mine = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(and(eq(pushSubscriptions.userId, u.id), eq(pushSubscriptions.status, "active")));
  if (mine.length >= MAX_DEVICES) throw fail("QUOTA", `最多 ${MAX_DEVICES} 台设备，请先移除不用的`);
  const [row] = await db.insert(pushSubscriptions).values({ userId: u.id, endpoint: body.endpoint, p256dh: body.p256dh, auth: body.auth, userAgent: body.userAgent ?? null }).returning();
  return ok(c, deviceDto(row!), 201);
});

pushRoutes.delete("/push/devices/:id", async c => {
  const u = await requireUser(c);
  const [row] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, c.req.param("id")));
  if (!row || row.userId !== u.id) throw fail("NOT_FOUND", "设备不存在");
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, row.id));
  return ok(c, {});
});

pushRoutes.post("/push/test", async c => {
  const u = await requireUser(c);
  limit(`push-test:${u.id}`, 6, 60_000);
  const r = await pushToUser(u.id, { title: "推送通了", body: "这是一条测试通知，日历提醒也会走这条路。", href: "/settings/notifications", tag: "push-test" });
  if (!r.total) throw fail("NOT_FOUND", "这个账号还没有登记任何设备");
  if (!r.sent) throw fail("PUSH_FAILED", "所有设备都没送达，去掉再重新开一次试试");
  return ok(c, r);
});

/**
 * 生成 / 轮换 VAPID 密钥。轮换会让所有已存在的订阅立刻作废——浏览器是拿旧公钥订阅的，
 * 换了钥匙那些端点再也推不动，所以这里一并置 gone，让用户重新授权，而不是留一堆永远失败的端点。
 */
pushRoutes.post("/admin/push/vapid", async c => {
  const u = await requireUser(c);
  if (u.roleInstance !== "admin") throw fail("FORBIDDEN", "仅实例管理员可操作");
  const body = z.object({ subject: z.string().max(200).optional(), rotate: z.boolean().default(false) }).parse(await c.req.json().catch(() => ({})));
  const [s] = await db.select().from(instanceSettings);
  if (s?.vapidPublicKey && !body.rotate) throw fail("VALIDATION", "已经有一对密钥了，要换请显式轮换");
  const keys = generateVapidKeys();
  await db.update(instanceSettings).set({
    vapidPublicKey: keys.publicKey,
    vapidPrivateKey: seal(keys.privateKey),
    vapidSubject: body.subject ?? s?.vapidSubject ?? null,
    updatedAt: new Date(),
  }).where(eq(instanceSettings.id, 1));
  const revoked = await db.update(pushSubscriptions).set({ status: "gone" }).where(eq(pushSubscriptions.status, "active")).returning({ id: pushSubscriptions.id });
  return ok(c, { publicKey: keys.publicKey, revokedDevices: revoked.length });
});
