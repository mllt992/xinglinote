import { count, and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { hashPassword } from "@kb/core";
import { env } from "../env.ts";
import { db } from "../db/client.ts";
import { instanceSettings, oidcIdentities, users } from "../db/schema.ts";
import { handleOccupied } from "../lib/agents.ts";
import { createSession, currentUser } from "../lib/session.ts";
import { createPersonalWorkspace } from "../lib/workspace.ts";
import { oidcHandleBase, pkceChallenge, randomUrlToken, readOidcFlow, safeLoginNext, sameToken, signOidcFlow } from "../lib/oidc-login.ts";
import { open } from "../lib/secrets.ts";
import { assertSafeOutboundUrl, safeFetch } from "../lib/net-guard.ts";
import { fail } from "@kb/shared";
import { ok } from "../http.ts";

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
};

type OidcConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  clientAuthMethod: "client_secret_basic" | "client_secret_post" | "none";
  scopes: string;
  providerName: string;
  autoProvision: boolean;
  requireVerifiedEmail: boolean;
};

const FLOW_COOKIE = "kb_oidc_flow";
const FLOW_SECONDS = 10 * 60;
let discoveryCache: { issuer: string; promise: Promise<Discovery> } | undefined;
let jwksCache: { uri: string; value: ReturnType<typeof createRemoteJWKSet> } | undefined;

function callbackUrl() {
  return new URL("/api/v1/auth/oidc/callback", env.publicUrl).toString();
}

function endpoint(value: unknown, field: string) {
  if (typeof value !== "string") throw new Error(`OIDC discovery 缺少 ${field}`);
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(!env.isProduction && url.protocol === "http:" && local)) throw new Error(`OIDC ${field} 必须使用 HTTPS`);
  return url.toString();
}

async function oidcConfig(requireEnabled = true): Promise<OidcConfig> {
  const [settings] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1));
  if (!settings || (requireEnabled && !settings.oidcEnabled)) throw new Error("实例尚未启用统一认证登录");
  const issuer = settings.oidcIssuerUrl?.trim();
  const clientId = settings.oidcClientId?.trim();
  const method = settings.oidcClientAuthMethod;
  if (!issuer || !clientId) throw new Error("OIDC Issuer URL 或 Client ID 尚未配置");
  const issuerParsed = new URL(issuer);
  if (issuerParsed.search || issuerParsed.hash) throw new Error("OIDC Issuer URL 不能包含查询参数或片段");
  endpoint(issuer, "issuer");
  if (method !== "client_secret_basic" && method !== "client_secret_post" && method !== "none") throw new Error("OIDC 客户端认证方式无效");
  const clientSecret = settings.oidcClientSecret ? open(settings.oidcClientSecret) : "";
  if (method !== "none" && !clientSecret) throw new Error("OIDC Client Secret 尚未配置");
  if (!settings.oidcScopes.split(/\s+/).includes("openid")) throw new Error("OIDC scope 必须包含 openid");
  return {
    issuer, clientId, clientSecret, clientAuthMethod: method, scopes: settings.oidcScopes,
    providerName: settings.oidcProviderName, autoProvision: settings.oidcAutoProvision,
    requireVerifiedEmail: settings.oidcRequireVerifiedEmail,
  };
}

