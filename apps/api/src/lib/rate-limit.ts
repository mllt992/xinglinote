import { fail } from "@kb/shared";

type Bucket = { count: number; reset: number };
const buckets = new Map<string, Bucket>();

/**
 * 固定窗口计数。**超限时抛 `RATE_LIMIT`**，不是返回 false——
 * 调用方直接 `limit(...)` 就行，别写成 `if (!limit(...))`：
 * 返回值恒为真值，那种写法里的分支永远进不去。
 */
export function limit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= now) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  if (b.count > max) throw fail("RATE_LIMIT", "请求过于频繁，请稍后再试");
  if (buckets.size > 10000) for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
  return { remaining: Math.max(0, max - b.count), reset: b.reset };
}

/** 只想知道过没过、不想让异常穿出去时用（OAuth 端点要自己控制错误信封）。 */
export function tryLimit(key: string, max: number, windowMs: number) {
  try {
    limit(key, max, windowMs);
    return true;
  } catch {
    return false;
  }
}
