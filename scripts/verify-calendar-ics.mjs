// ICS 进出与日历 MCP 工具验收（设计 16 §4.6、§6.3）。
// 用法：KB_EMAIL=... KB_PASSWORD=... node scripts/verify-calendar-ics.mjs
import { KB_EMAIL, KB_PASSWORD } from './creds.mjs';
const origin = process.env.KB_BASE_URL ?? 'http://127.0.0.1:12098';
const base = origin + '/api/v1';

async function q(path, opt = {}, cookie = '') {
  const r = await fetch(base + path, { ...opt, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opt.headers || {}) } });
  const j = await r.json();
  if (!r.ok || !j.ok) { const e = new Error(j.error?.message ?? r.status); e.code = j.error?.code; e.status = r.status; throw e; }
  return { data: j.data, cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie };
}
const rejects = async (fn, code) => { try { await fn(); return false; } catch (e) { return code ? e.code === code : true; } };
const raw = url => fetch(url).then(async r => ({ status: r.status, type: r.headers.get('content-type') ?? '', body: await r.text() }));
const until = async (fn, tries = 25) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 1000)); } return null; };

const c = (await q('/auth/login', { method: 'POST', body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) })).cookie;
const ws = (await q('/workspaces', { method: 'POST', body: JSON.stringify({ name: '日历 ICS 验收' }) }, c)).data.workspace;
const result = {};
try {
  const nb = (await q(`/workspaces/${ws.id}/notebooks`, {}, c)).data.notebooks[0];
  const event = (await q(`/workspaces/${ws.id}/calendar/items`, { method: 'POST', body: JSON.stringify({ kind: 'event', title: '季度对齐会', bodyMd: '这段备注不该出现在导出里', startsAt: '2027-06-18T07:00:00.000Z', endsAt: '2027-06-18T08:00:00.000Z' }) }, c)).data;

  // —— 导出：token 化、可轮换、可吊销 ——
  const feed = (await q(`/workspaces/${ws.id}/calendar/feed-tokens`, { method: 'POST', body: JSON.stringify({ scope: 'mine' }) }, c)).data;
  result.feedUrlIssued = /^https?:\/\/[^/]+\/calendar\/feed\/[A-Za-z0-9_-]{20,}\.ics$/.test(feed.url);

  const fetched = await raw(feed.url);
  // RFC 5545 规定 75 个八位组折一行，长 URL 一定是折着的：断言前先按协议合并续行
  const unfolded = fetched.body.replace(/\r?\n[ \t]/g, '');
  result.feedServesCalendar = fetched.status === 200 && fetched.type.includes('text/calendar') && fetched.body.startsWith('BEGIN:VCALENDAR');
  result.feedFoldsLongLines = fetched.body.split(/\r?\n/).every(l => Buffer.byteLength(l, 'utf8') <= 75);
  result.feedCarriesEvent = unfolded.includes('季度对齐会') && unfolded.includes('DTSTART:20270618T070000Z');
  // 对外只给标题与时间：正文一个字都不能漏出去
  result.feedHidesBody = !unfolded.includes('这段备注不该出现在导出里') && !unfolded.includes('DESCRIPTION');
  result.feedLinksBack = unfolded.includes(`/w/${ws.id}/calendar?item=${event.id}`);

  const rotated = (await q(`/calendar/feed-tokens/${feed.id}/rotate`, { method: 'POST' }, c)).data;
  result.rotateKillsOldUrl = (await raw(feed.url)).status === 404 && (await raw(rotated.url)).status === 200;
  await q(`/calendar/feed-tokens/${rotated.id}`, { method: 'DELETE' }, c);
  result.revokeKillsUrl = (await raw(rotated.url)).status === 404;
  result.revokedFeedHidden = !(await q(`/workspaces/${ws.id}/calendar/feed-tokens`, {}, c)).data.feeds.some(f => f.id === rotated.id);

  // —— 订阅：URL 是用户填的，等于让服务器替人发请求，内网必须挡住 ——
  const blocked = ['http://127.0.0.1:12099/api/v1/healthz', 'http://localhost/x.ics', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/a.ics', 'http://[::1]/a.ics'];
  const outcomes = [];
  for (const url of blocked) outcomes.push(await rejects(() => q(`/workspaces/${ws.id}/calendar/subscriptions`, { method: 'POST', body: JSON.stringify({ name: '内网', url }) }, c), 'VALIDATION'));
  result.ssrfBlocked = outcomes.every(Boolean);
  result.schemeChecked = await rejects(() => q(`/workspaces/${ws.id}/calendar/subscriptions`, { method: 'POST', body: JSON.stringify({ name: '协议', url: 'file:///etc/passwd' }) }, c), 'VALIDATION');

  // —— MCP 四个工具 ——
  const secret = (await q('/mcp/tokens', { method: 'POST', body: JSON.stringify({ name: '日历工具验收', workspaceId: ws.id, rw: 'write', requireAiIndex: false }) }, c)).data.secret;
  const readOnly = (await q('/mcp/tokens', { method: 'POST', body: JSON.stringify({ name: '日历只读钥匙', workspaceId: ws.id, rw: 'read', requireAiIndex: false }) }, c)).data.secret;
  let seq = 0;
  async function call(name, args = {}, key = secret) {
    const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }) }).then(x => x.json());
    if (r.error) { const e = new Error(r.error.message); e.mcp = true; throw e; }
    return r.result.structuredContent;
  }
  const tools = (await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/list' }) }).then(x => x.json())).result.tools.map(t => t.name);
  result.toolsAdvertised = ['list_tasks', 'list_events', 'create_task', 'complete_task'].every(n => tools.includes(n));

  const created = await call('create_task', { title: 'MCP 建的任务', due_at: '2027-06-19T01:00:00.000Z', priority: 2 });
  result.createTaskWorks = !!created.id && created.url.includes(`/w/${ws.id}/calendar`);
  const listed = (await call('list_tasks', { from: '2027-06-01T00:00:00.000Z', to: '2027-07-01T00:00:00.000Z' })).items;
  result.listTasksFindsIt = listed.some(t => t.id === created.id && t.priority === 2);
  const events = (await call('list_events', { from: '2027-06-01T00:00:00.000Z', to: '2027-07-01T00:00:00.000Z' })).items;
  result.listEventsSeparatesKinds = events.some(e => e.id === event.id) && !events.some(e => e.id === created.id) && !listed.some(t => t.id === event.id);

  const done = await call('complete_task', { id: created.id });
  result.completeTaskWorks = done.status === 'done' && done.note_written === false;
  result.doneFilteredByDefault = !(await call('list_tasks', { from: '2027-06-01T00:00:00.000Z', to: '2027-07-01T00:00:00.000Z' })).items.some(t => t.id === created.id);

  // 只读钥匙不能写：这是「建任务不能绕道改正文」的前提
  result.readKeyCannotCreate = await rejects(() => call('create_task', { title: '不该建出来' }, readOnly));
  result.readKeyCannotComplete = await rejects(() => call('complete_task', { id: created.id }, readOnly));

  // 来自笔记的任务：complete_task 要真的把正文改成 [x]
  let note = (await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, title: 'MCP 回写验收' }) }, c)).data;
  note = (await q(`/notes/${note.id}`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: note.version, bodyMd: '- [ ] 让 MCP 勾掉我 @2027-06-20' }) }, c)).data;
  const noteTask = await until(async () => (await call('list_tasks', { from: '2027-06-01T00:00:00.000Z', to: '2027-07-01T00:00:00.000Z' })).items.find(t => t.title === '让 MCP 勾掉我'));
  result.noteTaskVisibleToMcp = !!noteTask && noteTask.source_note_id === note.id;
  if (noteTask) {
    const wrote = await call('complete_task', { id: noteTask.id });
    const body = (await q(`/notes/${note.id}`, {}, c)).data.bodyMd;
    result.mcpWritesBackToNote = wrote.note_written === true && /- \[x\] 让 MCP 勾掉我/.test(body);
  }
} finally {
  await q(`/workspaces/${ws.id}`, { method: 'DELETE' }, c).catch(() => {});
}
console.log(JSON.stringify(result, null, 2));
if (!Object.values(result).every(Boolean)) process.exitCode = 1;