async function discovery(config: OidcConfig, force = false) {
  if (force || discoveryCache?.issuer !== config.issuer) {
    const promise = (async () => {
    const url = `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const response = await safeFetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) }, "OIDC discovery 地址");
    if (!response.ok) throw new Error(`OIDC discovery 请求失败（${response.status}）`);
    const data = await response.json() as Partial<Discovery>;
    if (data.issuer !== config.issuer) throw new Error("OIDC discovery 的 issuer 与配置不一致");
    return {
      issuer: config.issuer,
      authorization_endpoint: endpoint(data.authorization_endpoint, "authorization_endpoint"),
      token_endpoint: endpoint(data.token_endpoint, "token_endpoint"),
      jwks_uri: endpoint(data.jwks_uri, "jwks_uri"),
      userinfo_endpoint: data.userinfo_endpoint ? endpoint(data.userinfo_endpoint, "userinfo_endpoint") : undefined,
    };
    })();
    discoveryCache = { issuer: config.issuer, promise };
    promise.catch(() => { if (discoveryCache?.promise === promise) discoveryCache = undefined; });
  }
  return discoveryCache.promise;
}

async function claimsFromCode(config: OidcConfig, code: string, verifier: string, nonce: string) {
  const metadata = await discovery(config);
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(),
    code_verifier: verifier,
  });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (config.clientAuthMethod === "client_secret_basic") {
    headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
  } else if (config.clientAuthMethod === "client_secret_post") {
    form.set("client_id", config.clientId);
    form.set("client_secret", config.clientSecret);
  } else {
    form.set("client_id", config.clientId);
  }
  const response = await safeFetch(metadata.token_endpoint, { method: "POST", headers, body: form, signal: AbortSignal.timeout(10_000) }, "OIDC token 地址");
  const token = await response.json().catch(() => ({})) as { id_token?: string; access_token?: string; error?: string };
  if (!response.ok || !token.id_token) throw new Error(`OIDC token 交换失败${token.error ? `：${token.error}` : ""}`);
  if (jwksCache?.uri !== metadata.jwks_uri) {
    await assertSafeOutboundUrl(metadata.jwks_uri, "OIDC JWKS 地址");
    jwksCache = { uri: metadata.jwks_uri, value: createRemoteJWKSet(new URL(metadata.jwks_uri), { timeoutDuration: 10_000, cooldownDuration: 30_000 }) };
  }
  const verified = await jwtVerify(token.id_token, jwksCache.value, { issuer: config.issuer, audience: config.clientId });
  if (verified.payload.nonce !== nonce) throw new Error("OIDC nonce 校验失败");
  let claims: JWTPayload = verified.payload;
  if ((!claims.email || claims.email_verified === undefined) && metadata.userinfo_endpoint && token.access_token) {
    const info = await safeFetch(metadata.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    }, "OIDC userinfo 地址");
    if (!info.ok) throw new Error(`OIDC userinfo 请求失败（${info.status}）`);
    const userinfo = await info.json() as JWTPayload;
    if (userinfo.sub !== claims.sub) throw new Error("OIDC userinfo 的 sub 与 ID Token 不一致");
    claims = { ...claims, ...userinfo };
  }
  return claims;
}

async function availableHandle(preferred: unknown, email: string) {
  const base = oidcHandleBase(preferred, email);
  if (!await handleOccupied(base)) return base;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = `${base.slice(0, 25)}_${randomUrlToken(4).toLowerCase().slice(0, 6)}`;
    if (!await handleOccupied(candidate)) return candidate;
  }
  throw new Error("无法分配可用用户名");
}

async function localUserForClaims(config: OidcConfig, claims: JWTPayload) {
  const subject = claims.sub;
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!subject || !email) throw new Error("认证中心必须返回 sub 和 email");
  if (config.requireVerifiedEmail && claims.email_verified !== true && claims.email_verified !== "true") {
    throw new Error("认证中心没有确认邮箱已验证");
  }
  const [identity] = await db.select().from(oidcIdentities)
    .where(and(eq(oidcIdentities.issuer, config.issuer), eq(oidcIdentities.subject, subject)));
  if (identity) {
    const [user] = await db.select().from(users).where(eq(users.id, identity.userId));
    if (!user) throw new Error("OIDC 身份绑定的本地账号不存在");
    if (identity.email !== email) await db.update(oidcIdentities).set({ email, updatedAt: new Date() }).where(eq(oidcIdentities.id, identity.id));
    return user;
  }

  let [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    if (!config.autoProvision) throw new Error("此账号尚未在知识库中开通");
    const [{ value: userCount }] = await db.select({ value: count() }).from(users);
    const displayName = String(claims.name || claims.preferred_username || email.split("@")[0]).trim().slice(0, 32) || "新用户";
    [user] = await db.insert(users).values({
      email,
      emailVerifiedAt: new Date(),
      passwordHash: await hashPassword(randomUrlToken(48)),
      handle: await availableHandle(claims.preferred_username, email),
      displayName,
      roleInstance: userCount === 0 ? "admin" : "user",
      status: "active",
    }).returning();
    if (userCount === 0) await db.update(instanceSettings).set({ firstAdminUserId: user.id }).where(eq(instanceSettings.id, 1));
    await createPersonalWorkspace(user.id, user.displayName);
  }
  await db.insert(oidcIdentities).values({ issuer: config.issuer, subject, userId: user.id, email });
  return user;
}

function loginErrorUrl(message: string) {
  const url = new URL("/login", env.publicUrl);
  url.searchParams.set("oidc_error", message);
  return url.toString();
}

export const oidcLoginRoutes = new Hono();

oidcLoginRoutes.get("/auth/oidc/start", async c => {
  c.header("Cache-Control", "no-store");
  try {
    const config = await oidcConfig();
    const metadata = await discovery(config);
    const flow = {
      state: randomUrlToken(), nonce: randomUrlToken(), verifier: randomUrlToken(48),
      next: safeLoginNext(c.req.query("next")), expiresAt: Date.now() + FLOW_SECONDS * 1000,
    };
    setCookie(c, FLOW_COOKIE, signOidcFlow(flow, env.appSecret), {
      httpOnly: true, secure: env.publicUrl.startsWith("https:"), sameSite: "Lax",
      path: "/api/v1/auth/oidc", maxAge: FLOW_SECONDS,
    });
    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", callbackUrl());
    url.searchParams.set("scope", config.scopes);
    url.searchParams.set("state", flow.state);
    url.searchParams.set("nonce", flow.nonce);
    url.searchParams.set("code_challenge", pkceChallenge(flow.verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return c.redirect(url.toString());
  } catch (error) {
    const message = error instanceof Error ? error.message : "统一认证登录失败";
    console.error("OIDC login start failed:", message);
    return c.redirect(loginErrorUrl(message));
  }
});

oidcLoginRoutes.get("/auth/oidc/callback", async c => {
  c.header("Cache-Control", "no-store");
  const flow = readOidcFlow(getCookie(c, FLOW_COOKIE), env.appSecret);
  deleteCookie(c, FLOW_COOKIE, { path: "/api/v1/auth/oidc" });
  try {
    if (!flow) throw new Error("登录请求已过期，请重试");
    const config = await oidcConfig();
    const providerError = c.req.query("error");
    if (providerError) throw new Error(providerError === "access_denied" ? "你已取消登录" : "认证中心拒绝了登录请求");
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state || !sameToken(state, flow.state)) throw new Error("登录状态校验失败，请重试");
    const claims = await claimsFromCode(config, code, flow.verifier, flow.nonce);
    const user = await localUserForClaims(config, claims);
    if (user.status === "banned") throw new Error("账号已被停用");
    if (user.status === "deleted") throw new Error("账号已注销");
    await createSession(c, user.id);
    return c.redirect(new URL(flow.next, env.publicUrl).toString());
  } catch (error) {
    const message = error instanceof Error ? error.message : "统一认证登录失败";
    console.error("OIDC login failed:", message);
    return c.redirect(loginErrorUrl(message));
  }
});

oidcLoginRoutes.post("/admin/oidc/test", async c => {
  const user = await currentUser(c);
  if (!user) throw fail("UNAUTHENTICATED", "未登录");
  if (user.roleInstance !== "admin") throw fail("FORBIDDEN", "仅实例管理员可操作");
  try {
    const config = await oidcConfig(false);
    const metadata = await discovery(config, true);
    const jwksResponse = await safeFetch(metadata.jwks_uri, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) }, "OIDC JWKS 地址");
    if (!jwksResponse.ok) throw new Error(`OIDC JWKS 请求失败（${jwksResponse.status}）`);
    const jwksDocument = await jwksResponse.json() as { keys?: unknown[] };
    if (!Array.isArray(jwksDocument.keys) || !jwksDocument.keys.length) throw new Error("OIDC JWKS 没有可用公钥");
    return ok(c, { issuer: metadata.issuer, authorizationEndpoint: metadata.authorization_endpoint, tokenEndpoint: metadata.token_endpoint });
  } catch (error) {
    throw fail("VALIDATION", error instanceof Error ? error.message : "OIDC 连接检测失败");
  }
});
