// MCP 工具合同：动态减清单、注解、搜索、替换、最近、今天、幂等。
import { KB_EMAIL, KB_PASSWORD } from './creds.mjs';

const base = (process.env.KB_BASE_URL ?? 'http://127.0.0.1:12098') + '/api/v1';
async function api(path, opt = {}, cookie = '') {
  const r = await fetch(base + path, { ...opt, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opt.headers || {}) } });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error?.message);
  return { data: j.data, cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie };
}

const cookie = (await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) })).cookie;
const me = (await api('/me', {}, cookie)).data;
const nb = (await api(`/workspaces/${me.personalWorkspaceId}/notebooks`, {}, cookie)).data.notebooks[0];
const manage = (await api('/mcp/tokens', { method: 'POST', body: JSON.stringify({ name: '工具验收', workspaceId: me.personalWorkspaceId, rw: 'manage', allowDelete: true, allowPrivateNotebooks: true, feedPublic: true, dailyWriteLimitBytes: 1024 * 1024 }) }, cookie)).data;
const read = (await api('/mcp/tokens', { method: 'POST', body: JSON.stringify({ name: '只读验收', workspaceId: me.personalWorkspaceId, rw: 'read' }) }, cookie)).data;
const write = (await api('/mcp/tokens', { method: 'POST', body: JSON.stringify({ name: '读写验收', workspaceId: me.personalWorkspaceId, rw: 'write' }) }, cookie)).data;

