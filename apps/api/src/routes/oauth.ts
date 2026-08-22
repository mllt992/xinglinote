import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { Hono } from "hono";
import { z } from "zod";
import { eq, inArray, lt } from "drizzle-orm";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { mcpTokens, oauthClients, oauthRequests, workspaceMembers, workspaces } from "../db/schema.ts";
import { env } from "../env.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";
import { notebookAccess } from "../lib/notebook-access.ts";
import { tryLimit } from "../lib/rate-limit.ts";
import { clientIp } from "../lib/client-ip.ts";
import { hashSecret, matchesSecret, secretHashes, secureToken } from "../lib/tokens.ts";
import { assertTokenWorkspaces, resolveWorkspaceIds } from "../lib/mcp-workspaces.ts";

/**
 * MCP 的 OAuth 2.1 授权码流程（强制 PKCE + RFC 7591 动态注册）。
 * 授权通过后不发 JWT，仍旧在 mcp_tokens 里落一行——鉴权、范围、额度、吊销
 * 全部复用既有那套，「吊销即刻生效」的要求不会被自证明 token 破坏。
 */
export const oauthRoutes = new Hono();
export const wellKnownRoutes = new Hono();

const CODE_TTL_MS = 10 * 60_000;
const SCOPES = ["knowledge.read", "knowledge.write", "knowledge.manage"];
const resourceUrl = () => `${env.publicUrl}/api/v1/mcp`;

/** OAuth 的错误必须是 {error, error_description}，不能套项目自己的 {ok:false} 信封。 */
function oerr(c: Context, status: ContentfulStatusCode, error: string, description?: string) {
  return c.json({ error, ...(description ? { error_description: description } : {}) }, status, {
    "Cache-Control": "no-store",
  });
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** 回调地址：https 放行，http 只放行环回，其余按原生客户端的自定义 scheme 处理。 */
function validRedirect(uri: string) {
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol);
}

function redirectBack(c: Context, uri: string, params: Record<string, string | undefined>) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return c.redirect(u.toString(), 302);
}

// —— 元数据 ——————————————————————————————————————————————
const asMetadata = () => ({
  issuer: env.publicUrl,
  authorization_endpoint: `${env.publicUrl}/api/v1/oauth/authorize`,
  token_endpoint: `${env.publicUrl}/api/v1/oauth/token`,
  registration_endpoint: `${env.publicUrl}/api/v1/oauth/register`,
  scopes_supported: SCOPES,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
});

const prMetadata = () => ({
  resource: resourceUrl(),
  authorization_servers: [env.publicUrl],
  scopes_supported: SCOPES,
  bearer_methods_supported: ["header"],
});

wellKnownRoutes.get("/.well-known/oauth-authorization-server", (c) => c.json(asMetadata()));
wellKnownRoutes.get("/.well-known/oauth-authorization-server/api/v1/mcp", (c) => c.json(asMetadata()));
wellKnownRoutes.get("/.well-known/oauth-protected-resource", (c) => c.json(prMetadata()));
// 客户端会按 RFC 9728 把受保护资源的路径拼在后面
wellKnownRoutes.get("/.well-known/oauth-protected-resource/api/v1/mcp", (c) => c.json(prMetadata()));

