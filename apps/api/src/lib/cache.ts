/**
 * embedding 旁路缓存：进程内 LRU 必有，REDIS_URL 有则再写一层 Redis。
 * Redis 挂了、没配、超时都当未命中，调用方不得因此失败。
 * 只缓存内容寻址的向量，不缓存带 ACL 的检索命中（设计 10 §5.4）。
 */
import { createHash } from "node:crypto";
import { Socket } from "node:net";
import { env } from "../env.ts";

const MEM_MAX = 512;
const REDIS_CMD_MS = 400;
const REDIS_CONNECT_MS = 2_000;
const REDIS_COOLDOWN_MS = 5_000;

type MemEntry = { value: string; exp: number };
const mem = new Map<string, MemEntry>();

export function embedCacheKey(baseUrl: string, model: string, text: string) {
  const h = createHash("sha256")
    .update(baseUrl).update("\0")
    .update(model).update("\0")
    .update(text)
    .digest("hex");
  return `kb:emb:v1:${h}`;
}

function memGet(key: string): string | undefined {
  const hit = mem.get(key);
  if (!hit) return;
  if (hit.exp <= Date.now()) {
    mem.delete(key);
    return;
  }
  mem.delete(key);
  mem.set(key, hit);
  return hit.value;
}

function memSet(key: string, value: string, ttlSec: number) {
  if (mem.has(key)) mem.delete(key);
  mem.set(key, { value, exp: Date.now() + Math.max(1, ttlSec) * 1000 });
  while (mem.size > MEM_MAX) {
    const oldest = mem.keys().next().value;
    if (oldest === undefined) break;
    mem.delete(oldest);
  }
}

export function encodeResp(args: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.from(a, "utf8");
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from("\r\n"));
  }
  return Buffer.concat(parts);
}

/** 解析缓冲区里的第一条 RESP 简单/整型/bulk 回复。不够一条返回 null。 */
export function parseResp(buf: Buffer): { value: string | null; rest: Buffer } | null {
  if (buf.length < 3) return null;
  const type = String.fromCharCode(buf[0]!);
  if (type === "+" || type === "-" || type === ":") {
    const end = buf.indexOf("\r\n");
    if (end < 0) return null;
    const line = buf.subarray(1, end).toString("utf8");
    if (type === "-") throw new Error(line);
    return { value: line, rest: buf.subarray(end + 2) };
  }
  if (type === "$") {
    const end = buf.indexOf("\r\n");
    if (end < 0) return null;
    const n = Number(buf.subarray(1, end).toString("utf8"));
    if (!Number.isFinite(n)) throw new Error("bad bulk length");
    if (n < 0) return { value: null, rest: buf.subarray(end + 2) };
    const start = end + 2;
    if (buf.length < start + n + 2) return null;
    return { value: buf.subarray(start, start + n).toString("utf8"), rest: buf.subarray(start + n + 2) };
  }
  throw new Error(`不支持的 RESP 类型 ${type}`);
}

type Pending = { resolve: (v: string | null) => void; reject: (e: Error) => void };

class RedisConn {
  private sock: Socket | null = null;
  private buf = Buffer.alloc(0);
  private queue: Pending[] = [];

  constructor(private readonly host: string, private readonly port: number) {}

