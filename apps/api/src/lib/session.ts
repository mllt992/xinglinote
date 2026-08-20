import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { db } from "../db/client.ts";
import { env } from "../env.ts";
import { sessions, users } from "../db/schema.ts";

const COOKIE = "kb_session";
const DAYS = 30;

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(c: Context, userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + DAYS * 86400_000);
  await db.insert(sessions).values({ userId, tokenHash: hashToken(token), expiresAt: expires });
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    secure: env.publicUrl.startsWith("https:"),
    maxAge: DAYS * 86400,
  });
}

export async function clearSession(c: Context) {
  const token = getCookie(c, COOKIE);
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  deleteCookie(c, COOKIE, { path: "/" });
}

/** 按 Cookie 头认人。WebSocket 升级拿不到 hono 的 Context，只有一行原始的 cookie。 */
export async function userFromCookieHeader(header: string | undefined) {
  const hit = /(?:^|;\s*)kb_session=([^;]+)/.exec(header ?? "");
  return hit ? userByToken(decodeURIComponent(hit[1]!)) : null;
}

async function userByToken(token: string) {
  const rows = await db.select().from(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  const s = rows[0];
  if (!s || s.expiresAt < new Date()) return null;
  const u = await db.select().from(users).where(eq(users.id, s.userId));
  const user = u[0];
  if (!user || user.status === "banned" || user.status === "deleted") return null;
  return user;
}

export async function currentUser(c: Context) {
  const token = getCookie(c, COOKIE);
  return token ? userByToken(token) : null;
}
