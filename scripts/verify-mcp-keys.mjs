// MCP 钥匙的额度、范围、档位、编辑、轮换、吊销验收。
// 用法：KB_EMAIL=... KB_PASSWORD=... node scripts/verify-mcp-keys.mjs
import { KB_EMAIL, KB_PASSWORD } from './creds.mjs';
const base = 'http://127.0.0.1:12098/api/v1';
async function q(path, opt = {}, cookie = '') {
  const r = await fetch(base + path, { ...opt, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opt.headers || {}) } });
  const j = await r.json();
  if (!r.ok || !j.ok) { const e = new Error(j.error?.message ?? r.status); e.code = j.error?.code; e.status = r.status; throw e; }
  return { data: j.data, cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie };
}
async function tool(secret, name, args = {}) {
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result.structuredContent;
}
const c = (await q('/auth/login', { method: 'POST', body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) })).cookie;
const me = (await q('/me', {}, c)).data;
const ws = (await q('/workspaces', { method: 'POST', body: JSON.stringify({ name: 'MCP 钥匙验收' }) }, c)).data.workspace;
const list = () => q('/mcp/tokens', {}, c).then(r => r.data.tokens);
const result = {};
const made = [];
const create = async body => { const d = (await q('/mcp/tokens', { method: 'POST', body: JSON.stringify({ workspaceId: ws.id, ...body }) }, c)).data; made.push(d.id); return d; };
try {
  const nbA = (await q(`/workspaces/${ws.id}/notebooks`, {}, c)).data.notebooks[0];
  const nbB = (await q(`/workspaces/${ws.id}/notebooks`, { method: 'POST', body: JSON.stringify({ title: '范围外的本子', visibility: 'open' }) }, c)).data;
  const noteB = (await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nbB.id, title: '范围外的笔记' }) }, c)).data;
  const baseline = (await list()).length;

  // 额度：默认不限，可显式限制，可改回不限
  const k = await create({ name: '默认额度', rw: 'write' });
  const shown = () => list().then(ts => ts.find(t => t.id === k.id));
  result.defaultUnlimited = (await shown()).dailyWriteLimitBytes === null;
  result.issuesBothConfigs = !!k.config?.mcpServers?.knowledge?.headers?.Authorization && Array.isArray(k.stdioConfig?.mcpServers?.knowledge?.args);
  const limited = await create({ name: '限 2MB', rw: 'write', dailyWriteLimitBytes: 2097152 });
  result.explicitLimitKept = (await list()).find(t => t.id === limited.id).dailyWriteLimitBytes === 2097152;
  await q(`/mcp/tokens/${limited.id}`, { method: 'PATCH', body: JSON.stringify({ dailyWriteLimitBytes: null }) }, c);
  result.editToUnlimited = (await list()).find(t => t.id === limited.id).dailyWriteLimitBytes === null;

  // 不限额度时写入不再被挡
  await tool(k.secret, 'create_note', { notebook_id: nbA.id, title: '不限额度写入', content: 'x'.repeat(3000) });
  result.unlimitedWriteGoesThrough = true;

  // 档位与范围
  const ro = await create({ name: '只读', rw: 'read' });
  let readonlyBlocked = false;
  try { await tool(ro.secret, 'create_note', { notebook_id: nbA.id, title: '只读不该能写' }); } catch { readonlyBlocked = true; }
  result.readonlyBlocksWrite = readonlyBlocked;
  const scoped = await create({ name: '限定一本', rw: 'write', notebookMode: 'allowlist', notebookIds: [nbA.id] });
  let outsideBlocked = false;
  try { await tool(scoped.secret, 'get_note', { id: noteB.id }); } catch { outsideBlocked = true; }
  result.allowlistBlocksOutside = outsideBlocked;
  result.allowlistAllowsInside = Array.isArray((await tool(scoped.secret, 'list_folder', { notebook_id: nbA.id })).notes);
  let deleteNeedsManage = false;
  try { await q(`/mcp/tokens/${scoped.id}`, { method: 'PATCH', body: JSON.stringify({ allowDelete: true }) }, c); } catch (e) { deleteNeedsManage = e.code === 'VALIDATION'; }
  result.allowDeleteNeedsManage = deleteNeedsManage;
  await q(`/mcp/tokens/${scoped.id}`, { method: 'PATCH', body: JSON.stringify({ rw: 'manage', allowDelete: true, notebookMode: 'inherit' }) }, c);
  const edited = (await list()).find(t => t.id === scoped.id);
  result.editChangesScopeAndRw = edited.rw === 'manage' && edited.allowDelete === true && edited.notebookMode === 'inherit';

  // 轮换：旧明文立刻失效，新明文可用，权限克隆，列表不膨胀
  const beforeRotate = (await list()).length;
  const rotated = (await q(`/mcp/tokens/${ro.id}/rotate`, { method: 'POST' }, c)).data;
  made.push(rotated.id);
  result.rotateKeepsListSize = (await list()).length === beforeRotate;
  let oldDead = false;
  try { await tool(ro.secret, 'get_me'); } catch (e) { oldDead = /无效|UNAUTH/i.test(e.message); }
  result.rotateKillsOldSecret = oldDead;
  const cloned = await tool(rotated.secret, 'get_me');
  result.rotateClonesPermissions = cloned.rw === 'read';
  result.rotateReturnsConfig = !!rotated.config?.mcpServers?.knowledge?.url;

  // 吊销：立刻失效并从列表消失，但 includeRevoked 仍查得到
  await q(`/mcp/tokens/${rotated.id}`, { method: 'DELETE' }, c);
  result.revokeRemovesFromList = !(await list()).some(t => t.id === rotated.id);
  let revokedDead = false;
  try { await tool(rotated.secret, 'get_me'); } catch { revokedDead = true; }
  result.revokeKillsSecret = revokedDead;
  result.revokedStillAuditable = (await q('/mcp/tokens?includeRevoked=1', {}, c)).data.tokens.some(t => t.id === rotated.id);
  result.listOnlyGrowsByActive = (await list()).length === baseline + 3;
} finally {
  for (const id of made) await q(`/mcp/tokens/${id}`, { method: 'DELETE' }, c).catch(() => {});
  await q(`/workspaces/${ws.id}`, { method: 'DELETE', body: JSON.stringify({ confirmName: ws.name }) }, c).catch(() => {});
}
console.log(JSON.stringify(result, null, 2));
if (!Object.values(result).every(Boolean)) process.exitCode = 1;
