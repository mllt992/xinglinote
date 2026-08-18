// 中文分词检索、收藏 / 最近 / 在场、PDF 抽文本进搜索的验收（规格 03 / 05 / 06）。
// 用法：KB_EMAIL=... KB_PASSWORD=... node --experimental-strip-types scripts/verify-workbench.mjs
import { KB_EMAIL, KB_PASSWORD } from './creds.mjs';
const base = (process.env.KB_BASE_URL ?? 'http://127.0.0.1:12098') + '/api/v1';
async function q(path, opt = {}, cookie = '') {
  const r = await fetch(base + path, { ...opt, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opt.headers || {}) } });
  const j = await r.json();
  if (!r.ok || !j.ok) { const e = new Error(j.error?.message ?? r.status); e.code = j.error?.code; e.status = r.status; throw e; }
  return { data: j.data, cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie };
}
/** 手搓一个只含一行文字的 PDF：不压缩，pdfjs 能直接读。 */
function tinyPdf(text) {
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
const c = (await q('/auth/login', { method: 'POST', body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) })).cookie;
const ws = (await q('/workspaces', { method: 'POST', body: JSON.stringify({ name: '工作台验收' }) }, c)).data.workspace;
const result = {};
try {
  const nb = (await q(`/workspaces/${ws.id}/notebooks`, {}, c)).data.notebooks[0];
  const short = (await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, title: '账本' }) }, c)).data;
  const long = (await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, title: '家庭账本' }) }, c)).data;
  await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, title: 'Budget notes' }) }, c);
  const titles = async term => (await q(`/search?workspaceId=${ws.id}&q=${encodeURIComponent(term)}`, {}, c)).data.hits.map(h => h.title);

  // 中文 2-gram：长短互相搜得到，整串命中排前面
  const byShort = await titles('账本'), byLong = await titles('家庭账本');
  result.shortQueryFindsLong = byShort.includes('家庭账本');
  result.longQueryFindsShort = byLong.includes('账本');
  // 「账本」两篇标题都整串命中，排序由新鲜度决定，只要求长查询把整串命中的排前面
  result.exactRanksFirst = byLong[0] === '家庭账本';
  result.englishStillWorks = (await titles('budget')).includes('Budget notes');
  result.irrelevantStaysEmpty = (await titles('潜水艇')).length === 0;

  // 收藏
  await q(`/notes/${long.id}/favorite`, { method: 'PUT' }, c);
  result.favoriteListed = (await q('/me/favorites', {}, c)).data.notes.some(n => n.id === long.id);
  await q(`/notes/${long.id}/favorite`, { method: 'DELETE' }, c);
  result.favoriteRemoved = !(await q('/me/favorites', {}, c)).data.notes.some(n => n.id === long.id);

  // 最近打开 + 在场心跳
  const beat = (await q(`/notes/${short.id}/visit`, { method: 'POST' }, c)).data;
  result.visitReturnsState = Array.isArray(beat.viewers) && beat.favorited === false;
  result.recentListed = (await q('/me/recent', {}, c)).data.notes[0]?.id === short.id;
  result.selfNotCountedAsViewer = beat.viewers.length === 0;

  // PDF：上传后后台抽文本，抽到的内容能被搜到
  const form = new FormData();
  form.append('file', new Blob([tinyPdf('Quarterly submarine budget')], { type: 'application/pdf' }), '季度报告.pdf');
  const up = await fetch(`${base}/notes/${short.id}/attachments`, { method: 'POST', body: form, headers: { cookie: c } }).then(r => r.json());
  result.pdfUploaded = up.ok === true;
  let status = 'pending';
  for (let i = 0; i < 30 && status === 'pending'; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const list = (await q(`/notes/${short.id}/attachments`, {}, c)).data.attachments;
    status = list.find(a => a.id === up.data.id)?.extractStatus ?? 'none';
  }
  if (status === 'pending') console.error('提示：PDF 抽取任务一直是 pending，多半是 worker 没在跑（pnpm dev 里的 @kb/worker）');
  result.pdfExtracted = status === 'ok';
  result.pdfTextSearchable = (await titles('submarine')).includes('账本');
} finally {
  await q(`/workspaces/${ws.id}`, { method: 'DELETE', body: JSON.stringify({ confirmName: ws.name }) }, c).catch(() => {});
}
console.log(JSON.stringify(result, null, 2));
const failed = Object.entries(result).filter(([, v]) => !v).map(([k]) => k);
if (failed.length) { console.error('失败：' + failed.join(', ')); process.exitCode = 1; }
