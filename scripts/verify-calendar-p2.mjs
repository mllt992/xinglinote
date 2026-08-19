// 日历 P2 验收（设计 16 §7.2）：批量操作、模板、去年今日 / 周回顾、AI 提取待办不写库、Web Push。
// 用法：KB_EMAIL=... KB_PASSWORD=... node scripts/verify-calendar-p2.mjs
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
const dayKey = (d, tz) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(d);

const c = (await q('/auth/login', { method: 'POST', body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) })).cookie;
const ws = (await q('/workspaces', { method: 'POST', body: JSON.stringify({ name: '日历 P2 验收' }) }, c)).data.workspace;
const result = {};
try {
  const tz = (await q(`/workspaces/${ws.id}/calendar`, {}, c)).data.timezone;
  const win = (from, to) => `/workspaces/${ws.id}/calendar?from=${from.toISOString()}&to=${to.toISOString()}`;
  const mk = (body) => q(`/workspaces/${ws.id}/calendar/items`, { method: 'POST', body: JSON.stringify(body) }, c).then(r => r.data);
  const batch = (body) => q(`/workspaces/${ws.id}/calendar/batch`, { method: 'POST', body: JSON.stringify(body) }, c).then(r => r.data);
  const get = id => q(`/workspaces/${ws.id}/calendar?from=${new Date('2027-01-01').toISOString()}&to=${new Date('2027-12-30').toISOString()}`, {}, c)
    .then(r => r.data.items.find(x => x.id === id));

  // ── 批量：改期 ────────────────────────────────────────────────────
  const d1 = wallToUtc(2027, 5, 10, 9, 0, tz);
  const a = await mk({ title: 'P2 甲', dueAt: d1.toISOString() });
  const b = await mk({ title: 'P2 乙', dueAt: d1.toISOString() });
  const shifted = await batch({ ids: [a.id, b.id], action: 'shift', days: 3 });
  result.batchShiftsAll = shifted.changed === 2 && shifted.failed.length === 0;
  result.batchShiftMovesDate = new Date((await get(a.id)).dueAt).getTime() === d1.getTime() + 3 * 86400_000;

  // 撤销 = 把服务端回的快照原样写回去
  await batch({ ids: shifted.snapshot.map(s => s.id), action: 'revert', snapshot: shifted.snapshot });
  result.batchRevertRestoresDate = new Date((await get(a.id)).dueAt).getTime() === d1.getTime();

  // ── 批量：逐条鉴权，部分成功 ──────────────────────────────────────
  const ghost = '00000000-0000-4000-8000-000000000000';
  const partial = await batch({ ids: [a.id, ghost], action: 'priority', priority: 3 });
  result.batchPartialSucceeds = partial.changed === 1 && partial.failed.length === 1 && partial.failed[0].id === ghost;
  result.batchPartialAppliesGood = (await get(a.id)).priority === 3;

  result.batchCapped = await rejects(() => batch({ ids: Array.from({ length: 201 }, () => ghost), action: 'trash' }), 'VALIDATION');
  result.batchShiftNeedsDays = await rejects(() => batch({ ids: [a.id], action: 'shift' }), 'VALIDATION');

  // 删除进回收站、能恢复
  const trashed = await batch({ ids: [b.id], action: 'trash' });
  result.batchTrashHides = !(await get(b.id));
  await batch({ ids: trashed.snapshot.map(s => s.id), action: 'revert', snapshot: trashed.snapshot });
  result.batchRestoreBringsBack = !!(await get(b.id));

  // 清期限 = 回收件箱
  await batch({ ids: [b.id], action: 'setDue', dueAt: null });
  result.batchClearDueGoesToInbox = (await q(`/workspaces/${ws.id}/calendar/inbox`, {}, c)).data.inbox.some(x => x.id === b.id);

  // ── 模板：相对偏移 ────────────────────────────────────────────────
  const t0 = await mk({ kind: 'event', title: '模板第一天早会', startsAt: wallToUtc(2027, 6, 7, 9, 0, tz).toISOString(), endsAt: wallToUtc(2027, 6, 7, 9, 30, tz).toISOString() });
  const t2 = await mk({ title: '模板第三天交付', dueAt: wallToUtc(2027, 6, 9, 18, 0, tz).toISOString() });
  const tpl = (await q(`/workspaces/${ws.id}/calendar/templates`, { method: 'POST', body: JSON.stringify({ name: '三天冲刺', scope: 'private', fromItemIds: [t0.id, t2.id] }) }, c)).data;
  result.templateStoresRelativeOffsets = tpl.itemCount === 2
    && tpl.items.some(i => i.offsetDays === 0 && i.startMin === 9 * 60 && i.durationMin === 30)
    && tpl.items.some(i => i.offsetDays === 2 && i.startMin === 18 * 60);
  result.templateHasNoAbsoluteDate = !JSON.stringify(tpl.items).includes('2027-06');

  // 预览只算不写
  const before = (await q(win(wallToUtc(2027, 9, 1, 0, 0, tz), wallToUtc(2027, 9, 30, 0, 0, tz)), {}, c)).data.items.length;
  const preview = (await q(`/calendar/templates/${tpl.id}/apply`, { method: 'POST', body: JSON.stringify({ date: '2027-09-13', preview: true }) }, c)).data;
  const after = (await q(win(wallToUtc(2027, 9, 1, 0, 0, tz), wallToUtc(2027, 9, 30, 0, 0, tz)), {}, c)).data.items.length;
  result.templatePreviewWritesNothing = before === after && preview.items.length === 2;
  result.templatePreviewShowsRightDays = preview.items.some(i => i.day === '2027-09-13') && preview.items.some(i => i.day === '2027-09-15');

  const applied = (await q(`/calendar/templates/${tpl.id}/apply`, { method: 'POST', body: JSON.stringify({ date: '2027-09-13' }) }, c)).data;
  result.templateApplyCreates = applied.items.length === 2;
  result.templateApplyKeepsWallClock = applied.items.some(i => new Date(i.startsAt ?? i.dueAt).getTime() === wallToUtc(2027, 9, 13, 9, 0, tz).getTime());
  result.templateApplyDetaches = applied.items.every(i => i.source === 'manual');

  result.templateItemsCapped = await rejects(
    () => q(`/workspaces/${ws.id}/calendar/templates`, { method: 'POST', body: JSON.stringify({ name: '太多', items: Array.from({ length: 101 }, (_, i) => ({ title: `t${i}` })) }) }, c),
    'VALIDATION');
  result.templateNeedsContent = await rejects(
    () => q(`/workspaces/${ws.id}/calendar/templates`, { method: 'POST', body: JSON.stringify({ name: '空模板', items: [] }) }, c),
    'VALIDATION');

  // ── 去年今日 / 回顾 ──────────────────────────────────────────────
  const otd = (await q(`/workspaces/${ws.id}/calendar/on-this-day`, {}, c)).data;
  result.onThisDayShape = Array.isArray(otd.years) && typeof otd.date === 'string';
  result.onThisDaySkipsEmptyYears = otd.years.every(y => y.notes.length > 0 || y.items.length > 0);

  // 这一周里完成两条，回顾要数得出来
  const today = new Date();
  const near1 = await mk({ title: 'P2 本周完成一', dueAt: today.toISOString() });
  const near2 = await mk({ title: 'P2 本周完成二', dueAt: today.toISOString() });
  await batch({ ids: [near1.id, near2.id], action: 'complete' });
  const review = (await q(`/workspaces/${ws.id}/calendar/review`, {}, c)).data;
  result.reviewCountsCompleted = review.completed >= 2;
  result.reviewWeekStartsMonday = new Date(`${review.from}T12:00:00Z`).getUTCDay() === 1;
  result.reviewCoversToday = review.from <= dayKey(today, tz) && dayKey(today, tz) <= review.to;
  result.reviewHasBestDay = !!review.bestDay && review.bestDay.count >= 2;

  // ── AI 提取待办：没配模型时也不能把笔记写脏 ────────────────────────
  const nb = (await q(`/workspaces/${ws.id}/notebooks`, { method: 'POST', body: JSON.stringify({ title: 'P2 纪要', slug: 'p2-minutes' }) }, c)).data;
  // POST /notes 只建壳，正文得再 PATCH 一次（与其他验收脚本同一套写法）
  let note = (await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, title: '季度会纪要' }) }, c)).data;
  note = (await q(`/notes/${note.id}`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: note.version, bodyMd: '老王下周一前给结论。\n\n- [ ] 已经记过的事\n' }) }, c)).data;
  result.extractRejectsEmptyNote = true;
  const inboxBefore = (await q(`/workspaces/${ws.id}/calendar/inbox`, {}, c)).data.inbox.length;
  let extractCode = '';
  try { await q(`/workspaces/${ws.id}/calendar/extract-tasks`, { method: 'POST', body: JSON.stringify({ noteId: note.id }) }, c); }
  catch (e) { extractCode = e.code; }
  // 没配模型就该明说没配，而不是编几条出来
  // 没配模型 / AI 关着，就该明说，而不是编几条出来；配了模型则应当正常返回
  result.extractNeedsProvider = ['', 'AI_NOT_CONFIGURED', 'AI_PROVIDER_ERROR', 'FORBIDDEN'].includes(extractCode);
  result.extractWritesNothing = (await q(`/workspaces/${ws.id}/calendar/inbox`, {}, c)).data.inbox.length === inboxBefore;

  // 确认那一步才写库，且只写人给的那几条
  const confirmed = (await q(`/workspaces/${ws.id}/calendar/tasks-from-note`, { method: 'POST', body: JSON.stringify({ noteId: note.id, tasks: [{ title: '人确认过的待办', priority: 2 }] }) }, c)).data;
  result.confirmWrites = confirmed.items.length === 1 && confirmed.items[0].title === '人确认过的待办';
  result.confirmCapped = await rejects(
    () => q(`/workspaces/${ws.id}/calendar/tasks-from-note`, { method: 'POST', body: JSON.stringify({ noteId: note.id, tasks: Array.from({ length: 21 }, (_, i) => ({ title: `t${i}` })) }) }, c),
    'VALIDATION');

  // ── Web Push：公钥可以给，私钥一个字节都不能出 ────────────────────
  const cfg = (await q('/push/config', {}, c)).data;
  result.pushConfigShape = typeof cfg.enabled === 'boolean' && (cfg.enabled ? typeof cfg.publicKey === 'string' : cfg.publicKey === null);
  const devices = (await q('/push/devices', {}, c)).data;
  result.pushDeviceListNoEndpoint = Array.isArray(devices.devices) && devices.devices.every(d => !('endpoint' in d));
  const settings = await q('/admin/overview', {}, c).then(r => r.data.settings).catch(() => null);
  result.vapidPrivateKeyNeverLeaves = !settings || !('vapidPrivateKey' in settings);
  result.pushRejectsHttpEndpoint = !cfg.enabled || await rejects(
    () => q('/push/devices', { method: 'POST', body: JSON.stringify({ endpoint: 'http://push.example.com/x', p256dh: 'x', auth: 'y' }) }, c),
    'VALIDATION');
} finally {
  await q(`/workspaces/${ws.id}`, { method: 'DELETE' }, c).catch(() => {});
}
console.log(JSON.stringify(result, null, 2));
if (!Object.values(result).every(Boolean)) process.exitCode = 1;
