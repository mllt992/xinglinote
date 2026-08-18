// 日历核心验收（设计 16 §7.2）：CRUD、时区边界、ACL、弱冲突 409、提醒、今天页、日记。
// 用法：KB_EMAIL=... KB_PASSWORD=... node scripts/verify-calendar-core.mjs
import { KB_EMAIL, KB_PASSWORD } from './creds.mjs';
const base = (process.env.KB_BASE_URL ?? 'http://127.0.0.1:12098') + '/api/v1';

async function q(path, opt = {}, cookie = '') {
  const r = await fetch(base + path, { ...opt, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opt.headers || {}) } });
  const j = await r.json();
  if (!r.ok || !j.ok) { const e = new Error(j.error?.message ?? r.status); e.code = j.error?.code; e.status = r.status; throw e; }
  return { data: j.data, cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie };
}
const rejects = async (fn, code) => { try { await fn(); return false; } catch (e) { return code ? e.code === code : true; } };

/** 与服务端同一套墙钟换算，免得脚本自己按 UTC 算，把时区 bug 一起抄过来。 */
function wallToUtc(y, m, d, hh, mm, tz) {
  const parts = x => {
    const p = {};
    for (const it of new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(x)) if (it.type !== 'literal') p[it.type] = Number(it.value);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second) - x.getTime();
  };
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const once = new Date(guess - parts(new Date(guess)));
  return new Date(guess - parts(once));
}

