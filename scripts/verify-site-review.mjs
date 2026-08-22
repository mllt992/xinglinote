// 文档站发布申请：编辑只能提交，管理员审过才对外；管理员自己仍可当场发。
import { KB_EMAIL, KB_PASSWORD, TEST_PASSWORD } from './creds.mjs';
const base = (process.env.KB_BASE_URL ?? 'http://127.0.0.1:12098') + '/api/v1';
async function q(path, opt = {}, cookie = '') {
  const r = await fetch(base + path, { ...opt, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opt.headers || {}) } });
  const j = await r.json();
  if (!r.ok || !j.ok) { const e = new Error(j.error?.message ?? r.status); e.status = r.status; e.code = j.error?.code; throw e; }
  return { data: j.data, cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie };
}
const anon = (path) => fetch(base + path).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
const admin = (await q('/auth/login', { method: 'POST', body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) })).cookie;
const ws = (await q('/workspaces', { method: 'POST', body: JSON.stringify({ name: `文档站审核-${suffix}` }) }, admin)).data.workspace;
const nb = (await q(`/workspaces/${ws.id}/notebooks`, {}, admin)).data.notebooks[0];
const code = (await q('/admin/registration-codes', { method: 'POST', body: JSON.stringify({ quantity: 1, maxUses: 1, skipEmailVerification: true, bindWorkspaceId: ws.id, bindRole: 'editor' }) }, admin)).data.codes[0];
const editor = (await q('/auth/register', { method: 'POST', body: JSON.stringify({ email: `site-${suffix}@example.test`, password: TEST_PASSWORD, handle: `site${suffix}`, displayName: '文档站申请人', registrationCode: code }) })).cookie;
const result = {};
try {
  const asked = (await q(`/notebooks/${nb.id}/site`, { method: 'PATCH', body: JSON.stringify({ published: true }) }, editor)).data;
  result.editorGetsPending = asked.pending === true && asked.published === false && asked.canRequest === true;
  const publicBefore = await anon(`/public/sites/${ws.slug}/${nb.slug}`);
  result.pendingNotPublic = publicBefore.status === 404 || publicBefore.json?.ok === false;
  const queue = (await q(`/workspaces/${ws.id}/site-requests`, {}, admin)).data;
  result.adminSeesRequest = queue.requests.some(r => r.notebookId === nb.id);
  let editorCannotApprove = false;
  try { await q(`/notebooks/${nb.id}/site`, { method: 'PATCH', body: JSON.stringify({ action: 'approve' }) }, editor); } catch (e) { editorCannotApprove = e.status === 403; }
  result.editorCannotApprove = editorCannotApprove;
  const passed = (await q(`/notebooks/${nb.id}/site`, { method: 'PATCH', body: JSON.stringify({ action: 'approve' }) }, admin)).data;
  result.approveGoesLive = passed.published === true && passed.pending === false;
  const publicAfter = await anon(`/public/sites/${ws.slug}/${nb.slug}`);
  result.liveIsPublic = publicAfter.status === 200 && publicAfter.json?.ok === true;
  let editorCannotUnpublish = false;
  try { await q(`/notebooks/${nb.id}/site`, { method: 'PATCH', body: JSON.stringify({ published: false }) }, editor); } catch (e) { editorCannotUnpublish = e.status === 403; }
  result.editorCannotUnpublish = editorCannotUnpublish;
  const down = (await q(`/notebooks/${nb.id}/site`, { method: 'PATCH', body: JSON.stringify({ published: false }) }, admin)).data;
  result.adminUnpublish = down.published === false;
  await q(`/notebooks/${nb.id}/site`, { method: 'PATCH', body: JSON.stringify({ published: true }) }, editor);
  const withdrawn = (await q(`/notebooks/${nb.id}/site`, { method: 'PATCH', body: JSON.stringify({ published: false }) }, editor)).data;
  result.editorCanWithdraw = withdrawn.pending === false && withdrawn.published === false;
} finally {
  await q(`/workspaces/${ws.id}`, { method: 'DELETE', body: JSON.stringify({ confirmName: ws.name }) }, admin).catch(() => {});
}
console.log(JSON.stringify(result, null, 2));
if (!Object.values(result).every(Boolean)) { console.error('失败：' + Object.entries(result).filter(([, v]) => !v).map(([k]) => k).join(', ')); process.exitCode = 1; }
