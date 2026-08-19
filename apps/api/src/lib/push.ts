import { and, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { instanceSettings, notifications, pushSubscriptions } from "../db/schema.ts";
import { env } from "../env.ts";
import { open } from "./secrets.ts";
import { sendPush, type VapidKeys } from "./webpush.ts";

export type PushPayload = { title: string; body?: string; href?: string; tag?: string };

/** 实例没开推送、或没生成 VAPID 密钥，就当这个渠道不存在——不是错误。 */
export async function pushConfig(): Promise<{ keys: VapidKeys; subject: string } | null> {
  const [s] = await db.select().from(instanceSettings);
  if (!s?.pushEnabled || !s.vapidPublicKey || !s.vapidPrivateKey) return null;
  return {
    keys: { publicKey: s.vapidPublicKey, privateKey: open(s.vapidPrivateKey) },
    subject: s.vapidSubject || `mailto:admin@${new URL(env.publicUrl).hostname}`,
  };
}

const MAX_FAILS = 5;

/**
 * 发给某人的所有在线设备。任一台成功即算送达（设计 16 §5.7 之 4），
 * 不因为其中一台掉线就整条重发——那会让还在的设备连响好几次。
 */
export async function pushToUser(userId: string, payload: PushPayload) {
  const cfg = await pushConfig();
  if (!cfg) return { sent: 0, total: 0 };
  const subs = await db.select().from(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.status, "active")));
  let sent = 0;
  for (const s of subs) {
    const r = await sendPush({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, cfg.keys, cfg.subject, JSON.stringify(payload));
    if (r.ok) {
      sent++;
      await db.update(pushSubscriptions).set({ lastOkAt: new Date(), failCount: 0 }).where(eq(pushSubscriptions.id, s.id));
      continue;
    }
    const failCount = s.failCount + 1;
    const dead = r.gone || failCount >= MAX_FAILS;
    await db.update(pushSubscriptions).set({ failCount, status: dead ? "gone" : "active" }).where(eq(pushSubscriptions.id, s.id));
    // 悄悄停掉一台设备的推送最糟：人会以为提醒还在，其实早就不响了
    if (dead) await db.insert(notifications).values({ userId, type: "push_disabled", title: "有一台设备的推送已停用", body: r.error ?? "推送端点连续失败", href: "/settings/notifications" });
  }
  return { sent, total: subs.length };
}
