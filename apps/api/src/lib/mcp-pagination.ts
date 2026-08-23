import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { fail } from "@kb/shared";

type CursorKey = Array<string | number | null>;
type CursorPayload = { v: 1; tool: string; scope: string; query: string; key: CursorKey; exp: number };
type CursorContext = { tool: string; scope: unknown; filters: unknown; secret: string };

const TTL_SECONDS = 15 * 60;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, canonical(child)]));
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("base64url");
}

function signature(encoded: string, secret: string) {
  return createHmac("sha256", secret).update(encoded).digest("base64url");
}

function encodeCursor(context: CursorContext, key: CursorKey) {
  const payload: CursorPayload = { v: 1, tool: context.tool, scope: fingerprint(context.scope), query: fingerprint(context.filters), key, exp: Math.floor(Date.now() / 1000) + TTL_SECONDS };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signature(encoded, context.secret)}`;
}

export function cursorAfter(cursor: string | undefined, context: CursorContext): CursorKey | null {
  if (!cursor) return null;
  if (cursor.length > 4096) throw fail("INVALID_CURSOR", "cursor 不合法");
  const [encoded, supplied, extra] = cursor.split(".");
  if (!encoded || !supplied || extra) throw fail("INVALID_CURSOR", "cursor 不合法");
  const expected = signature(encoded, context.secret);
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a,b)) throw fail("INVALID_CURSOR", "cursor 签名无效");
  let payload: CursorPayload;
  try { payload = JSON.parse(Buffer.from(encoded,"base64url").toString("utf8")) as CursorPayload; }
  catch { throw fail("INVALID_CURSOR", "cursor 内容不合法"); }
  if (payload.v !== 1 || payload.tool !== context.tool || payload.scope !== fingerprint(context.scope) || payload.query !== fingerprint(context.filters) || !Array.isArray(payload.key)) throw fail("INVALID_CURSOR", "cursor 与当前查询或授权范围不匹配");
  if (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now()/1000)) throw fail("CURSOR_EXPIRED", "cursor 已过期，请从第一页重新读取");
  return payload.key;
}

export function compareCursorKeys(a: CursorKey, b: CursorKey, directions: Array<"asc"|"desc">) {
  for (let i=0;i<Math.max(a.length,b.length);i++) {
    const av=a[i],bv=b[i];
    if (av===bv) continue;
    const cmp=av==null?-1:bv==null?1:av<bv?-1:1;
    return directions[i]==="desc"?-cmp:cmp;
  }
  return 0;
}

export function pageByCursor<T>(input: CursorContext & { cursor?: string; limit: number; items: T[]; keyOf: (item:T)=>CursorKey; directions: Array<"asc"|"desc"> }) {
  const after=cursorAfter(input.cursor,input);
  const sorted=[...input.items].sort((a,b)=>compareCursorKeys(input.keyOf(a),input.keyOf(b),input.directions));
  const remaining=after?sorted.filter(item=>compareCursorKeys(input.keyOf(item),after,input.directions)>0):sorted;
  return finishCursorPage({...input,items:remaining});
}

export function finishCursorPage<T>(input: CursorContext & { limit:number; items:T[]; keyOf:(item:T)=>CursorKey }) {
  const has_more=input.items.length>input.limit,items=input.items.slice(0,input.limit),last=items.at(-1);
  return {items,next_cursor:has_more&&last?encodeCursor(input,input.keyOf(last)):null,has_more};
}
