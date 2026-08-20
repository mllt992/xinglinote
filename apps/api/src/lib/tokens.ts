import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function secureToken(bytes = 18) {
  return randomBytes(bytes).toString("base64url");
}

/**
 * 注册码专用的归一化 hash。注册码是给人抄的（`ABCD-EFGH-…`），字母表本来就全大写，
 * 用户抄成小写、前后带空格都得认，所以这里刻意做 trim + 大写。
 */
export function hashCode(value: string) {
  return createHash("sha256").update(value.trim().toUpperCase()).digest("hex");
}

/**
 * 其余所有机器生成的令牌（会话、MCP 钥匙、OAuth 授权码与 client_secret、
 * 邮箱验证 / 重置密码 token、工作区邀请码）的 hash。
 *
 * 这些是 base64url，**大小写有意义**。以前它们和注册码共用一个 `tokenHash()`，
 * 被一起 `.toUpperCase()` 了：每字符的熵从 6 bit 掉到约 5.25 bit，而且校验变成
 * 大小写不敏感，`kbk_ab…` 和 `KBK_AB…` 会被当成同一把钥匙。
 */
export function hashSecret(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * 老库里的令牌是按大写折叠存的。查询时两种都认，写入一律用新的，
 * 这样升级不需要让所有人重新生成 MCP 钥匙和邀请链接。
 * 等确认线上没有旧 hash 了，可以把这个函数和它的调用点一起删掉。
 */
export function secretHashes(value: string) {
  const next = hashSecret(value);
  const legacy = hashCode(value);
  return next === legacy ? [next] : [next, legacy];
}

/** 定长比较，避免把 hash 的前缀信息从响应时间里漏出去。 */
export function safeEqualHex(a: string, b: string) {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** 任一个候选 hash 命中即可（配合 `secretHashes` 做新旧兼容）。 */
export function matchesSecret(candidates: string[], stored: string) {
  return candidates.some(h => safeEqualHex(h, stored));
}

export function registrationCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(20);
  let raw = "";
  for (let i = 0; i < 20; i++) raw += chars[bytes[i] % chars.length];
  return raw.match(/.{1,4}/g)!.join("-");
}
