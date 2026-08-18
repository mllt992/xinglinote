// 重复规则验收（设计 16 §7.2）：展开数量、单次例外不影响其他、「此后全部」的截断语义。
// 用法：KB_EMAIL=... KB_PASSWORD=... node scripts/verify-calendar-recur.mjs
import { KB_EMAIL, KB_PASSWORD } from './creds.mjs';
const base = (process.env.KB_BASE_URL ?? 'http://127.0.0.1:12098') + '/api/v1';

async function q(path, opt = {}, cookie = '') {
  const r = await fetch(base + path, { ...opt, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opt.headers || {}) } });
  const j = await r.json();
  if (!r.ok || !j.ok) { const e = new Error(j.error?.message ?? r.status); e.code = j.error?.code; e.status = r.status; throw e; }
  return { data: j.data, cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie };
}
function wallToUtc(y, m, d, hh, mm, tz) {
  const off = x => {
    const p = {};
    for (const it of new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(x)) if (it.type !== 'literal') p[it.type] = Number(it.value);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second) - x.getTime();
  };
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const once = new Date(guess - off(new Date(guess)));
  return new Date(guess - off(once));
}

const c = (await q('/auth/login', { method: 'POST', body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) })).cookie;
const ws = (await q('/workspaces', { method: 'POST', body: JSON.stringify({ name: '日历重复验收' }) }, c)).data.workspace;
const result = {};
try {
  const tz = (await q(`/workspaces/${ws.id}/calendar`, {}, c)).data.timezone;
  const win = (a, b) => `/workspaces/${ws.id}/calendar?from=${a.toISOString()}&to=${b.toISOString()}`;

  // 2027-06-18 是周五，起点定在这天 17:00，规则「每周五」
  const first = wallToUtc(2027, 6, 18, 17, 0, tz);
  const weekly = (await q(`/workspaces/${ws.id}/calendar/items`, { method: 'POST', body: JSON.stringify({ kind: 'event', title: '周报', startsAt: first.toISOString(), endsAt: new Date(first.getTime() + 1800000).toISOString(), rrule: 'FREQ=WEEKLY;BYDAY=FR' }) }, c)).data;
  result.baseDayIsFriday = new Date(Date.UTC(2027, 5, 18)).getUTCDay() === 5;
  result.createdRecurring = weekly.recurring === true;

  // 四周窗口：6/18、6/25、7/2、7/9
  const fourWeeks = (await q(win(first, wallToUtc(2027, 7, 12, 0, 0, tz)), {}, c)).data.items.filter(i => i.id === weekly.id);
  result.expandsFourOccurrences = fourWeeks.length === 4;
  result.occurrencesCarryIdentity = fourWeeks.every(i => i.occurrenceStart && i.recurring);
  result.occurrencesAreWeekly = fourWeeks.every((i, idx) => new Date(i.startsAt).getTime() === first.getTime() + idx * 7 * 86400000);

  // 每天：十天窗口十条，且不预生成到库里
  const daily = (await q(`/workspaces/${ws.id}/calendar/items`, { method: 'POST', body: JSON.stringify({ kind: 'event', title: '晨会', startsAt: wallToUtc(2027, 6, 18, 9, 0, tz).toISOString(), rrule: 'FREQ=DAILY' }) }, c)).data;
  const tenDays = (await q(win(wallToUtc(2027, 6, 18, 0, 0, tz), wallToUtc(2027, 6, 27, 23, 0, tz)), {}, c)).data.items.filter(i => i.id === daily.id);
  result.dailyExpandsTenDays = tenDays.length === 10;

  // —— 单次改期：只动这一次 ——
  const second = fourWeeks[1];
  const movedTo = wallToUtc(2027, 6, 26, 11, 0, tz);
  const one = (await q(`/calendar/items/${weekly.id}/reschedule`, { method: 'POST', body: JSON.stringify({ startsAt: movedTo.toISOString(), occurrenceStart: second.occurrenceStart, scope: 'one' }) }, c)).data;
  result.oneOccurrenceScoped = one.scope === 'one';
  const afterMove = (await q(win(first, wallToUtc(2027, 7, 12, 0, 0, tz)), {}, c)).data.items.filter(i => i.id === weekly.id);
  result.onlyThatOccurrenceMoved = afterMove.length === 4
    && afterMove.some(i => new Date(i.startsAt).getTime() === movedTo.getTime())
    && afterMove.filter(i => new Date(i.startsAt).getTime() === first.getTime()).length === 1;

  // —— 单次完成：其他次数照旧是未完成 ——
  const third = afterMove.find(i => new Date(i.occurrenceStart).getTime() === first.getTime() + 14 * 86400000);
  await q(`/calendar/items/${weekly.id}/complete`, { method: 'POST', body: JSON.stringify({ done: true, occurrenceStart: third.occurrenceStart }) }, c);
  const afterDone = (await q(win(first, wallToUtc(2027, 7, 12, 0, 0, tz)), {}, c)).data.items.filter(i => i.id === weekly.id);
  result.onlyThatOccurrenceDone = afterDone.filter(i => i.status === 'done').length === 1;

  // —— 此后全部：原序列截断 + 新建后续，不原地改历史 ——
  const splitAt = afterDone.find(i => new Date(i.occurrenceStart).getTime() === first.getTime() + 21 * 86400000);
  const following = (await q(`/calendar/items/${weekly.id}/reschedule`, { method: 'POST', body: JSON.stringify({ startsAt: wallToUtc(2027, 7, 9, 20, 0, tz).toISOString(), occurrenceStart: splitAt.occurrenceStart, scope: 'following' }) }, c)).data;
  result.followingCreatesNewSeries = following.scope === 'following' && !!following.item?.id && following.item.id !== weekly.id;

  const afterSplit = (await q(win(first, wallToUtc(2027, 8, 1, 0, 0, tz)), {}, c)).data.items;
  const oldSeries = afterSplit.filter(i => i.id === weekly.id);
  const newSeries = afterSplit.filter(i => i.id === following.item.id);
  result.oldSeriesTruncated = oldSeries.every(i => new Date(i.occurrenceStart) < new Date(splitAt.occurrenceStart));
  result.historyUntouched = oldSeries.some(i => new Date(i.occurrenceStart).getTime() === first.getTime());
  result.newSeriesContinues = newSeries.length >= 1 && new Date(newSeries[0].startsAt).getTime() === wallToUtc(2027, 7, 9, 20, 0, tz).getTime();

  // 长窗口：一天一条不重不漏，且受 500 条上限约束，不至于把前端灌爆
  const longWindow = (await q(win(wallToUtc(2027, 6, 18, 0, 0, tz), wallToUtc(2028, 6, 1, 0, 0, tz)), {}, c)).data.items.filter(i => i.id === daily.id);
  const days = new Set(longWindow.map(i => i.startsAt.slice(0, 10)));
  result.expansionBounded = longWindow.length > 300 && longWindow.length <= 500 && days.size === longWindow.length;
} finally {
  await q(`/workspaces/${ws.id}`, { method: 'DELETE' }, c).catch(() => {});
}
console.log(JSON.stringify(result, null, 2));
if (!Object.values(result).every(Boolean)) process.exitCode = 1;