// —— 动态客户端注册（RFC 7591）——————————————————————————————
oauthRoutes.post("/oauth/register", async (c) => {
  // tryLimit 而不是 limit：OAuth 的错误必须是 {error, error_description} 信封，
  // 让 limit() 抛出去会被 onError 包成项目自己的 {ok:false} 信封。
  if (!tryLimit(`oauth:register:${clientIp(c)}`, 10, 60_000)) return oerr(c, 429, "temporarily_unavailable", "注册过于频繁");
  let body: unknown;
  try { body = await c.req.json(); } catch { return oerr(c, 400, "invalid_client_metadata", "请求体必须是 JSON"); }
  const parsed = z.object({
    client_name: z.string().min(1).max(120).optional(),
    redirect_uris: z.array(z.string().min(1)).min(1).max(10),
    token_endpoint_auth_method: z.enum(["none", "client_secret_post", "client_secret_basic"]).default("none"),
  }).safeParse(body);
  if (!parsed.success) return oerr(c, 400, "invalid_client_metadata", parsed.error.issues[0]?.message);
  const { redirect_uris, token_endpoint_auth_method } = parsed.data;
  for (const uri of redirect_uris) {
    if (!validRedirect(uri)) return oerr(c, 400, "invalid_redirect_uri", `不接受的回调地址：${uri}`);
  }
  const name = parsed.data.client_name ?? "未命名客户端";
  const clientId = `kbc_${secureToken(16)}`;
  const secret = token_endpoint_auth_method === "none" ? null : `kbs_${secureToken(24)}`;
  await db.insert(oauthClients).values({
    clientId,
    clientSecretHash: secret ? hashSecret(secret) : null,
    clientName: name,
    redirectUris: redirect_uris,
  });
  return c.json({
    client_id: clientId,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method,
  }, 201, { "Cache-Control": "no-store" });
});

// —— 授权端点 ————————————————————————————————————————————
oauthRoutes.get("/oauth/authorize", async (c) => {
  if (!tryLimit(`oauth:authorize:${clientIp(c)}`, 30, 60_000)) return oerr(c, 429, "temporarily_unavailable", "请求过于频繁");
  // 顺手清掉过期一天以上的请求，免得这张表只涨不落
  await db.delete(oauthRequests).where(lt(oauthRequests.expiresAt, new Date(Date.now() - 86_400_000)));
  const q = c.req.query();
  if (!q.client_id) return oerr(c, 400, "invalid_request", "缺少 client_id");
  const [client] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, q.client_id));
  if (!client) return oerr(c, 400, "invalid_client", "client_id 未注册");
  // 回调地址不合法时绝不能把用户弹回去，否则就是个开放重定向
  if (!q.redirect_uri || !(client.redirectUris as string[]).includes(q.redirect_uri)) {
    return oerr(c, 400, "invalid_request", "redirect_uri 与注册时登记的不一致");
  }
  const redirectUri = q.redirect_uri;
  const back = (error: string, description: string) =>
    redirectBack(c, redirectUri, { error, error_description: description, state: q.state });

  if (q.response_type !== "code") return back("unsupported_response_type", "只支持 authorization code");
  if (!q.code_challenge) return back("invalid_request", "缺少 code_challenge（本服务强制 PKCE）");
  if ((q.code_challenge_method ?? "plain") !== "S256") return back("invalid_request", "code_challenge_method 只支持 S256");
  if (q.resource && q.resource.replace(/\/$/, "") !== resourceUrl()) {
    return back("invalid_target", `资源应为 ${resourceUrl()}`);
  }

  const [row] = await db.insert(oauthRequests).values({
    clientId: client.clientId,
    redirectUri,
    state: q.state ?? null,
    scope: q.scope ?? "",
    resource: q.resource ?? null,
    codeChallenge: q.code_challenge,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  }).returning();
  return c.redirect(`${env.publicUrl}/oauth/consent?request=${row.id}`, 302);
});

// —— 同意页用的接口（走项目自己的信封，前端好处理）——————————————
async function pending(id: string) {
  const [r] = await db.select().from(oauthRequests).where(eq(oauthRequests.id, id));
  if (!r) throw fail("NOT_FOUND", "授权请求不存在");
  if (r.usedAt || r.codeHash) throw fail("VALIDATION", "这个授权请求已经处理过了");
  if (r.expiresAt <= new Date()) throw fail("VALIDATION", "授权请求已过期，请回客户端重新发起");
  return r;
}

oauthRoutes.get("/oauth/requests/:id", async (c) => {
  const u = await currentUser(c);
  if (!u) throw fail("UNAUTHENTICATED", "请先登录");
  const r = await pending(c.req.param("id"));
  const [client] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, r.clientId));
  const mine = await db.select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
    .from(workspaceMembers).innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, u.id));
  return ok(c, {
    clientName: client?.clientName ?? r.clientId,
    redirectHost: new URL(r.redirectUri).host || r.redirectUri,
    scope: r.scope,
    resource: resourceUrl(),
    workspaces: mine,
  });
});

