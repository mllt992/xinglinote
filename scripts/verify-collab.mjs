// 协同编辑验收（设计 17 §3.4）：两个客户端真收敛、落库回 notes.body_md、
// 只读连接发不出更新、无权的人连不上、外部写会回灌进房间。
// 用法：KB_EMAIL=... KB_PASSWORD=... node scripts/verify-collab.mjs
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { KB_EMAIL, KB_PASSWORD, TEST_PASSWORD } from './creds.mjs';

const origin = process.env.KB_BASE_URL ?? 'http://127.0.0.1:12098';
const base = origin + '/api/v1';
const MESSAGE_SYNC = 0, MESSAGE_AWARENESS = 1;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function q(path, opt = {}, cookie = '') {
  const r = await fetch(base + path, { ...opt, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opt.headers || {}) } });
  const j = await r.json();
  if (!r.ok || !j.ok) { const e = new Error(j.error?.message ?? r.status); e.code = j.error?.code; throw e; }
  return { data: j.data, cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie };
}

/** 一个最小的协同客户端：够用来验协议，不引 y-websocket（那是浏览器那侧的事）。 */
function connect(noteId, cookie) {
  const doc = new Y.Doc();
  const text = doc.getText('body');
  const awareness = new awarenessProtocol.Awareness(doc);
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/v1/notes/${noteId}/collab`, { headers: { cookie } });
  const client = { doc, text, awareness, ws, synced: false, rejected: null };

  ws.on('unexpected-response', (_req, res) => { client.rejected = res.statusCode; ws.terminate(); });
  ws.on('error', () => { client.rejected ??= 0; });
  ws.on('open', () => {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(e, doc);
    ws.send(encoding.toUint8Array(e));
  });
  ws.on('message', data => {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    const encoder = encoding.createEncoder();
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const before = doc.store.clients.size;
      syncProtocol.readSyncMessage(decoder, encoder, doc, ws);
      if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
      if (before >= 0) client.synced = true;
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), ws);
    }
  });
  doc.on('update', (update, o) => {
    if (o === ws || ws.readyState !== 1) return;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MESSAGE_SYNC);
    syncProtocol.writeUpdate(e, update);
    ws.send(encoding.toUint8Array(e));
  });
  client.setCursor = state => {
    awareness.setLocalState(state);
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]));
    if (ws.readyState === 1) ws.send(encoding.toUint8Array(e));
  };
  client.close = () => { try { ws.close(); } catch { /* 已经断了 */ } };
  return client;
}

const until = async (fn, ms = 12_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(250); }
  return false;
};

const c = (await q('/auth/login', { method: 'POST', body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) })).cookie;
const ws = (await q('/workspaces', { method: 'POST', body: JSON.stringify({ name: '协同验收' }) }, c)).data.workspace;
const result = {};
const clients = [];
try {
  const nb = (await q(`/workspaces/${ws.id}/notebooks`, { method: 'POST', body: JSON.stringify({ title: '协同', slug: 'collab' }) }, c)).data;
  let note = (await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, title: '协同验收' }) }, c)).data;
  const patched = (await q(`/notes/${note.id}`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: note.version, bodyMd: '起始正文\n' }) }, c)).data;
  // 保存的响应必须带 canEdit（架构 03 §3）：前端拿它整个换掉手上的笔记对象，缺这一个字段整篇就变只读
  // ——编辑器锁上、协同房间被拆、自动保存自己停掉，人还停在编辑页却怎么打字都存不进去，非刷新不可。
  result.saveKeepsCanEdit = patched.canEdit === true;
  note = patched;
  const read = async () => (await q(`/notes/${note.id}`, {}, c)).data.bodyMd;

  // —— 两个客户端 ——
  const a = connect(note.id, c), b = connect(note.id, c);
  clients.push(a, b);
  result.bothConnect = await until(async () => a.synced && b.synced);
  result.roomSeedsFromNote = await until(async () => a.text.toString() === '起始正文\n' && b.text.toString() === '起始正文\n');

  a.text.insert(a.text.length, 'A 写的一句\n');
  b.text.insert(0, 'B 写在开头\n');
  result.bothDirectionsConverge = await until(async () =>
    a.text.toString() === b.text.toString()
    && a.text.toString().includes('A 写的一句')
    && a.text.toString().includes('B 写在开头'));
  const merged = a.text.toString();
  // 两个人各写各的，谁的都不能丢——这是引 CRDT 的全部理由
  result.nobodyLosesText = merged.startsWith('B 写在开头') && merged.includes('起始正文') && merged.endsWith('A 写的一句\n');

  // —— 落库：3 秒静默后房间自己写回 notes.body_md ——
  result.persistsToNote = await until(async () => (await read()) === merged, 20_000);
  const after = (await q(`/notes/${note.id}`, {}, c)).data;
  result.bumpsVersion = after.version > note.version;
  const versions = (await q(`/notes/${note.id}/versions`, {}, c)).data.versions;
  result.versionSourceIsCollab = versions[0]?.source === 'collab';

  // 再改一次：5 分钟内的连续协同落库应当复用同一条版本，而不是每 3 秒堆一条
  const before = versions.length;
  a.text.insert(a.text.length, '再补一句\n');
  result.secondRoundPersists = await until(async () => (await read()).includes('再补一句'), 20_000);
  result.versionsMerged = (await q(`/notes/${note.id}/versions`, {}, c)).data.versions.length === before;

  // —— 外部写（MCP / AI / 恢复版本那条路）要回灌进房间 ——
  const live = (await q(`/notes/${note.id}`, {}, c)).data;
  await q(`/notes/${note.id}`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: live.version, bodyMd: `${live.bodyMd}外面加的一行\n` }) }, c);
  result.externalWriteFlowsBackIn = await until(async () => a.text.toString().includes('外面加的一行'), 25_000);
  result.externalWriteKeepsRoomText = a.text.toString().includes('A 写的一句') && a.text.toString().includes('B 写在开头');

  // —— 房间不是唯一的写者：改标题这类 PATCH 会照常抢版本号 ——
  // 之前这里会让房间和 PATCH 撞上 note_versions 的唯一键，未捕获的 rejection 直接打死 api 进程
  a.text.insert(a.text.length, '和改标题同时发生的一句\n');
  const racing = (await q(`/notes/${note.id}`, {}, c)).data;
  await q(`/notes/${note.id}`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: racing.version, title: '协同验收（改过名）' }) }, c);
  result.concurrentTitlePatchSurvives = await until(async () => (await read()).includes('和改标题同时发生的一句'), 25_000);
  const raced = (await q(`/notes/${note.id}`, {}, c)).data;
  result.bothWritesLand = raced.title === '协同验收（改过名）' && raced.bodyMd.includes('和改标题同时发生的一句');
  result.apiStillAlive = (await q(`/notes/${note.id}`, {}, c)).data.id === note.id;

  // —— awareness：光标传得过去 ——
  a.setCursor({ user: { id: 'u-a', name: '甲', color: '#2563eb' }, cursor: { anchor: 1, head: 3 } });
  result.cursorReachesPeer = await until(async () =>
    [...b.awareness.getStates().values()].some(s => s?.user?.name === '甲' && s?.cursor));

  /** 造一个新账号，可选直接绑进本工作区。绑定走注册码，省掉邀请那一跳。 */
  async function newUser(label, role) {
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const code = (await q('/admin/registration-codes', {
      method: 'POST',
      body: JSON.stringify({ quantity: 1, maxUses: 1, skipEmailVerification: true, ...(role ? { bindWorkspaceId: ws.id, bindRole: role } : {}) }),
    }, c)).data.codes[0];
    return (await q('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: `collab-${suffix}@example.test`, password: TEST_PASSWORD, handle: `cb${suffix}`, displayName: label, registrationCode: code }),
    })).cookie;
  }

  // —— 只读成员：收得到光标，发不出更新 ——
  const viewer = await newUser('只读的人', 'viewer');

  const v = connect(note.id, viewer);
  clients.push(v);
  result.viewerConnects = await until(async () => v.synced);
  result.viewerSeesText = v.text.toString() === a.text.toString();
  const beforeWrite = a.text.toString();
  v.text.insert(0, '只读的人不该写得进去\n');
  await sleep(2500);
  result.viewerCannotWrite = !a.text.toString().includes('只读的人不该写得进去') && a.text.toString() === beforeWrite;
  result.viewerWriteNeverPersists = !(await read()).includes('只读的人不该写得进去');

  // —— 无权的人连不上，而且不告诉他这篇存不存在 ——
  const outsider = await newUser('外人', null);
  const o = connect(note.id, outsider);
  clients.push(o);
  await sleep(2500);
  result.outsiderRejected = o.rejected === 404;
  result.anonymousRejected = await (async () => { const n = connect(note.id, ''); clients.push(n); await sleep(2000); return n.rejected === 404; })();
} finally {
  for (const x of clients) x.close?.();
  await sleep(500);
  await q(`/workspaces/${ws.id}`, { method: 'DELETE' }, c).catch(() => {});
}
console.log(JSON.stringify(result, null, 2));
if (!Object.values(result).every(Boolean)) process.exitCode = 1;
process.exit();