  async connect(timeoutMs: number) {
    const sock = new Socket();
    this.sock = sock;
    sock.setNoDelay(true);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        sock.destroy();
        reject(new Error("redis connect timeout"));
      }, timeoutMs);
      sock.once("error", err => {
        clearTimeout(t);
        reject(err);
      });
      sock.connect(this.port, this.host, () => {
        clearTimeout(t);
        sock.on("data", chunk => this.onData(chunk));
        sock.on("error", err => this.failAll(err));
        sock.on("close", () => this.failAll(new Error("redis closed")));
        resolve();
      });
    });
  }

  async cmd(...args: string[]): Promise<string | null> {
    const sock = this.sock;
    if (!sock || sock.destroyed) throw new Error("redis not connected");
    return await new Promise<string | null>((resolve, reject) => {
      this.queue.push({ resolve, reject });
      sock.write(encodeResp(args));
    });
  }

  kill() {
    try { this.sock?.destroy(); } catch { /* ignore */ }
    this.sock = null;
    this.failAll(new Error("redis killed"));
  }

  private onData(chunk: Buffer) {
    this.buf = Buffer.from(Buffer.concat([this.buf, chunk]));
    while (this.queue.length) {
      let parsed: { value: string | null; rest: Buffer } | null;
      try {
        parsed = parseResp(this.buf);
      } catch (e) {
        this.failAll(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      if (!parsed) return;
      this.buf = Buffer.from(parsed.rest);
      this.queue.shift()!.resolve(parsed.value);
    }
  }

  private failAll(err: Error) {
    const q = this.queue.splice(0);
    for (const p of q) p.reject(err);
  }
}

export type RedisTarget = { host: string; port: number; username: string; password: string; db: number };

function stripWrap(raw: string) {
  const t = raw.trim();
  if ((t.startsWith("\"") && t.endsWith("\"")) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1).trim();
  return t;
}

/** 认 redis://[:password@]host:port[/db] 和 redis://user:password@host:port（ACL）。 */
export function parseRedisUrl(raw: string): RedisTarget | null {
  const url = stripWrap(raw);
  if (!url) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "redis:") return null;
  const dbRaw = parsed.pathname.replace(/^\//, "");
  const db = dbRaw ? Number(dbRaw) : 0;
  return {
    host: parsed.hostname || "127.0.0.1",
    port: parsed.port ? Number(parsed.port) : 6379,
    username: decodeURIComponent(parsed.username || ""),
    password: decodeURIComponent(parsed.password || ""),
    db: Number.isInteger(db) && db >= 0 ? db : 0,
  };
}

/** requirepass 用 AUTH pass；Redis 6 ACL 用 AUTH user pass。 */
export function redisAuthArgs(target: Pick<RedisTarget, "username" | "password">): string[] | null {
  if (!target.password) return null;
  return target.username ? ["AUTH", target.username, target.password] : ["AUTH", target.password];
}

let conn: RedisConn | null = null;
let cooldownUntil = 0;
let connecting: Promise<RedisConn | null> | null = null;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        t = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

async function openRedis(): Promise<RedisConn | null> {
  const target = parseRedisUrl(env.redisUrl);
  if (!target) return null;
  if (Date.now() < cooldownUntil) return null;
  const c = new RedisConn(target.host, target.port);
  try {
    await c.connect(REDIS_CONNECT_MS);
    const auth = redisAuthArgs({
      username: target.username,
      password: env.redisPassword || target.password,
    });
    if (auth) await withTimeout(c.cmd(...auth), REDIS_CMD_MS, "redis auth timeout");
    if (target.db) await withTimeout(c.cmd("SELECT", String(target.db)), REDIS_CMD_MS, "redis select timeout");
    await withTimeout(c.cmd("PING"), REDIS_CMD_MS, "redis ping timeout");
    return c;
  } catch {
    c.kill();
    cooldownUntil = Date.now() + REDIS_COOLDOWN_MS;
    return null;
  }
}

async function getRedis(): Promise<RedisConn | null> {
  if (!env.redisUrl) return null;
  if (conn) return conn;
  if (!connecting) {
    connecting = openRedis().then(c => {
      conn = c;
      connecting = null;
      return c;
    }, () => {
      connecting = null;
      return null;
    });
  }
  return connecting;
}

function dropRedis() {
  conn?.kill();
  conn = null;
  cooldownUntil = Date.now() + REDIS_COOLDOWN_MS;
}

async function redisGet(key: string): Promise<string | undefined> {
  const c = await getRedis();
  if (!c) return;
  try {
    const v = await withTimeout(c.cmd("GET", key), REDIS_CMD_MS, "redis get timeout");
    return v ?? undefined;
  } catch {
    dropRedis();
    return;
  }
}

async function redisSet(key: string, value: string, ttlSec: number): Promise<void> {
  const c = await getRedis();
  if (!c) return;
  try {
    await withTimeout(c.cmd("SET", key, value, "EX", String(Math.max(1, ttlSec))), REDIS_CMD_MS, "redis set timeout");
  } catch {
    dropRedis();
  }
}

export async function cacheGet(key: string): Promise<string | undefined> {
  const local = memGet(key);
  if (local !== undefined) return local;
  const remote = await redisGet(key);
  if (remote !== undefined) memSet(key, remote, 60);
  return remote;
}

export async function cacheSet(key: string, value: string, ttlSec: number): Promise<void> {
  memSet(key, value, ttlSec);
  await redisSet(key, value, ttlSec);
}

/** 单测用：清掉进程内条目。不断 Redis。 */
export function resetMemoryCache() {
  mem.clear();
}

export const EMBED_CACHE_TTL_SEC = 7 * 24 * 3600;
