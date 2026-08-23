/** 写工具幂等：数据库持久化，跨进程共享；相同参数并发时只允许第一个执行。 */
import { createHash } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { mcpIdempotency } from "../db/schema.ts";

const TTL_MS = 10 * 60_000;
const PENDING_STALE_MS = 2 * 60_000;
const WAIT_MS = 30_000;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "client_request_id")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, canonical(child)]));
}

export function requestHash(args: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(args))).digest("hex");
}

export type IdempotencyClaim = { tokenId: string; toolName: string; key: string; hash: string };
export type IdempotencyStart = { kind: "execute"; claim: IdempotencyClaim } | { kind: "replay"; result: unknown };

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function startIdempotent(tokenId: string, toolName: string, key: string, args: unknown): Promise<IdempotencyStart> {
  const hash = requestHash(args), claim = { tokenId, toolName, key, hash };
  const deadline = Date.now() + WAIT_MS;
  await db.delete(mcpIdempotency).where(lt(mcpIdempotency.expiresAt,new Date()));
  while (Date.now() < deadline) {
    const [inserted] = await db.insert(mcpIdempotency).values({tokenId,toolName,idempotencyKey:key,requestHash:hash,status:"pending",expiresAt:new Date(Date.now()+TTL_MS)}).onConflictDoNothing().returning({requestHash:mcpIdempotency.requestHash});
    if (inserted) return { kind: "execute", claim };

    const [row] = await db.select().from(mcpIdempotency).where(and(eq(mcpIdempotency.tokenId,tokenId),eq(mcpIdempotency.toolName,toolName),eq(mcpIdempotency.idempotencyKey,key)));
    if (!row) continue;
    if (row.requestHash !== hash) throw fail("IDEMPOTENCY_KEY_REUSED","同一幂等键不能用于不同参数");
    if (row.status === "succeeded") return { kind: "replay", result: row.result };
    if (row.createdAt.getTime() < Date.now() - PENDING_STALE_MS) {
      await db.delete(mcpIdempotency).where(and(eq(mcpIdempotency.tokenId,tokenId),eq(mcpIdempotency.toolName,toolName),eq(mcpIdempotency.idempotencyKey,key),eq(mcpIdempotency.requestHash,hash),eq(mcpIdempotency.status,"pending"),lt(mcpIdempotency.createdAt,new Date(Date.now()-PENDING_STALE_MS))));
      continue;
    }
    await wait(75);
  }
  throw fail("IDEMPOTENCY_IN_PROGRESS","同一请求仍在处理中，请稍后使用相同幂等键重试");
}

export async function finishIdempotent(claim: IdempotencyClaim, result: unknown) {
  await db.update(mcpIdempotency).set({status:"succeeded",result,expiresAt:new Date(Date.now()+TTL_MS),updatedAt:new Date()}).where(and(eq(mcpIdempotency.tokenId,claim.tokenId),eq(mcpIdempotency.toolName,claim.toolName),eq(mcpIdempotency.idempotencyKey,claim.key),eq(mcpIdempotency.requestHash,claim.hash),eq(mcpIdempotency.status,"pending")));
}

export async function abortIdempotent(claim: IdempotencyClaim) {
  await db.delete(mcpIdempotency).where(and(eq(mcpIdempotency.tokenId,claim.tokenId),eq(mcpIdempotency.toolName,claim.toolName),eq(mcpIdempotency.idempotencyKey,claim.key),eq(mcpIdempotency.requestHash,claim.hash),eq(mcpIdempotency.status,"pending")));
}

export function readIdempotencyKey(header: string | undefined, args: unknown) {
  const fromHeader = header?.trim();
  if (fromHeader) {
    if (fromHeader.length > 200) throw fail("VALIDATION", "Idempotency-Key 不能超过 200 个字符");
    return fromHeader;
  }
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const v = (args as Record<string, unknown>).client_request_id;
    if (typeof v === "string" && v.trim()) {
      const normalized = v.trim();
      if (normalized.length > 200) throw fail("VALIDATION", "client_request_id 不能超过 200 个字符");
      return normalized;
    }
  }
  return undefined;
}
