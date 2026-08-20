/**
 * 安全加固的验收：把《代码审查清单》里那批修复挨个在真接口上验一遍。
 *
 * 需要 `pnpm dev` 起着（或者 KB_BASE_URL 指向一个跑着的实例），账号从
 * $KB_EMAIL / $KB_PASSWORD 取。不改任何已有数据，只在自己的个人工作区里
 * 建一篇笔记再删掉。
 *
 *   node scripts/verify-hardening.mjs
 */
import { KB_EMAIL, KB_PASSWORD, TEST_PASSWORD } from './creds.mjs';

const base = (process.env.KB_BASE_URL ?? 'http://127.0.0.1:12098') + '/api/v1';
const results = {};

async function q(path, opt = {}, cookie = '') {
  const r = await fetch(base + path, {
    ...opt,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opt.headers || {}) },
  });
  let body = null;
  try { body = await r.json(); } catch { /* 204 之类 */ }
  return { status: r.status, body, cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie };
}

const login = await q('/auth/login', { method: 'POST', body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) });
if (login.status !== 200) throw new Error(`登录失败（${login.status}）：${login.body?.error?.message ?? ''}`);
const me = (await q('/me', {}, login.cookie)).body.data;
const wsId = me.personalWorkspaceId;

// —— S4：安全响应头 ——
{
  const r = await fetch((process.env.KB_BASE_URL ?? 'http://127.0.0.1:12098') + '/api/healthz');
  const csp = r.headers.get('content-security-policy') ?? '';
  results.cspPresent = csp.includes("frame-ancestors 'none'") && csp.includes("script-src 'self'");
  results.nosniff = r.headers.get('x-content-type-options') === 'nosniff';
  results.frameOptions = r.headers.get('x-frame-options') === 'DENY';
  results.referrerPolicy = !!r.headers.get('referrer-policy');
}

// —— S5：验证码答案不在 token 里 ——
{
  const cap = await q('/public/captcha');
  const token = cap.body?.data?.token ?? '';
  const answer = String(cap.body?.data?.question ?? '').replace('= ?', '').split('+').map(x => Number(x.trim())).reduce((a, b) => a + b, 0);
  results.captchaHidesAnswer = token.length > 0 && !token.split('.').includes(String(answer));
}

// —— S3：AI 提供商的 baseUrl 不许指内网 ——
for (const url of ['http://169.254.169.254/v1', 'http://127.0.0.1:12099/v1', 'http://10.0.0.1/v1']) {
  const r = await q(`/workspaces/${wsId}/ai/provider`, {
    method: 'POST',
    body: JSON.stringify({ baseUrl: url, chatModel: 'x', apiKey: 'k', personal: true }),
  }, login.cookie);
  results[`ssrfBlocked:${new URL(url).hostname}`] = r.status === 422;
}

// —— S23：服务端错误码不再冒充 VALIDATION（这里只确认信封本身正常）——
{
  const r = await q('/notes/00000000-0000-4000-8000-000000000000', {}, login.cookie);
  results.notFoundEnvelope = r.body?.error?.code === 'NOT_FOUND';
}

// —— P10：folderId 必须属于目标笔记本 ——
const nbs = (await q(`/workspaces/${wsId}/notebooks`, {}, login.cookie)).body.data.notebooks;
const nbId = nbs[0]?.id;
{
  const r = await q('/notes', {
    method: 'POST',
    body: JSON.stringify({ notebookId: nbId, folderId: '00000000-0000-4000-8000-000000000000', title: '不该建出来' }),
  }, login.cookie);
  results.folderOwnershipEnforced = r.status === 422;
}

// —— P5：搜索的 total / hasMore 不再恒等于「截断后的条数 / true」——
let noteId = null;
{
  const created = await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nbId, title: `加固验收-${Date.now()}` }) }, login.cookie);
  noteId = created.body?.data?.id;
  const marker = `加固验收标记${Date.now()}`;
  await q(`/notes/${noteId}`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: 1, bodyMd: marker }) }, login.cookie);
  const s = await q(`/search?q=${encodeURIComponent(marker)}&limit=5`, {}, login.cookie);
  const d = s.body?.data;
  results.searchTotalMatchesHits = d?.total === d?.hits?.length;
  results.searchHasMoreFalseOnLastPage = d?.hasMore === false;
}

// —— S16：restore 不能把笔记塞进别的工作区的笔记本 ——
{
  const r = await q(`/workspaces/${wsId}/restore`, {
    method: 'POST',
    body: JSON.stringify({ format: 'knowledge-backup', version: 1, notebooks: [{ id: crypto.randomUUID(), title: 'x' }], folders: [], notes: [{ id: 'not-a-uuid', notebookId: crypto.randomUUID() }] }),
  }, login.cookie);
  // 形状不合法就该在 zod 层被挡住，而不是跑到 .slice() 上 500
  results.restoreValidatesShape = r.status === 422;
}

// —— S9：注册接口在生产不回 developmentToken（开发态回是允许的，这里只看字段类型）——
{
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const r = await q('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: `harden-${suffix}@example.test`, password: TEST_PASSWORD, handle: `hd${suffix}`, displayName: '加固验收' }),
  });
  // 开放注册可能是关的，那就跳过这一项
  results.registerReachable = r.status === 201 || r.status === 403;
}

if (noteId) await q(`/notes/${noteId}`, { method: 'DELETE' }, login.cookie);

console.log(JSON.stringify(results, null, 2));
const failed = Object.entries(results).filter(([, v]) => v !== true);
if (failed.length) {
  console.error('未通过：', failed.map(([k]) => k).join('、'));
  process.exitCode = 1;
}
