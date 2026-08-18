// 备份 / 导出 / 审计 / 冻结 / 通知 / Markdown 导入 的接口验收。
// 用法：KB_EMAIL=... KB_PASSWORD=... node scripts/verify-manage.mjs
import { KB_EMAIL as email, KB_PASSWORD as password } from './creds.mjs';
const base = (process.env.KB_BASE_URL??'http://127.0.0.1:12098')+'/api/v1';
async function q(path, opt = {}, cookie = '') {
  const r = await fetch(base + path, { ...opt, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opt.headers || {}) } });
  const j = await r.json();
  if (!r.ok || !j.ok) { const e = new Error(j.error?.message ?? r.status); e.code = j.error?.code; e.status = r.status; throw e; }
  return { data: j.data, cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie };
}
const c = (await q('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })).cookie;
const ws = (await q('/workspaces', { method: 'POST', body: JSON.stringify({ name: '管理页验收' }) }, c)).data.workspace;
const result = {};
try {
  // 工作区列表要带 frozen，前端冻结开关靠它显示当前状态
  result.listHasFrozen = (await q('/workspaces', {}, c)).data.workspaces.find(x => x.id === ws.id)?.frozen === false;

  // 导入 Markdown
  const nb = (await q(`/workspaces/${ws.id}/notebooks`, {}, c)).data.notebooks[0];
  const imported = (await q(`/notebooks/${nb.id}/import-markdown`, { method: 'POST', body: JSON.stringify({ files: [{ path: '手册/入门.md', content: '# 入门\n第一段。' }, { path: '手册/进阶.md', content: '# 进阶\n第二段。' }] }) }, c)).data;
  const tree = (await q(`/notebooks/${nb.id}/tree`, {}, c)).data;
  result.importCreatesNotes = imported.created.length === 2;
  result.importStripsExtension = imported.created.every(x => !x.title.endsWith('.md')) && imported.created.some(x => x.title === '入门');
  result.importedVisibleInTree = imported.created.every(x => tree.notes.some(n => n.id === x.id));

  // 附件：上传、列出、删除后从列表消失
  const form = new FormData();
  form.append('file', new Blob(['hello attachment'], { type: 'text/plain' }), '说明.txt');
  const uploaded = await fetch(`${base}/notes/${imported.created[0].id}/attachments`, { method: 'POST', body: form, headers: { cookie: c } }).then(r => r.json());
  result.attachmentUploads = uploaded.ok === true && !!uploaded.data.id;
  result.attachmentListed = (await q(`/notes/${imported.created[0].id}/attachments`, {}, c)).data.attachments.some(a => a.id === uploaded.data.id);
  await q(`/attachments/${uploaded.data.id}`, { method: 'DELETE' }, c);
  result.attachmentDeleted = !(await q(`/notes/${imported.created[0].id}/attachments`, {}, c)).data.attachments.some(a => a.id === uploaded.data.id);

  // 导出（原始 JSON，不走 ok 包装）与恢复
  const exported = await fetch(`${base}/workspaces/${ws.id}/export`, { headers: { cookie: c } }).then(r => r.json());
  result.exportHasNotes = exported.format === 'knowledge-backup' && exported.notes.length >= 2;
  result.restoreAccepts = typeof (await q(`/workspaces/${ws.id}/restore`, { method: 'POST', body: JSON.stringify(exported) }, c)).data.restoredNotes === 'number';

  // 冻结：写入应当被拒，解冻后恢复
  await q(`/workspaces/${ws.id}/freeze`, { method: 'PATCH', body: JSON.stringify({ frozen: true }) }, c);
  result.frozenReflectedInList = (await q('/workspaces', {}, c)).data.workspaces.find(x => x.id === ws.id)?.frozen === true;
  try { await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, title: '冻结期间' }) }, c); result.frozenBlocksWrite = false; }
  catch { result.frozenBlocksWrite = true; }
  try { await q(`/workspaces/${ws.id}/notebooks`, { method: 'POST', body: JSON.stringify({ title: '冻结期间的本子' }) }, c); result.frozenBlocksNotebookCreate = false; }
  catch { result.frozenBlocksNotebookCreate = true; }
  try { await q(`/notebooks/${nb.id}/import-markdown`, { method: 'POST', body: JSON.stringify({ files: [{ path: '冻结.md', content: '不该进来' }] }) }, c); result.frozenBlocksImport = false; }
  catch { result.frozenBlocksImport = true; }
  try { await q('/posts', { method: 'POST', body: JSON.stringify({ body: '冻结期间的动态', visibility: 'workspace', workspaceId: ws.id }) }, c); result.frozenBlocksFeedPost = false; }
  catch { result.frozenBlocksFeedPost = true; }
  await q(`/workspaces/${ws.id}/freeze`, { method: 'PATCH', body: JSON.stringify({ frozen: false }) }, c);
  result.unfreezeRestoresWrite = !!(await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, title: '解冻之后' }) }, c)).data.id;

  // 审计日志记下了刚才的冻结与解冻
  const logs = (await q(`/workspaces/${ws.id}/audit`, {}, c)).data.logs;
  result.auditRecordsFreeze = logs.some(l => l.action === 'workspace.freeze') && logs.some(l => l.action === 'workspace.unfreeze');

  // 备份目标：建、列、跑；凭据与口令不能回传前端
  const empty = (await q(`/workspaces/${ws.id}/backups`, {}, c)).data;
  result.backupsStartEmpty = empty.targets.length === 0 && empty.runs.length === 0;
  const target = (await q(`/workspaces/${ws.id}/backups/targets`, { method: 'POST', body: JSON.stringify({ name: '验收 WebDAV', type: 'webdav', endpoint: 'https://nas.example.test/dav', prefix: 'knowledge', schedule: 'daily', retainDaily: 7, retainWeekly: 4, credentials: { username: 'u', password: 'verify-secret-value' }, passphrase: 'verify-passphrase' }) }, c)).data;
  result.targetCreated = !!target.id && !!target.encryptionFingerprint;
  const after = (await q(`/workspaces/${ws.id}/backups`, {}, c)).data;
  result.targetListed = after.targets.some(t => t.id === target.id && t.schedule === 'daily' && t.encryptionFingerprint);
  result.credentialsNeverReturned = !JSON.stringify(after).includes('verify-secret-value') && !JSON.stringify(after).includes('verify-passphrase');
  result.runEnqueued = !!(await q(`/backup-targets/${target.id}/run`, { method: 'POST' }, c)).data.runId;
  result.testEnqueued = !!(await q(`/backup-targets/${target.id}/test`, { method: 'POST' }, c)).data.jobId;

  // 通知中心
  result.notificationsReadable = Array.isArray((await q('/notifications', {}, c)).data.notifications);
  result.notificationsMarkRead = !!(await q('/notifications/read', { method: 'POST' }, c)).data;
} finally {
  await q(`/workspaces/${ws.id}`, { method: 'DELETE', body: JSON.stringify({ confirmName: ws.name }) }, c).catch(() => {});
}
console.log(JSON.stringify(result, null, 2));
if (!Object.values(result).every(Boolean)) process.exitCode = 1;
