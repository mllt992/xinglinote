/** 同一把钥匙、同一个幂等键，10 分钟内只落第一次成功写入。 */

type Entry = { result: unknown; expires: number };
const cache = new Map<string, Entry>();
const TTL_MS = 10 * 60_000;

function sweep(now: number) {
  if (cache.size < 256) return;
  for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
}

function key(tokenId: string, idem: string) {
  return `${tokenId}:${idem}`;
}

export function recallIdempotent(tokenId: string, idem: string) {
  const hit = cache.get(key(tokenId, idem));
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) {
    cache.delete(key(tokenId, idem));
    return undefined;
  }
  return hit.result;
}

export function rememberIdempotent(tokenId: string, idem: string, result: unknown) {
  const now = Date.now();
  sweep(now);
  cache.set(key(tokenId, idem), { result, expires: now + TTL_MS });
}

export function readIdempotencyKey(header: string | undefined, args: unknown) {
  const fromHeader = header?.trim();
  if (fromHeader) return fromHeader.slice(0, 200);
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const v = (args as Record<string, unknown>).client_request_id;
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 200);
  }
  return undefined;
}
