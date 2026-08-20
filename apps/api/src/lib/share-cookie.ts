import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env.ts";

/**
 * 带密码的分享，解锁后发一个凭证 cookie。
 *
 * 凭证值必须**跟着密码走**：以前存的是 `share.id`，一个恒定值——改了分享密码
 * 老 cookie 照样能用满 24 小时，而 `share.id` 从工作区分享总览里就能读到，
 * 等于拿到 token 的人不用密码也能进。现在签的是 `HMAC(id + passwordHash)`，
 * 密码一改，之前发出去的凭证全部失效。
 *
 * shares.ts 和 interactions.ts 都要用，所以放在 lib 里——以前是两边各抄一份。
 */
export function shareCookieName(token: string) {
  return `share_${token.slice(0, 16)}`;
}

export function shareCookieValue(shareId: string, passwordHash: string) {
  return createHmac("sha256", env.appSecret).update(`share:${shareId}:${passwordHash}`).digest("base64url");
}

export function shareCookieValid(presented: string | undefined, shareId: string, passwordHash: string) {
  if (!presented) return false;
  const expected = Buffer.from(shareCookieValue(shareId, passwordHash), "utf8");
  const got = Buffer.from(presented, "utf8");
  return expected.length === got.length && timingSafeEqual(expected, got);
}
