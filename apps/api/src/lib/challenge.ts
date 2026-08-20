import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { env } from "../env.ts";

/**
 * 给访客评论 / 纠错用的最小验证码：一道加法，不落库也不引第三方。
 *
 * 关键点：**答案不出现在 token 里**。签的是 `HMAC(nonce.expires.答案)`，
 * 校验时用提交上来的答案重算一遍比对。以前的写法是把 `a+b` 明文放在 token 第一段，
 * 脚本 `token.split(".")[0]` 就能拿到答案，等于没有验证码。
 *
 * 另外 token 一次性：验过就把 nonce 记下来，同一个 token 不能在有效期内反复用。
 */
const TTL_MS = 600_000;

const sign = (payload: string) => createHmac("sha256", env.appSecret).update(payload).digest("base64url");

/** 用过的 nonce，到期即清。进程重启会清空，最坏情况是一个 token 多用一次，可以接受。 */
const spent = new Map<string, number>();
function burn(nonce: string, expires: number) {
  const now = Date.now();
  if (spent.size > 5000) for (const [k, v] of spent) if (v <= now) spent.delete(k);
  spent.set(nonce, expires);
}

export function issueChallenge() {
  const a = randomInt(2, 9);
  const b = randomInt(2, 9);
  const nonce = randomBytes(9).toString("base64url");
  const expires = Date.now() + TTL_MS;
  return {
    question: `${a} + ${b} = ?`,
    token: `${nonce}.${expires}.${sign(`${nonce}.${expires}.${a + b}`)}`,
  };
}

export function solveChallenge(token: string | undefined, answer: string | undefined) {
  if (!token || !answer) return false;
  const [nonce, expires, mac] = token.split(".");
  if (!nonce || !expires || !mac) return false;
  if (!/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;
  if (spent.has(nonce)) return false;

  const guess = answer.trim();
  if (!/^\d{1,3}$/.test(guess)) return false;
  const expected = Buffer.from(sign(`${nonce}.${expires}.${Number(guess)}`), "utf8");
  const got = Buffer.from(mac, "utf8");
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return false;

  burn(nonce, Number(expires));
  return true;
}
