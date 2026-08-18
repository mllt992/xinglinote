// 导入向导、md 压缩包导出、版本裁剪的验收（规格 03 / 06）。
// 用法：KB_EMAIL=... KB_PASSWORD=... node scripts/verify-transfer.mjs
import { inflateRawSync } from 'node:zlib';
import { KB_EMAIL, KB_PASSWORD } from './creds.mjs';
const base = (process.env.KB_BASE_URL??'http://127.0.0.1:12098')+'/api/v1';
async function q(path, opt = {}, cookie = '') {
  const r = await fetch(base + path, { ...opt, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opt.headers || {}) } });
  const j = await r.json();
  if (!r.ok || !j.ok) { const e = new Error(j.error?.message ?? r.status); e.code = j.error?.code; e.status = r.status; throw e; }
  return { data: j.data, cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie };
}
/** 只读中央目录就够验收：拿到路径清单与每个条目的正文。 */
function readZip(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('不是有效的 zip');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(p + 10, true), compressed = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true), commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const raw = buf.subarray(start, start + compressed);
    out.push({ name, text: () => (method === 8 ? inflateRawSync(Buffer.from(raw)) : Buffer.from(raw)).toString('utf8') });
  }
  return out;
}
const c = (await q('/auth/login', { method: 'POST', body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) })).cookie;
const ws = (await q('/workspaces', { method: 'POST', body: JSON.stringify({ name: '导入导出验收' }) }, c)).data.workspace;
const result = {};
try {
  const nb = (await q(`/workspaces/${ws.id}/notebooks`, {}, c)).data.notebooks[0];
  const files = [
    { path: '手册/入门.md', content: '---\ntitle: "来自 frontmatter 的标题"\nid: 外来的 id\n---\n\n第一篇正文。' },
    { path: '手册/深一层/进阶.md', content: '# 进阶\n第二篇正文。' },
    { path: '散装.md', content: '没有目录的一篇。' },
  ];

  // 预览不写库
  const preview = (await q(`/notebooks/${nb.id}/import-preview`, { method: 'POST', body: JSON.stringify({ files }) }, c)).data;
  result.previewPlansFolders = preview.newFolders.includes('手册') && preview.newFolders.includes('手册/深一层');
  result.previewUsesFrontmatterTitle = preview.items.some(i => i.title === '来自 frontmatter 的标题');
  result.previewDoesNotWrite = (await q(`/notebooks/${nb.id}/tree`, {}, c)).data.notes.length === 0;

  // 真导入：建目录、frontmatter 被剥掉
  const first = (await q(`/notebooks/${nb.id}/import-markdown`, { method: 'POST', body: JSON.stringify({ files }) }, c)).data;
  const tree = (await q(`/notebooks/${nb.id}/tree`, {}, c)).data;
  result.importCreatesFolders = tree.folders.some(f => f.title === '手册') && tree.folders.some(f => f.title === '深一层');
  result.importPlacesNotesInFolders = tree.notes.filter(n => n.folderId).length === 2 && tree.notes.some(n => !n.folderId);
  const front = (await q(`/notes/${first.created.find(x => x.title === '来自 frontmatter 的标题').id}`, {}, c)).data;
  result.importStripsFrontmatter = front.bodyMd.startsWith('第一篇正文') && !front.bodyMd.includes('外来的 id');

  // 重名三策略
  const dup = [{ path: '散装.md', content: '第二次导入的正文。' }];
  const renamed = (await q(`/notebooks/${nb.id}/import-markdown`, { method: 'POST', body: JSON.stringify({ files: dup, mode: 'rename' }) }, c)).data;
  result.modeRename = renamed.created[0]?.title === '散装 2';
  const skipped = (await q(`/notebooks/${nb.id}/import-markdown`, { method: 'POST', body: JSON.stringify({ files: dup, mode: 'skip' }) }, c)).data;
  result.modeSkip = skipped.skipped.length === 1 && skipped.created.length === 0;
  const over = (await q(`/notebooks/${nb.id}/import-markdown`, { method: 'POST', body: JSON.stringify({ files: dup, mode: 'overwrite' }) }, c)).data;
  const overwritten = (await q(`/notes/${over.overwritten[0].id}`, {}, c)).data;
  result.modeOverwrite = over.overwritten.length === 1 && overwritten.bodyMd === '第二次导入的正文。';
  result.overwriteKeepsHistory = (await q(`/notes/${overwritten.id}/versions`, {}, c)).data.versions.some(v => v.source === 'import');

  // 附件也要进包，正文链接改成相对路径
  const form = new FormData();
  form.append('file', new Blob(['zip 里的附件'], { type: 'text/plain' }), '说明.txt');
  const up = await fetch(`${base}/notes/${front.id}/attachments`, { method: 'POST', body: form, headers: { cookie: c } }).then(r => r.json());
  const withLink = (await q(`/notes/${front.id}`, {}, c)).data;
  await q(`/notes/${front.id}`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: withLink.version, bodyMd: `正文引用了 [说明](${up.data.url})` }) }, c);

  const zipBuf = new Uint8Array(await fetch(`${base}/workspaces/${ws.id}/export.zip`, { headers: { cookie: c } }).then(r => r.arrayBuffer()));
  const entries = readZip(zipBuf);
  const paths = entries.map(e => e.name);
  result.zipHasHumanTree = paths.some(p => p.includes('手册/深一层/进阶.md')) && paths.some(p => p.endsWith('散装.md'));
  result.zipHasAttachment = paths.some(p => p.includes('.附件/说明.txt'));
  const noteEntry = entries.find(e => e.name.endsWith('来自 frontmatter 的标题.md'));
  const noteText = noteEntry.text();
  result.zipNoteHasFrontmatter = noteText.startsWith('---') && noteText.includes('title: "来自 frontmatter 的标题"');
  result.zipRewritesAttachmentLink = noteText.includes('./来自 frontmatter 的标题.附件/说明.txt') && !noteText.includes('/api/v1/attachments/');
  result.attachmentContentIntact = entries.find(e => e.name.includes('.附件/说明.txt')).text() === 'zip 里的附件';

  // 单个笔记本、单篇也能导
  result.notebookZipWorks = readZip(new Uint8Array(await fetch(`${base}/notebooks/${nb.id}/export.zip`, { headers: { cookie: c } }).then(r => r.arrayBuffer()))).length > 0;
  result.singleNoteZipWorks = readZip(new Uint8Array(await fetch(`${base}/notes/${front.id}/export.zip`, { headers: { cookie: c } }).then(r => r.arrayBuffer()))).some(e => e.name.endsWith('.md'));

  // 版本裁剪：造 110 版。走接口要两百多秒，直接往版本表塞几行就够验裁剪逻辑了。
  const churn = (await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, title: '改很多次的笔记' }) }, c)).data;
  const { db } = await import('../apps/api/src/db/client.ts');
  const { noteVersions } = await import('../apps/api/src/db/schema.ts');
  await db.insert(noteVersions).values(Array.from({ length: 110 }, (_, i) => ({ noteId: churn.id, version: i + 2, title: churn.title, bodyMd: `第 ${i} 次`, editorId: churn.createdBy, source: 'ui' })));
  const before = (await q(`/notes/${churn.id}/versions`, {}, c)).data.total;
  const pruned = await import('../apps/api/src/lib/versions.ts').then(m => m.pruneNoteVersions());
  const after = (await q(`/notes/${churn.id}/versions`, {}, c)).data.total;
  result.versionsGrewPast100 = before > 100;
  result.pruneKeepsRecent100 = pruned > 0 && after >= 100 && after < before;
  // 100 版之外，当天还会留一版兜底，所以是 101 不是 100
  result.pruneKeepsOnePerDay = after === 101;
} finally {
  await q(`/workspaces/${ws.id}`, { method: 'DELETE', body: JSON.stringify({ confirmName: ws.name }) }, c).catch(() => {});
}
console.log(JSON.stringify(result, null, 2));
const failed = Object.entries(result).filter(([, v]) => !v).map(([k]) => k);
if (failed.length) { console.error('失败：' + failed.join(', ')); process.exitCode = 1; }
