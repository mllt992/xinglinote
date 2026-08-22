// MCP OAuth 全流程验收：元数据 → 动态注册 → 授权码 + PKCE → 换 token → 拿 token 调 MCP
// → 重放授权码应失败且吊销令牌。需要 pnpm dev 起着，账号从环境变量取。
import { createHash, randomBytes } from 'node:crypto';
import { KB_EMAIL, KB_PASSWORD } from './creds.mjs';

const base = process.env.KB_BASE_URL ?? 'http://127.0.0.1:12098';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};

async function j(path, opt = {}, cookie = '') {
  const r = await fetch(base + path, {
    ...opt,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opt.headers ?? {}) },
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, headers: r.headers };
}

console.log(`\n== 目标 ${base} ==\n`);

// 1. 未认证的 MCP 请求要回 401 + WWW-Authenticate
console.log('元数据与发现');
{
  const r = await fetch(`${base}/api/v1/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  });
  const wa = r.headers.get('www-authenticate') ?? '';
  check('未带 token 的 MCP 请求回 401', r.status === 401, `实际 ${r.status}`);
  check('401 带 WWW-Authenticate 且指向资源元数据', wa.includes('resource_metadata='), wa || '(缺失)');
}
{
  const { status, body } = await j('/.well-known/oauth-protected-resource');
  check('受保护资源元数据可读 (RFC 9728)', status === 200 && !!body.resource);
  check('资源指向 MCP 端点', body.resource === `${base}/api/v1/mcp`, body.resource);
  check('声明了授权服务器', Array.isArray(body.authorization_servers) && body.authorization_servers[0] === base);
}
{
  const { status, body } = await j('/.well-known/oauth-authorization-server');
  check('授权服务器元数据可读 (RFC 8414)', status === 200 && !!body.issuer);
  check('公布了动态注册端点', !!body.registration_endpoint);
  check('只允许 S256', JSON.stringify(body.code_challenge_methods_supported) === '["S256"]');
}

// 2. 动态客户端注册
console.log('\n动态客户端注册 (RFC 7591)');
const redirectUri = 'http://127.0.0.1:45999/callback';
let clientId;
{
  const { status, body } = await j('/api/v1/oauth/register', {
    method: 'POST',
    body: JSON.stringify({ client_name: '验收脚本', redirect_uris: [redirectUri] }),
  });
  clientId = body.client_id;
  check('注册返回 201 与 client_id', status === 201 && !!clientId, `status ${status}`);
  check('公开客户端不下发 secret', body.client_secret === undefined);
}
{
  const { status, body } = await j('/api/v1/oauth/register', {
    method: 'POST', body: JSON.stringify({ client_name: 'x', redirect_uris: ['http://evil.example.com/cb'] }),
  });
  check('拒绝非环回的 http 回调', status === 400 && body.error === 'invalid_redirect_uri', JSON.stringify(body));
}

// 3. 授权端点
console.log('\n授权端点');
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(8).toString('hex');
const authUrl = (over = {}) => {
  const p = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: 'S256', state,
    scope: 'knowledge.write', resource: `${base}/api/v1/mcp`, ...over,
  });
  return `/api/v1/oauth/authorize?${p}`;
};
{
  const { status, body } = await j(authUrl({ redirect_uri: 'http://127.0.0.1:1/evil' }));
  check('未登记的 redirect_uri 直接 400，不做重定向', status === 400 && body.error === 'invalid_request');
}
{
  const { status, headers } = await j(authUrl({ code_challenge: '' }));
  check('缺 PKCE 时带 error 弹回客户端', status === 302 && (headers.get('location') ?? '').includes('error=invalid_request'));
}
let requestId;
{
  const { status, headers } = await j(authUrl());
  const loc = headers.get('location') ?? '';
  requestId = new URL(loc, base).searchParams.get('request');
  check('合法请求跳同意页', status === 302 && loc.includes('/oauth/consent') && !!requestId, loc);
}

// 4. 登录后看同意页数据
console.log('\n同意页');
let cookie = '';
{
  const r = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }),
  });
  cookie = (r.headers.getSetCookie?.() ?? []).map(s => s.split(';')[0]).join('; ');
  check('登录拿到会话', r.status === 200 && !!cookie);
}
{
  const { status, body } = await j(`/api/v1/oauth/requests/${requestId}`);
  check('未登录看授权请求被拒', status === 401, `status ${status}`);
}
let workspaceId;
{
  const { status, body } = await j(`/api/v1/oauth/requests/${requestId}`, {}, cookie);
  workspaceId = body.data?.workspaces?.[0]?.id;
  check('登录后能读到授权请求', status === 200 && !!body.data?.clientName, JSON.stringify(body).slice(0, 120));
  check('带出可选工作区', !!workspaceId);
}

// 5. 同意 → 拿授权码
let code;
{
  const { status, body } = await j(`/api/v1/oauth/requests/${requestId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ workspaceIds: [workspaceId], rw: 'write', notebookMode: 'inherit', notebookIds: [], allowDelete: false, requireAiIndex: false, allowPrivateNotebooks: false, feedPublic: false, feedWorkspace: false, dailyWriteLimitBytes: null, expiresInDays: null }),
  }, cookie);
  const loc = body.data?.redirect ?? '';
  code = loc ? new URL(loc).searchParams.get('code') : null;
  check('同意后拿到授权码', status === 200 && !!code, JSON.stringify(body).slice(0, 160));
  check('state 原样带回', loc.includes(`state=${state}`));
}
{
  const { status, body } = await j(`/api/v1/oauth/requests/${requestId}/approve`, {
    method: 'POST', body: JSON.stringify({ workspaceId, rw: 'read' }),
  }, cookie);
  check('同一请求不能重复同意', status !== 200, `status ${status}`);
}