const c = (await q('/auth/login', { method: 'POST', body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) })).cookie;
const ws = (await q('/workspaces', { method: 'POST', body: JSON.stringify({ name: '日历核心验收' }) }, c)).data.workspace;
const result = {};
try {
  const tz = (await q(`/workspaces/${ws.id}/calendar`, {}, c)).data.timezone;
  const win = (from, to) => `/workspaces/${ws.id}/calendar?from=${from.toISOString()}&to=${to.toISOString()}`;

  // —— 时区：「2027-03-18 全天」是当地日历日，不是 UTC 午夜 ——
  const preview = (await q(`/workspaces/${ws.id}/calendar/quick-add`, { method: 'POST', body: JSON.stringify({ text: '2027-03-18 交房租' }) }, c)).data.preview;
  result.allDayUsesLocalDay = preview.allDay === true && new Date(preview.dueAt).getTime() === wallToUtc(2027, 3, 18, 0, 0, tz).getTime();
  result.quickAddPreviewOnly = (await q(`/workspaces/${ws.id}/calendar/inbox`, {}, c)).data.inbox.every(i => i.title !== '交房租');
  const committed = (await q(`/workspaces/${ws.id}/calendar/quick-add`, { method: 'POST', body: JSON.stringify({ text: '2027-03-18 交房租', commit: true }) }, c)).data.item;
  result.quickAddCommitWrites = !!committed.id;

  // 当地 3/18 的窗口里有，当地 3/17 的窗口里没有：证明没按 UTC 日切漂一天
  const day18 = (await q(win(wallToUtc(2027, 3, 18, 0, 0, tz), wallToUtc(2027, 3, 18, 23, 59, tz)), {}, c)).data.items;
  const day17 = (await q(win(wallToUtc(2027, 3, 17, 0, 0, tz), wallToUtc(2027, 3, 17, 23, 58, tz)), {}, c)).data.items;
  result.allDayLandsOnItsOwnDay = day18.some(i => i.id === committed.id) && !day17.some(i => i.id === committed.id);

  // —— CRUD ——
  const start = wallToUtc(2027, 3, 19, 15, 0, tz), end = wallToUtc(2027, 3, 19, 16, 0, tz);
  const event = (await q(`/workspaces/${ws.id}/calendar/items`, { method: 'POST', body: JSON.stringify({ kind: 'event', title: '季度对齐', startsAt: start.toISOString(), endsAt: end.toISOString() }) }, c)).data;
  result.createEvent = event.kind === 'event' && new Date(event.startsAt).getTime() === start.getTime();
  result.eventNeedsStart = await rejects(() => q(`/workspaces/${ws.id}/calendar/items`, { method: 'POST', body: JSON.stringify({ kind: 'event', title: '没有时间的日程' }) }, c), 'VALIDATION');
  result.windowCapped = await rejects(() => q(`/workspaces/${ws.id}/calendar?from=2020-01-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z`, {}, c), 'VALIDATION');

  const renamed = (await q(`/calendar/items/${event.id}`, { method: 'PATCH', body: JSON.stringify({ title: '季度对齐（改）' }) }, c)).data;
  result.patchTitle = renamed.title === '季度对齐（改）';

  // 弱冲突：带一个过期的 ifUnmodifiedSince 必须 409，而不是静默盖掉别人的改动
  result.staleWriteConflicts = await rejects(
    () => q(`/calendar/items/${event.id}`, { method: 'PATCH', body: JSON.stringify({ title: '并发改', ifUnmodifiedSince: new Date(Date.now() - 600000).toISOString() }) }, c),
    'CONFLICT_VERSION');

  const moved = wallToUtc(2027, 3, 20, 10, 0, tz);
  const after = (await q(`/calendar/items/${event.id}/reschedule`, { method: 'POST', body: JSON.stringify({ startsAt: moved.toISOString() }) }, c)).data.item;
  result.reschedulePreservesSpan = new Date(after.startsAt).getTime() === moved.getTime() && new Date(after.endsAt) - new Date(after.startsAt) === 3600000;

  const doneRes = (await q(`/calendar/items/${committed.id}/complete`, { method: 'POST', body: JSON.stringify({ done: true }) }, c)).data;
  const openRes = (await q(`/calendar/items/${committed.id}/complete`, { method: 'POST', body: JSON.stringify({ done: false }) }, c)).data;
  result.toggleDone = doneRes.status === 'done' && openRes.status === 'open';

  const reminders = (await q(`/calendar/items/${event.id}/reminders`, { method: 'PUT', body: JSON.stringify({ reminders: [{ kind: 'relative', offsetMin: -30, channel: 'inapp' }] }) }, c)).data.reminders;
  result.reminderScheduled = reminders.length === 1 && reminders[0].status === 'scheduled';

  await q(`/calendar/items/${event.id}`, { method: 'DELETE' }, c);
  const gone = (await q(win(wallToUtc(2027, 3, 1, 0, 0, tz), wallToUtc(2027, 3, 31, 0, 0, tz)), {}, c)).data.items;
  await q(`/calendar/items/${event.id}/restore`, { method: 'POST' }, c);
  const back = (await q(win(wallToUtc(2027, 3, 1, 0, 0, tz), wallToUtc(2027, 3, 31, 0, 0, tz)), {}, c)).data.items;
  result.trashAndRestore = !gone.some(i => i.id === event.id) && back.some(i => i.id === event.id);
  result.detachRejectsManual = await rejects(() => q(`/calendar/items/${event.id}/detach`, { method: 'POST' }, c), 'VALIDATION');

  // —— 今天页与日记 ——
  const today = (await q(`/workspaces/${ws.id}/today`, {}, c)).data;
  result.todayShape = /^\d{4}-\d{2}-\d{2}$/.test(today.date) && Array.isArray(today.items) && Array.isArray(today.overdue) && Array.isArray(today.notes);
  const diary = (await q(`/workspaces/${ws.id}/calendar/diary`, { method: 'POST', body: JSON.stringify({}) }, c)).data;
  const again = (await q(`/workspaces/${ws.id}/calendar/diary`, { method: 'POST', body: JSON.stringify({}) }, c)).data;
  result.diaryCreatesOnce = diary.created === true && again.created === false && again.noteId === diary.noteId;
  const diaryNote = (await q(`/notes/${diary.noteId}`, {}, c)).data;
  result.diaryUsesTemplate = diaryNote.title === today.date && diaryNote.bodyMd.includes('## 待办');

  // —— ACL：私密笔记本里的待办不能从日历漏给别人 ——
  const code = (await q('/admin/registration-codes', { method: 'POST', body: JSON.stringify({ quantity: 1, maxUses: 1, skipEmailVerification: true, bindWorkspaceId: ws.id, bindRole: 'editor' }) }, c)).data.codes[0];
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const member = (await q('/auth/register', { method: 'POST', body: JSON.stringify({ email: `cal-${suffix}@example.test`, password: 'Password1234', handle: `cal${suffix}`, displayName: '日历验收成员', registrationCode: code }) })).cookie;

  const secretNb = (await q(`/workspaces/${ws.id}/notebooks`, { method: 'POST', body: JSON.stringify({ title: '私密本', visibility: 'private' }) }, c)).data;
  let secretNote = (await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: secretNb.id, title: '私密计划' }) }, c)).data;
  secretNote = (await q(`/notes/${secretNote.id}`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: secretNote.version, bodyMd: '- [ ] 只有我能看见的任务 @2027-03-21' }) }, c)).data;

  // 任务同步走 background_jobs，等 worker 落库；等不到就是 worker 没起，直接判失败而不是当通过
  const wide = win(wallToUtc(2027, 3, 1, 0, 0, tz), wallToUtc(2027, 3, 31, 0, 0, tz));
  let ownerSees = false;
  for (let i = 0; i < 20 && !ownerSees; i++) {
    ownerSees = (await q(wide, {}, c)).data.items.some(x => x.title === '只有我能看见的任务');
    if (!ownerSees) await new Promise(r => setTimeout(r, 1000));
  }
  result.noteTaskReachesCalendar = ownerSees;
  result.privateNotebookTaskHidden = !(await q(wide, {}, member)).data.items.some(x => x.title === '只有我能看见的任务');

  const mine = (await q(`/workspaces/${ws.id}/calendar/items`, { method: 'POST', body: JSON.stringify({ title: '仅自己可见', dueAt: wallToUtc(2027, 3, 22, 9, 0, tz).toISOString(), visibility: 'private' }) }, c)).data;
  result.privateItemHidden = !(await q(wide, {}, member)).data.items.some(x => x.id === mine.id);
  result.workspaceItemShared = (await q(wide, {}, member)).data.items.some(x => x.id === committed.id);
} finally {
  await q(`/workspaces/${ws.id}`, { method: 'DELETE' }, c).catch(() => {});
}
console.log(JSON.stringify(result, null, 2));
if (!Object.values(result).every(Boolean)) process.exitCode = 1;