let seq = 1;
async function rpc(secret, method, params) {
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify({ jsonrpc: '2.0', id: seq++, method, params }) });
  return r.json();
}
async function call(secret, name, args = {}, extra = {}) {
  const r = await fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}`, ...(extra.idem ? { 'Idempotency-Key': extra.idem } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: seq++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await r.json();
  if (j.error) { const e = new Error(j.error.message); e.data = j.error.data; throw e; }
  return j.result.structuredContent;
}

const result = {};
try {
  const init = await rpc(manage.secret, 'initialize');
  result.hasInstructions = typeof init.result?.instructions === 'string' && init.result.instructions.includes('get_me');

  const listed = (await rpc(manage.secret, 'tools/list')).result.tools;
  const names = listed.map(t => t.name);
  result.hasCoreTools = ['list_folder', 'move_note', 'add_tags', 'replace_in_note', 'list_recent', 'today', 'list_attachments', 'upload_image'].every(n => names.includes(n));
  result.annotationsPresent = listed.every(t => t.annotations && typeof t.annotations.readOnlyHint === 'boolean');
  result.trashHintedDestructive = listed.find(t => t.name === 'trash_note')?.annotations?.destructiveHint === true;

  const readNames = (await rpc(read.secret, 'tools/list')).result.tools.map(t => t.name);
  result.readHidesWrite = !readNames.includes('create_note') && !readNames.includes('trash_note') && readNames.includes('search_notes');
  const writeNames = (await rpc(write.secret, 'tools/list')).result.tools.map(t => t.name);
  result.writeHidesTrash = writeNames.includes('create_note') && writeNames.includes('upload_image') && !writeNames.includes('trash_note') && !writeNames.includes('move_note');
  result.readHidesUpload = readNames.includes('list_attachments') && !readNames.includes('upload_image');

  const meInfo = await call(manage.secret, 'get_me');
  result.getMeHasNotebooks = Array.isArray(meInfo.notebooks) && meInfo.notebooks.some(n => n.id === nb.id);
  result.getMeHasImageCap = typeof meInfo.image_max_bytes === 'number' && meInfo.image_max_bytes >= 262144;

  const created = await call(manage.secret, 'create_note', { notebook_id: nb.id, title: 'MCP 新工具验收', content: 'alpha 第一段\nalpha 第二段', tags: ['初始'] });
  const tagged = await call(manage.secret, 'add_tags', { id: created.id, tags: ['知识', '测试'] });
  const listedFolder = await call(manage.secret, 'list_folder', { notebook_id: nb.id });
  const note = await call(manage.secret, 'get_note', { id: created.id });
  result.created = !!created.id;
  result.tagsPersisted = tagged.tags.includes('知识') && note.tags.includes('知识');
  result.folderListsNote = listedFolder.notes.some(x => x.id === created.id);
  result.getNoteHasPath = Array.isArray(note.path) && note.path.includes(note.title);

  const hidden = await api(`/notes/${created.id}`, { method: 'PATCH', body: JSON.stringify({ aiIndex: false, expectedVersion: note.version }) }, cookie);
  let missing = false;
  try { await call(manage.secret, 'get_note', { id: created.id }); } catch (e) { missing = /不存在|NOT_FOUND/i.test(e.message) || e.data?.code === 'NOT_FOUND'; }
  result.aiIndexHiddenAsNotFound = missing;
  await api(`/notes/${created.id}`, { method: 'PATCH', body: JSON.stringify({ aiIndex: true, expectedVersion: hidden.data.version }) }, cookie);
  const fresh = await call(manage.secret, 'get_note', { id: created.id });

  const replaced = await call(manage.secret, 'replace_in_note', { id: created.id, expected_version: fresh.version, old: '第一段', new: '首段' });
  const after = await call(manage.secret, 'get_note', { id: created.id });
  result.replaceWorks = replaced.replacements === 1 && after.body_md.includes('首段') && after.body_md.includes('第二段');

  const movePreview = await call(manage.secret, 'move_note', { id: created.id, expected_version: after.version, notebook_id: nb.id, folder_id: null, dry_run: true });
  const afterMovePreview = await call(manage.secret, 'get_note', { id: created.id });
  result.moveDryRunHasNoEffect = movePreview.dry_run === true && movePreview.current_version === after.version && afterMovePreview.version === after.version;
  const trashPreview = await call(manage.secret, 'trash_note', { id: created.id, expected_version: after.version, dry_run: true });
  result.trashDryRunHasNoEffect = trashPreview.effect === 'move_to_trash' && (await call(manage.secret, 'get_note', { id: created.id })).version === after.version;
  let versionConflict = false;
  try { await call(manage.secret, 'trash_note', { id: created.id, expected_version: after.version - 1 }); }
  catch (e) { versionConflict = e.data?.code === 'CONFLICT_VERSION'; }
  result.trashRejectsStaleVersion = versionConflict;
  const feedPreview = await call(manage.secret, 'post_to_feed', { body: '公开发布预览', scope: 'public', dry_run: true });
  let confirmationRequired = false;
  try { await call(manage.secret, 'post_to_feed', { body: '不应发布', scope: 'public' }); }
  catch (e) { confirmationRequired = e.data?.code === 'CONFIRMATION_REQUIRED'; }
  result.publicFeedHasPreviewAndConfirmation = feedPreview.required_confirmation?.confirm_public === true && confirmationRequired;

  const searched = await call(manage.secret, 'search_notes', { query: '首段', mode: 'keyword' });
  result.searchReturnsHits = Array.isArray(searched.hits) && searched.hits.some(h => h.id === created.id && h.snippet && h.path);

  const recent = await call(manage.secret, 'list_recent', { limit: 10 });
  result.listRecentHasNote = recent.notes.some(n => n.id === created.id && n.version && n.path);

  const today = await call(manage.secret, 'today');
  result.todayShape = typeof today.date === 'string' && Array.isArray(today.items) && Array.isArray(today.overdue) && Array.isArray(today.notes);

  const requestId = crypto.randomUUID();
  const idemArgs = { notebook_id: nb.id, title: '幂等笔记', client_request_id: requestId };
  const [first, second] = await Promise.all([
    call(manage.secret, 'create_note', idemArgs),
    call(manage.secret, 'create_note', idemArgs),
  ]);
  result.idempotentCreate = first.id === second.id;
  let reusedRejected = false;
  try { await call(manage.secret, 'create_note', { ...idemArgs, title: '幂等键不应换参数' }); }
  catch (e) { reusedRejected = e.data?.code === 'IDEMPOTENCY_KEY_REUSED'; }
  result.idempotencyRejectsChangedArgs = reusedRejected;

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const uploaded = await call(manage.secret, 'upload_image', { note_id: created.id, filename: 'dot.png', mime: 'image/png', data_base64: `data:image/png;base64,${png}` });
  result.uploadReturnsMarkdown = typeof uploaded.markdown === 'string' && uploaded.markdown.includes(uploaded.id);
  const atts = await call(manage.secret, 'list_attachments', { note_id: created.id });
  result.listSeesUpload = atts.attachments.some(a => a.id === uploaded.id);
  const still = await call(manage.secret, 'get_note', { id: created.id });
  result.uploadDoesNotRewriteBody = still.body_md === after.body_md;
  let oversizeBlocked = false;
  try { await call(manage.secret, 'upload_image', { note_id: created.id, filename: 'huge.png', mime: 'image/png', data_base64: Buffer.alloc(6 * 1024 * 1024).toString('base64') }); }
  catch (e) { oversizeBlocked = /超过|QUOTA/i.test(e.message) || e.data?.code === 'QUOTA' || e.data?.code === 'VALIDATION'; }
  result.uploadRejectsOversize = oversizeBlocked;

  const logs = (await api(`/workspaces/${me.personalWorkspaceId}/mcp-audit?tool=replace_in_note&limit=20`, {}, cookie)).data.logs;
  result.auditFilterable = logs.some(l => l.action === 'mcp.replace_in_note' && l.result === 'ok');

  const ping = await rpc(manage.secret, 'ping');
  result.pingOk = !!ping.result && !ping.error;
  const unknown = await rpc(manage.secret, 'resources/list');
  result.unknownMethodNamed = unknown.error?.data?.code === 'VALIDATION' && /不支持的方法：resources\/list/.test(unknown.error?.message || '');
  const errLogs = (await api(`/workspaces/${me.personalWorkspaceId}/mcp-audit?result=error&limit=20`, {}, cookie)).data.logs;
  result.errorAuditHasReason = errLogs.some(l => l.action === 'mcp.resources/list' && l.details?.code === 'VALIDATION' && /不支持的方法/.test(l.details?.message || ''));
} finally {
  for (const t of [manage.id, read.id, write.id]) await api(`/mcp/tokens/${t}`, { method: 'DELETE' }, cookie).catch(() => {});
}

console.log(JSON.stringify(result, null, 2));
const failed = Object.entries(result).filter(([, v]) => !v).map(([k]) => k);
if (failed.length) { console.error('失败：' + failed.join(', ')); process.exitCode = 1; }
