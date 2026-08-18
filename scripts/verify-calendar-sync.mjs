// 笔记 ↔ 日历双向同步验收（设计 16 §7.2）：块锚、勾选回写、版本合并、改文案不丢关联、删源行标脱离。
// 需要 worker 在跑（pnpm dev 会一起起）。
// 用法：KB_EMAIL=... KB_PASSWORD=... node scripts/verify-calendar-sync.mjs
import { KB_EMAIL, KB_PASSWORD } from './creds.mjs';
const base = (process.env.KB_BASE_URL ?? 'http://127.0.0.1:12098') + '/api/v1';

async function q(path, opt = {}, cookie = '') {
  const r = await fetch(base + path, { ...opt, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opt.headers || {}) } });
  const j = await r.json();
  if (!r.ok || !j.ok) { const e = new Error(j.error?.message ?? r.status); e.code = j.error?.code; e.status = r.status; throw e; }
  return { data: j.data, cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie };
}
/** 同步走 background_jobs，worker 五秒一轮，所以一律轮询而不是 sleep 一个固定值。 */
async function until(fn, tries = 25) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

const c = (await q('/auth/login', { method: 'POST', body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) })).cookie;
const ws = (await q('/workspaces', { method: 'POST', body: JSON.stringify({ name: '日历同步验收' }) }, c)).data.workspace;
const result = {};
try {
  const nb = (await q(`/workspaces/${ws.id}/notebooks`, {}, c)).data.notebooks[0];
  const wide = `/workspaces/${ws.id}/calendar?from=2027-01-01T00:00:00.000Z&to=2027-12-31T00:00:00.000Z`;
  const items = async () => (await q(wide, {}, c)).data.items;
  const note = async id => (await q(`/notes/${id}`, {}, c)).data;
  const write = async (n, body) => (await q(`/notes/${n.id}`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: n.version, bodyMd: body }) }, c)).data;

  let n = (await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, title: '同步验收' }) }, c)).data;
  n = await write(n, [
    '- [ ] 交周报 @2027-06-18 15:00 !高',
    '- [ ] 随手记的事',
    '```',
    '- [ ] 代码块里的不算任务',
    '```',
    '> - [ ] 引用块里的也不算',
  ].join('\n'));

  // 1. 笔记里写任务 → 日历出现，且行内严格语法被解析
  const task = await until(async () => (await items()).find(i => i.title === '交周报'));
  result.taskAppearsOnCalendar = !!task && task.source === 'note' && task.priority === 3;
  result.undatedTaskGoesToInbox = (await q(`/workspaces/${ws.id}/calendar/inbox`, {}, c)).data.inbox.some(i => i.title === '随手记的事');
  result.codeAndQuoteNotParsed = !(await items()).some(i => i.title.includes('代码块')) &&
    !(await q(`/workspaces/${ws.id}/calendar/inbox`, {}, c)).data.inbox.some(i => i.title.includes('引用块'));

  // 2. 块锚被写回正文，且不算一次用户编辑（不升 version、不进版本历史）
  const anchored = await until(async () => { const cur = await note(n.id); return /\^tk-[0-9a-f]{8}/.test(cur.bodyMd) ? cur : null; });
  result.anchorWrittenBack = !!anchored;
  result.anchorIsNotAnEdit = anchored?.version === n.version;
  const anchor = anchored?.bodyMd.match(/交周报[^\n]*?(\^tk-[0-9a-f]{8})/)?.[1] ?? '';

  // 3. 日历勾选 → 正文变 [x]，且回写这件事是可见的
  const completed = (await q(`/calendar/items/${task.id}/complete`, { method: 'POST', body: JSON.stringify({ done: true }) }, c)).data;
  const afterToggle = await note(n.id);
  result.completeWritesBackToNote = completed.noteWritten === true && completed.detached === false && /- \[x\] 交周报/.test(afterToggle.bodyMd);

  // 4. 连续勾选合并版本，不让待办淹掉版本历史
  const versionsBefore = (await q(`/notes/${n.id}/versions`, {}, c)).data.total;
  await q(`/calendar/items/${task.id}/complete`, { method: 'POST', body: JSON.stringify({ done: false }) }, c);
  await q(`/calendar/items/${task.id}/complete`, { method: 'POST', body: JSON.stringify({ done: true }) }, c);
  const versionsAfter = (await q(`/notes/${n.id}/versions`, {}, c)).data;
  result.toggleVersionsMerged = versionsAfter.total === versionsBefore && versionsAfter.versions[0].source === 'task_toggle';

  // 5. 改文案、移动行：靠锚仍然认得出是同一条
  const current = await note(n.id);
  await write(current, current.bodyMd.replace('交周报', '交这周的周报（改了文案）').split('\n').reverse().join('\n'));
  const renamed = await until(async () => (await items()).find(i => i.id === task.id && i.title.includes('改了文案')));
  result.anchorSurvivesRewrite = !!renamed && renamed.linkState === 'linked';

  // 6. 删掉源行 → 标 detached，而不是静默消失
  const beforeDelete = await note(n.id);
  await write(beforeDelete, beforeDelete.bodyMd.split('\n').filter(l => !l.includes(anchor)).join('\n'));
  const detached = await until(async () => { const it = (await items()).find(i => i.id === task.id); return it?.linkState === 'detached' ? it : null; });
  result.missingLineBecomesDetached = !!detached;

  // 7. 断链条目可以转成独立任务，而不是让人对着一条断链干瞪眼
  const standalone = (await q(`/calendar/items/${task.id}/detach`, { method: 'POST' }, c)).data;
  result.detachToStandalone = standalone.source === 'manual' && standalone.sourceNoteId === null;

  // 8. 在编辑器里勾选 → 日历状态跟着变（反向同步）
  let other = (await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, title: '反向同步' }) }, c)).data;
  other = await write(other, '- [ ] 反向勾选 @2027-06-20');
  const backward = await until(async () => (await items()).find(i => i.title === '反向勾选'));
  const withAnchor = await until(async () => { const cur = await note(other.id); return /\^tk-/.test(cur.bodyMd) ? cur : null; });
  await write(withAnchor, withAnchor.bodyMd.replace('- [ ]', '- [x]'));
  const synced = await until(async () => { const it = (await items()).find(i => i.id === backward.id); return it?.status === 'done' ? it : null; });
  result.editorCheckSyncsToCalendar = !!synced;
} finally {
  await q(`/workspaces/${ws.id}`, { method: 'DELETE' }, c).catch(() => {});
}
console.log(JSON.stringify(result, null, 2));
if (!Object.values(result).every(Boolean)) process.exitCode = 1;