// 6. 换 token
console.log('\n换 token');
{
  const r = await fetch(`${base}/api/v1/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: 'wrong-verifier', client_id: clientId, redirect_uri: redirectUri }),
  });
  const body = await r.json();
  check('PKCE verifier 不对时拒绝', r.status === 400 && body.error === 'invalid_grant', JSON.stringify(body));
}
let accessToken;
{
  const r = await fetch(`${base}/api/v1/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri }),
  });
  const body = await r.json();
  accessToken = body.access_token;
  check('正确的 verifier 能换到 access_token', r.status === 200 && !!accessToken, JSON.stringify(body).slice(0, 160));
  check('token_type 是 Bearer', body.token_type === 'Bearer');
  check('响应不可缓存', (r.headers.get('cache-control') ?? '').includes('no-store'));
}

// 7. 用 token 调 MCP
console.log('\n用 OAuth token 调 MCP');
async function mcp(method, params, token = accessToken) {
  const r = await fetch(`${base}/api/v1/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: r.status, body: await r.json() };
}
{
  const { status, body } = await mcp('initialize');
  check('initialize 通过', status === 200 && !!body.result?.serverInfo);
}
{
  const { body } = await mcp('tools/list');
  const names = (body.result?.tools ?? []).map(t => t.name);
  check('拿到工具清单', names.includes('search_notes'), names.join(','));
  check('未授权发动态则不注册 post_to_feed', !names.includes('post_to_feed'));
}
{
  const { body } = await mcp('tools/call', { name: 'get_me', arguments: {} });
  const me = body.result?.structuredContent;
  check('get_me 返回同意页选定的档位', me?.rw === 'write', JSON.stringify(me));
  check('绑定到同意页选定的工作区', me?.workspace?.id === workspaceId);
}
{
  const { body } = await mcp('tools/call', { name: 'trash_note', arguments: { id: '00000000-0000-0000-0000-000000000000' } });
  check('未授权删除时 trash_note 被拒', !!body.error, JSON.stringify(body).slice(0, 120));
}

// 8. 重放授权码
console.log('\n授权码重放');
{
  const r = await fetch(`${base}/api/v1/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri }),
  });
  const body = await r.json();
  check('重放授权码被拒', r.status === 400 && body.error === 'invalid_grant', JSON.stringify(body));
}
{
  const { status } = await mcp('tools/list');
  check('重放后原 token 立刻失效', status === 401, `status ${status}`);
}

// 9. 收尾：把验收产生的钥匙吊销
{
  const { body } = await j('/api/v1/mcp/tokens', {}, cookie);
  const mine = (body.data?.tokens ?? []).filter(t => t.name === '验收脚本');
  for (const t of mine) await j(`/api/v1/mcp/tokens/${t.id}`, { method: 'DELETE' }, cookie);
  check('验收产生的钥匙已清理', true);
}

console.log(`\n通过 ${pass}，失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