const policySchema = z.object({
  workspaceId: z.string().uuid().optional(),
  workspaceIds: z.array(z.string().uuid()).min(1).max(50).optional(),
  rw: z.enum(["read", "write", "manage"]),
  notebookMode: z.enum(["inherit", "allowlist"]).default("inherit"),
  notebookIds: z.array(z.string().uuid()).default([]),
  allowDelete: z.boolean().default(false),
  requireAiIndex: z.boolean().default(true),
  allowPrivateNotebooks: z.boolean().default(false),
  feedPublic: z.boolean().default(false),
  feedWorkspace: z.boolean().default(false),
  dailyWriteLimitBytes: z.number().int().min(1024).max(1073741824).nullable().default(null),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(null),
});
type Policy = z.infer<typeof policySchema>;

oauthRoutes.post("/oauth/requests/:id/approve", async (c) => {
  const u = await currentUser(c);
  if (!u) throw fail("UNAUTHENTICATED", "请先登录");
  const r = await pending(c.req.param("id"));
  const parsed = policySchema.parse(await c.req.json());
  const workspaceIds = resolveWorkspaceIds(parsed);
  const p = { ...parsed, workspaceIds, workspaceId: workspaceIds[0]! };

  // 授权出去的权限不能超过本人在每个勾选工作区的权限——和手动建钥匙同一套校验
  await assertTokenWorkspaces(u.id, workspaceIds, p.rw);
  if (p.allowDelete && p.rw !== "manage") throw fail("VALIDATION", "只有「全部」档位可以允许删除");
  if (p.notebookMode === "allowlist") {
    if (!p.notebookIds.length) throw fail("VALIDATION", "指定笔记本时至少要选一个");
    for (const id of p.notebookIds) {
      const x = await notebookAccess(id, u.id, p.rw === "read" ? "read" : "edit");
      if (!workspaceIds.includes(x.workspace.id)) throw fail("VALIDATION", "指定的笔记本不属于勾选的工作区");
    }
  }

  const code = `kba_${secureToken(32)}`;
  await db.update(oauthRequests)
    .set({ userId: u.id, policy: p, codeHash: hashSecret(code), expiresAt: new Date(Date.now() + CODE_TTL_MS) })
    .where(eq(oauthRequests.id, r.id));
  const back = new URL(r.redirectUri);
  back.searchParams.set("code", code);
  if (r.state) back.searchParams.set("state", r.state);
  return ok(c, { redirect: back.toString() });
});

oauthRoutes.post("/oauth/requests/:id/deny", async (c) => {
  const u = await currentUser(c);
  if (!u) throw fail("UNAUTHENTICATED", "请先登录");
  const r = await pending(c.req.param("id"));
  await db.update(oauthRequests).set({ usedAt: new Date() }).where(eq(oauthRequests.id, r.id));
  const back = new URL(r.redirectUri);
  back.searchParams.set("error", "access_denied");
  if (r.state) back.searchParams.set("state", r.state);
  return ok(c, { redirect: back.toString() });
});

