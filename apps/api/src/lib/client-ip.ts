import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/**
 * 限流用的客户端标识。
 *
 * `X-Forwarded-For` 是客户端能随便写的头，直接拿它当限流 key 等于没限流——
 * 每次换一个值就是一个新桶。反代（Caddy / Nginx）只会把自己看到的对端**追加**在
 * 这个头的末尾，不会覆盖前面的伪造内容，所以能信的只有末尾那几跳。
 *
 * 默认按「对端是不是私网地址」自动判断：
 *   - 对端是环回 / 私网 → 我们在反代后面，取 XFF 末尾第 1 项（反代自己写的那项）；
 *   - 对端是公网地址   → 没有反代，XFF 整段都是伪造的，直接忽略，用对端地址。
 * 反代不止一层时用 `TRUST_PROXY_HOPS` 显式指定信任几跳。
 */
const CONFIGURED_HOPS = Number(process.env.TRUST_PROXY_HOPS ?? "");

/** 判断一个 IP 字面量是不是私网 / 环回 / 链路本地。用于 net-guard 与这里的反代识别。 */
export function isPrivateAddress(raw: string): boolean {
  const ip = raw.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!ip) return true;
  if (ip === "localhost") return true;

  // IPv4（含 ::ffff:a.b.c.d 这种映射写法）
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;          // 链路本地，云厂商元数据就在这段
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                         // 组播与保留段
    return false;
  }

  const v6 = ip.toLowerCase();
  if (v6 === "::" || v6 === "::1") return true;
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // 唯一本地地址
  if (v6.startsWith("fe80")) return true;                       // 链路本地
  return false;
}

/** 限流 key 用的客户端地址。永远返回一个非空字符串。 */
export function clientIp(c: Context): string {
  let peer = "";
  try {
    peer = getConnInfo(c).remote.address ?? "";
  } catch {
    /* 非 node-server 运行时（单测里就是）拿不到，按无反代处理 */
  }

  const behindProxy = Number.isFinite(CONFIGURED_HOPS) && CONFIGURED_HOPS > 0
    ? CONFIGURED_HOPS
    : peer && isPrivateAddress(peer) ? 1 : 0;
  if (behindProxy <= 0) return peer || "unknown";

  const chain = (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  // 末尾第 hops 项：hops=1 就是最靠近我们的那个反代写下的真实对端
  return chain[chain.length - behindProxy] ?? (peer || "unknown");
}
