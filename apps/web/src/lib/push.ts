import { api } from "../api";

export type PushConfig = { enabled: boolean; publicKey: string | null };
export type PushDevice = { id: string; userAgent: string | null; status: string; failCount: number; lastOkAt: string | null; createdAt: string; fingerprint: string };

/** 浏览器要的是 Uint8Array 形式的 VAPID 公钥，不是 base64url 字符串。 */
function decodeKey(base64url: string) {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, ch => ch.charCodeAt(0));
}

const b64u = (buf: ArrayBuffer | null) =>
  buf ? btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : "";

/** 三样缺一不可：https（localhost 除外）、Service Worker、Push API。缺了就别显示开关。 */
export const pushSupported = () =>
  typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function registration() {
  return navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(r => navigator.serviceWorker.ready.then(() => r));
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** 订阅这台设备。权限被拒时抛出可直接给人看的话，不要把 DOMException 原样弹出去。 */
export async function subscribeThisDevice(publicKey: string) {
  if (!pushSupported()) throw new Error("这个浏览器不支持推送通知");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "浏览器里已经禁止了本站通知，要在地址栏的站点设置里改回来" : "没有拿到通知权限");
  const reg = await registration();
  const sub = (await reg.pushManager.getSubscription())
    ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(publicKey) }));
  const device = await api<PushDevice>("/api/v1/push/devices", {
    method: "POST",
    body: JSON.stringify({
      endpoint: sub.endpoint,
      p256dh: b64u(sub.getKey("p256dh")),
      auth: b64u(sub.getKey("auth")),
      userAgent: navigator.userAgent.slice(0, 300),
    }),
  }).catch(async e => {
    // 服务端不收就别在浏览器里留一个永远收不到的订阅
    await sub.unsubscribe().catch(() => {});
    throw e;
  });
  return device;
}

/** 退订：先撤浏览器那一侧，再删服务端记录；顺序反了会留下一个还在推的僵尸端点。 */
export async function unsubscribeThisDevice(deviceId?: string) {
  const sub = await currentSubscription();
  if (sub) await sub.unsubscribe().catch(() => {});
  if (deviceId) await api(`/api/v1/push/devices/${deviceId}`, { method: "DELETE" });
}
