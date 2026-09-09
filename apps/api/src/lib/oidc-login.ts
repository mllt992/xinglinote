import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type OidcFlowCookie = {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  expiresAt: number;
};

export function randomUrlToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** 只允许本站绝对路径，避免登录回调成为开放重定向器。 */
export function safeLoginNext(value: string | null | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/app";
  return value;
}

export function signOidcFlow(value: OidcFlowCookie, secret: string) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function readOidcFlow(value: string | undefined, secret: string): OidcFlowCookie | null {
  if (!value) return null;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<OidcFlowCookie>;
    if (typeof parsed.state !== "string" || typeof parsed.nonce !== "string" || typeof parsed.verifier !== "string"
      || typeof parsed.next !== "string" || typeof parsed.expiresAt !== "number" || parsed.expiresAt <= Date.now()) return null;
    return parsed as OidcFlowCookie;
  } catch { return null; }
}

export function sameToken(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function oidcHandleBase(preferredUsername: unknown, email: string) {
  const source = typeof preferredUsername === "string" && preferredUsername.trim()
    ? preferredUsername
    : email.split("@")[0] || "user";
  let handle = source.normalize("NFKD").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(handle)) handle = `u_${handle}`;
  handle = handle.slice(0, 24).replace(/_+$/g, "");
  return handle.length >= 3 ? handle : "user";
}
