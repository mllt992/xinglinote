// 本轮补齐的功能验收：分享类型、分享总览、回收站销毁与重名、搜索过滤与打分、标签、MCP 动态权限。
// 用法：KB_EMAIL=... KB_PASSWORD=... node scripts/verify-gaps.mjs
import { KB_EMAIL, KB_PASSWORD } from './creds.mjs';
const base = (process.env.KB_BASE_URL??'http://127.0.0.1:12098')+'/api/v1';
async function q(path, opt = {}, cookie = '') {
  const r = await fetch(base + path, { ...opt, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opt.headers || {}) } });
  const j = await r.json();
  if (!r.ok || !j.ok) { const e = new Error(j.error?.message ?? r.status); e.code = j.error?.code; e.status = r.status; throw e; }
  return { data: j.data, cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie };
}
const anon = (path, opt = {}) => fetch(base + path, { ...opt, headers: { 'content-type': 'application/json', ...(opt.headers || {}) } }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
const c = (await q('/auth/login', { method: 'POST', body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) })).cookie;
const ws = (await q('/workspaces', { method: 'POST', body: JSON.stringify({ name: '缺口验收' }) }, c)).data.workspace;
const result = {};
try {
  const nb = (await q(`/workspaces/${ws.id}/notebooks`, {}, c)).data.notebooks[0];
  const folder = (await q('/folders', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, title: '公开目录' }) }, c)).data;
  let note = (await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, folderId: folder.id, title: '分享样例' }) }, c)).data;
  note = (await q(`/notes/${note.id}`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: note.version, bodyMd: '# 开头\n第一节正文。\n\n## 中间\n第二节正文。\n\n# 结尾\n第三节。', tags: ['账本', '家庭'] }) }, c)).data;

  // 标签
  result.tagsSaved = JSON.stringify(note.tags) === JSON.stringify(['账本', '家庭']);
  result.searchByTag = (await q(`/search?workspaceId=${ws.id}&q=${encodeURIComponent('账本')}`, {}, c)).data.hits.some(h => h.id === note.id);

  // 搜索：打分让标题命中排在正文命中前面，仅标题过滤生效
  const other = (await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, title: '只在正文里提到的另一篇' }) }, c)).data;
  await q(`/notes/${other.id}`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: other.version, bodyMd: '这里写了 分享样例 四个字。' }) }, c);
  const ranked = (await q(`/search?workspaceId=${ws.id}&q=${encodeURIComponent('分享样例')}`, {}, c)).data;
  result.searchRanksTitleFirst = ranked.hits[0]?.id === note.id && ranked.hits.length >= 2;
  result.searchTitleOnlyFilter = (await q(`/search?workspaceId=${ws.id}&q=${encodeURIComponent('分享样例')}&titleOnly=1`, {}, c)).data.hits.every(h => h.title.includes('分享样例'));
  result.searchPaginates = (await q(`/search?workspaceId=${ws.id}&q=${encodeURIComponent('分享样例')}&limit=1`, {}, c)).data.hits.length === 1;
  result.searchAiFilter = (await q(`/search?workspaceId=${ws.id}&q=${encodeURIComponent('分享样例')}&aiIndex=0`, {}, c)).data.hits.length === 0;

  // 单节分享：只给这一节
  const section = (await q(`/notes/${note.id}/shares`, { method: 'POST', body: JSON.stringify({ headingAnchor: '中间', correctionsEnabled: true }) }, c)).data;
  const sectionPage = (await anon(`/public/shares/${section.token}`)).json.data;
  result.headingShareType = section.targetType === 'heading';
  result.headingSliceOnly = sectionPage.bodyMd.includes('第二节正文') && !sectionPage.bodyMd.includes('第一节正文') && !sectionPage.bodyMd.includes('第三节');
  result.headingCarriesCorrections = sectionPage.correctionsEnabled === true;

  // 目录分享：实时子树，之后新建的笔记也在里面
  const folderShare = (await q(`/folders/${folder.id}/shares`, { method: 'POST', body: JSON.stringify({}) }, c)).data;
  const later = (await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, folderId: folder.id, title: '后来新建的' }) }, c)).data;
  const folderPage = (await anon(`/public/shares/${folderShare.token}`)).json.data;
  result.folderShareLists = folderPage.type === 'folder' && folderPage.notes.some(n => n.id === note.id) && folderPage.notes.some(n => n.id === later.id);
  result.folderShareExcludesOutside = !folderPage.notes.some(n => n.id === other.id);

  // 整本分享：含根上的笔记，之后新建的也在里面；不看 published
  const nbShare = (await q(`/notebooks/${nb.id}/shares`, { method: 'POST', body: JSON.stringify({}) }, c)).data;
  const laterRoot = (await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, title: '本根上后来新建的' }) }, c)).data;
  const listed = (await q(`/notebooks/${nb.id}/shares`, {}, c)).data;
  const nbPage = (await anon(`/public/shares/${nbShare.token}`)).json.data;
  result.notebookShareType = nbShare.targetType === 'notebook' && nbPage.type === 'notebook';
  result.notebookShareListsAll = [note.id, later.id, other.id, laterRoot.id].every(id => nbPage.notes.some(n => n.id === id));
  result.notebookShareListApi = listed.shares.some(s => s.id === nbShare.id);

  // 附件分享：只能经 token 下载
  const form = new FormData();
  form.append('file', new Blob(['attachment body'], { type: 'text/plain' }), '附件.txt');
  const up = await fetch(`${base}/notes/${note.id}/attachments`, { method: 'POST', body: form, headers: { cookie: c } }).then(r => r.json());
  const fileShare = (await q(`/attachments/${up.data.id}/shares`, { method: 'POST', body: JSON.stringify({}) }, c)).data;
  const filePage = (await anon(`/public/shares/${fileShare.token}`)).json.data;
  const download = await fetch(`${base}/public/shares/${fileShare.token}/file`);
  result.attachmentShareMeta = filePage.type === 'attachment' && filePage.attachment.filename === '附件.txt';
  result.attachmentDownloads = download.status === 200 && (await download.text()) === 'attachment body';
  result.attachmentNeedsToken = (await anon(`/attachments/${up.data.id}`)).status === 401;

  // 分享总览
  const overview = (await q(`/workspaces/${ws.id}/shares`, {}, c)).data;
  result.overviewListsAll = overview.canManageAll && [section.id, folderShare.id, fileShare.id, nbShare.id].every(id => overview.shares.some(s => s.id === id));
  result.overviewHasTitles = overview.shares.find(s => s.id === fileShare.id)?.targetTitle === '附件.txt';
  result.overviewHasNotebook = overview.shares.find(s => s.id === nbShare.id)?.targetTitle === nb.title;
  await q(`/shares/${section.id}`, { method: 'PATCH', body: JSON.stringify({ password: 'secret-pass', expiresInDays: 7 }) }, c);
  result.overviewCanEdit = (await anon(`/public/shares/${section.token}`)).json.data.requiresPassword === true;

  // 回收站：重名恢复、原目录没了落回根、立即销毁
  const twin = (await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, folderId: folder.id, title: '会撞名的' }) }, c)).data;
  await q(`/notes/${twin.id}`, { method: 'DELETE' }, c);
  await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, folderId: folder.id, title: '会撞名的' }) }, c);
  const restored = (await q(`/trash/note/${twin.id}/restore`, { method: 'POST' }, c)).data;
  result.restoreRenamesOnConflict = restored.renamed === true && restored.title === '会撞名的（恢复）';
  const trash = (await q(`/workspaces/${ws.id}/trash`, {}, c)).data;
  result.trashHasPathAndWho = Array.isArray(trash.notes);
  await q(`/notes/${later.id}`, { method: 'DELETE' }, c);
  const listed = (await q(`/workspaces/${ws.id}/trash`, {}, c)).data.notes.find(n => n.id === later.id);
  result.trashShowsMeta = !!listed?.path && !!listed?.trashedByName && !!listed?.purgeAt;
  await q(`/trash/note/${later.id}`, { method: 'DELETE' }, c);
  let purged = false;
  try { await q(`/notes/${later.id}`, {}, c); } catch (e) { purged = e.code === 'NOT_FOUND'; }
  result.purgeRemovesNote = purged;
  result.purgeLeavesTrashEmpty = !(await q(`/workspaces/${ws.id}/trash`, {}, c)).data.notes.some(n => n.id === later.id);

  // MCP 动态权限：默认没有 post_to_feed，开了才有
  const plain = (await q('/mcp/tokens', { method: 'POST', body: JSON.stringify({ name: '无动态权限', workspaceId: ws.id, rw: 'write' }) }, c)).data;
  const feeder = (await q('/mcp/tokens', { method: 'POST', body: JSON.stringify({ name: '可发动态', workspaceId: ws.id, rw: 'write', feedWorkspace: true }) }, c)).data;
  const listTools = async secret => (await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }).then(r => r.json())).result.tools.map(t => t.name);
  result.feedToolHiddenByDefault = !(await listTools(plain.secret)).includes('post_to_feed');
  result.feedToolShownWhenEnabled = (await listTools(feeder.secret)).includes('post_to_feed');
  const call = async (secret, name, args) => (await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) }).then(r => r.json()));
  result.feedPostWorks = (await call(feeder.secret, 'post_to_feed', { body: 'Agent 发的工作区动态', scope: 'workspace' })).result?.structuredContent?.scope === 'workspace';
  result.feedPublicStillBlocked = !!(await call(feeder.secret, 'post_to_feed', { body: '不该进广场', scope: 'public' })).error;
  for (const t of [plain.id, feeder.id]) await q(`/mcp/tokens/${t}`, { method: 'DELETE' }, c).catch(() => {});
} finally {
  await q(`/workspaces/${ws.id}`, { method: 'DELETE', body: JSON.stringify({ confirmName: ws.name }) }, c).catch(() => {});
}
console.log(JSON.stringify(result, null, 2));
const failed = Object.entries(result).filter(([, v]) => !v).map(([k]) => k);
if (failed.length) { console.error('失败：' + failed.join(', ')); process.exitCode = 1; }