// —— 换 token ——————————————————————————————————————————
oauthRoutes.post("/oauth/token", async (c) => {
  let form: Record<string, string> = {};
  const ct = c.req.header("Content-Type") ?? "";
  try {
    if (ct.includes("application/json")) form = (await c.req.json()) as Record<string, string>;
    else form = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
  } catch { return oerr(c, 400, "invalid_request", "无法解析请求体"); }

  if (form.grant_type !== "authorization_code") return oerr(c, 400, "unsupported_grant_type", "只支持 authorization_code");
  if (!form.code || !form.code_verifier) return oerr(c, 400, "invalid_request", "缺少 code 或 code_verifier");

  // 取号并**当场上锁**：从 select 到 update usedAt 之间没有锁的话，
  // 两个并发请求拿同一个 code 都能过 `if (r.usedAt)`，各自签出一把钥匙，
  // 而重放检测只会吊销其中一把。邀请码兑换那边（members.ts）本来就是这么写的。
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(oauthRequests)
      .where(inArray(oauthRequests.codeHash, secretHashes(form.code!)))
      .for("update");
    if (!row) return { row: null, replayed: false as const };
    if (row.usedAt) return { row, replayed: true as const };
    // 先占住：后面任何一步失败都只是让这个 code 作废，不会留下可重放的窗口
    await tx.update(oauthRequests).set({ usedAt: new Date() }).where(eq(oauthRequests.id, row.id));
    return { row, replayed: false as const };
  });
  const r = claimed.row;
  if (!r || !r.policy || !r.userId) return oerr(c, 400, "invalid_grant", "授权码无效");
  if (claimed.replayed) {
    // 授权码被重放：把它换出去的那把钥匙一并吊销（OAuth 2.1 要求）
    if (r.tokenId) await db.update(mcpTokens).set({ status: "revoked" }).where(eq(mcpTokens.id, r.tokenId));
    return oerr(c, 400, "invalid_grant", "授权码已被使用，关联的访问令牌已吊销");
  }
  if (r.expiresAt <= new Date()) return oerr(c, 400, "invalid_grant", "授权码已过期");
  if (form.redirect_uri && form.redirect_uri !== r.redirectUri) return oerr(c, 400, "invalid_grant", "redirect_uri 不一致");

  const [client] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, r.clientId));
  if (!client) return oerr(c, 400, "invalid_client", "客户端不存在");
  if (form.client_id && form.client_id !== client.clientId) return oerr(c, 400, "invalid_grant", "client_id 与授权码不匹配");
  if (client.clientSecretHash) {
    let secret = form.client_secret;
    const basic = c.req.header("Authorization")?.match(/^Basic (.+)$/)?.[1];
    if (!secret && basic) {
      const decoded = Buffer.from(basic, "base64").toString();
      secret = decodeURIComponent(decoded.slice(decoded.indexOf(":") + 1));
    }
    if (!secret || !matchesSecret(secretHashes(secret), client.clientSecretHash)) {
      return oerr(c, 401, "invalid_client", "客户端认证失败");
    }
  }

  const challenge = createHash("sha256").update(form.code_verifier).digest("base64url");
  if (!safeEqual(challenge, r.codeChallenge)) return oerr(c, 400, "invalid_grant", "PKCE 校验失败");

  const p = r.policy as Policy;
  const workspaceIds = resolveWorkspaceIds(p);
  const id = crypto.randomUUID();
  const secret = `kbk_${id.slice(0, 8)}_${secureToken(24)}`;
  await db.insert(mcpTokens).values({
    id,
    secretHash: hashSecret(secret),
    name: client.clientName,
    userId: r.userId,
    workspaceId: workspaceIds[0]!,
    workspaceIds,
    notebookMode: p.notebookMode,
    notebookIds: p.notebookIds,
    rw: p.rw,
    allowDelete: p.allowDelete,
    requireAiIndex: p.requireAiIndex,
    allowPrivateNotebooks: p.allowPrivateNotebooks,
    feedPublic: p.feedPublic,
    feedWorkspace: p.feedWorkspace,
    dailyWriteLimitBytes: p.dailyWriteLimitBytes,
    expiresAt: p.expiresInDays ? new Date(Date.now() + p.expiresInDays * 86400000) : null,
    clientId: client.clientId,
    source: "oauth",
  });
  await db.update(oauthRequests).set({ tokenId: id }).where(eq(oauthRequests.id, r.id));

  const scope = p.rw === "manage" ? "knowledge.manage" : p.rw === "write" ? "knowledge.write" : "knowledge.read";
  return c.json({
    access_token: secret,
    token_type: "Bearer",
    scope,
    ...(p.expiresInDays ? { expires_in: p.expiresInDays * 86400 } : {}),
  }, 200, { "Cache-Control": "no-store", Pragma: "no-cache" });
});
