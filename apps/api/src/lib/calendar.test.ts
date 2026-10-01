import assert from "node:assert/strict";
import { test } from "node:test";
import { expandRule, localDayKey, nextOccurrence, occurrencesOf, parseRrule, parseTaskLines, startOfLocalDay, toggleTaskLine, wallToUtc, writeAnchors } from "./calendar.ts";
import { parseQuickAdd } from "./quick-add.ts";

const SH = "Asia/Shanghai";
const NY = "America/New_York";

test("墙钟转 UTC：GMT+8 的 00:00 是前一天 16:00Z", () => {
  assert.equal(wallToUtc(2026, 8, 18, 0, 0, SH).toISOString(), "2026-08-17T16:00:00.000Z");
});

test("全天条目按当地日历日归属，不按 UTC 日切", () => {
  // 参考产品的「8月18日全天」在 UTC 下是 17 日 16:00，按 UTC 判会漂到 17 号
  const allDay = wallToUtc(2026, 8, 18, 0, 0, SH);
  assert.equal(localDayKey(allDay, SH), "2026-08-18");
  assert.equal(startOfLocalDay(new Date("2026-08-18T15:30:00+08:00"), SH).getTime(), allDay.getTime());
});

test("跨夏令时保持每天 9:00，而不是每 24 小时", () => {
  const base = wallToUtc(2026, 3, 6, 9, 0, NY); // 美东 3/8 进入夏令时
  const days = expandRule(base, parseRrule("FREQ=DAILY"), NY, base, new Date(base.getTime() + 5 * 86400_000));
  const hours = days.map(d => new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "2-digit", hour12: false }).format(d));
  assert.deepEqual([...new Set(hours)], ["09"]);
});

test("每周五：只落在周五，且数量正确", () => {
  const base = wallToUtc(2026, 8, 21, 17, 0, SH); // 2026-08-21 是周五
  const out = expandRule(base, parseRrule("FREQ=WEEKLY;BYDAY=FR"), SH, base, wallToUtc(2026, 9, 18, 23, 59, SH));
  assert.equal(out.length, 5);
  for (const d of out) assert.equal(new Date(d.getTime() + 8 * 3600_000).getUTCDay(), 5);
});

test("每月31日跳过没有31号的月份，不顺延到1号", () => {
  const base = wallToUtc(2026, 1, 31, 9, 0, SH);
  const out = expandRule(base, parseRrule("FREQ=MONTHLY;BYMONTHDAY=31"), SH, base, wallToUtc(2026, 5, 1, 0, 0, SH));
  assert.deepEqual(out.map(d => localDayKey(d, SH)), ["2026-01-31", "2026-03-31"]);
});

test("UNTIL 与 COUNT 都能截断", () => {
  const base = wallToUtc(2026, 8, 18, 9, 0, SH);
  const to = wallToUtc(2026, 9, 18, 0, 0, SH);
  assert.equal(expandRule(base, parseRrule("FREQ=DAILY;COUNT=3"), SH, base, to).length, 3);
  assert.equal(expandRule(base, parseRrule("FREQ=DAILY;UNTIL=20260820T000000Z"), SH, base, to).length, 2);
});

test("任务行解析：时间、优先级、重复、指派、锚", () => {
  const body = [
    "# 本周计划",
    "- [ ] 交周报 @2026-08-20 15:00 !高 ~每周五 +@alice ^tk-a1b2c3d4",
    "- [x] 已经做完的事 @2026-08-19",
    "普通段落",
    "```",
    "- [ ] 代码块里的不算 @2026-08-21",
    "```",
    "> - [ ] 引用块里的也不算",
  ].join("\n");
  const tasks = parseTaskLines(body, SH);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].title, "交周报");
  assert.equal(tasks[0].anchor, "^tk-a1b2c3d4");
  assert.equal(tasks[0].priority, 3);
  assert.equal(tasks[0].rrule, "FREQ=WEEKLY;BYDAY=FR");
  assert.equal(tasks[0].assignee, "alice");
  assert.equal(tasks[0].dueAt?.toISOString(), "2026-08-20T07:00:00.000Z");
  assert.equal(tasks[1].checked, true);
  assert.equal(tasks[1].allDay, true);
});

test("补锚只动缺锚的行，且是合法 Markdown", () => {
  const body = "- [ ] 甲\n- [ ] 乙 ^tk-00000001";
  const tasks = parseTaskLines(body, SH);
  const next = writeAnchors(body, tasks);
  assert.ok(next);
  assert.match(next!.split("\n")[0], /^- \[ \] 甲 \^tk-[0-9a-f]{8}$/);
  assert.equal(next!.split("\n")[1], "- [ ] 乙 ^tk-00000001");
  assert.equal(writeAnchors(next!, parseTaskLines(next!, SH)), null, "第二遍不该再改写，否则触发器会打转");
});

test("勾选回写：改文案后靠锚仍能定位，锚没了返回 null", () => {
  const body = "- [ ] 交周报 @2026-08-20 15:00 ^tk-a1b2c3d4";
  const done = toggleTaskLine(body, "^tk-a1b2c3d4", true);
  assert.equal(done, "- [x] 交周报 @2026-08-20 15:00 ^tk-a1b2c3d4");
  const renamed = "- [ ] 交周报（改了标题） @2026-08-20 15:00 ^tk-a1b2c3d4";
  assert.equal(toggleTaskLine(renamed, "^tk-a1b2c3d4", true)?.startsWith("- [x]"), true);
  assert.equal(toggleTaskLine("- [ ] 别的事", "^tk-a1b2c3d4", true), null);
});

test("无锚时退化为文本 hash 匹配", () => {
  const tasks = parseTaskLines("- [ ] 交房租", SH);
  assert.match(tasks[0].key, /^h:[0-9a-f]{16}$/);
  assert.equal(toggleTaskLine("- [ ] 交房租", tasks[0].key, true), "- [x] 交房租");
});

test("快速添加：相对日期 + 中文时刻 + 时长 + 优先级", () => {
  const now = new Date("2026-08-18T05:00:00Z"); // 周二 13:00 GMT+8
  const r = parseQuickAdd("明天下午3点 和销售团队对齐季度数据 !高 30分钟", SH, now);
  assert.equal(r.title, "和销售团队对齐季度数据");
  assert.equal(r.priority, 3);
  assert.equal(r.startsAt?.toISOString(), "2026-08-19T07:00:00.000Z");
  assert.equal(r.endsAt?.toISOString(), "2026-08-19T07:30:00.000Z");
});

test("快速添加：每周五 17:00 识别成重复而不是单次", () => {
  const r = parseQuickAdd("每周五 17:00 周报", SH, new Date("2026-08-18T05:00:00Z"));
  assert.equal(r.rrule, "FREQ=WEEKLY;BYDAY=FR");
  assert.equal(r.title, "周报");
});

test("快速添加：认不出时间就只留标题，不猜", () => {
  const r = parseQuickAdd("看看上周三讨论的方案", SH, new Date("2026-08-18T05:00:00Z"));
  assert.equal(r.dueAt, null);
  assert.equal(r.title, "看看上周三讨论的方案");
});

test("「此后全部」的截断：rrule_until 之后不再展开实例", () => {
  const base = wallToUtc(2027, 6, 18, 17, 0, SH);  // 周五
  const item = {
    id: "x", startsAt: base, endsAt: null, dueAt: base, timezone: SH,
    rrule: "FREQ=WEEKLY;BYDAY=FR", rruleUntil: new Date(base.getTime() + 21 * 86400_000 - 1000),
    status: "open",
  } as unknown as Parameters<typeof occurrencesOf>[0];
  const all = occurrencesOf(item, [], base, new Date(base.getTime() + 60 * 86400_000));
  // 截断点是第 4 次（+21 天）之前 1 秒，所以只剩前三次
  assert.equal(all.length, 3);
  assert.ok(all.every(o => o.occurrenceStart < item.rruleUntil!));
  // 提醒也不该再排到截断点之后
  assert.equal(nextOccurrence(item, new Date(base.getTime() + 30 * 86400_000)), null);
});

test("今天窗口严格按当地日切，兼容夏令时", async () => {
  const { localDayWindow } = await import('./calendar.ts');
  const sh = localDayWindow(new Date('2026-10-01T10:00:00Z'), SH);
  assert.equal(sh.from.toISOString(), '2026-09-30T16:00:00.000Z');
  assert.equal(sh.to.toISOString(), '2026-10-01T16:00:00.000Z');
  const dst = localDayWindow(new Date('2026-03-08T12:00:00Z'), NY);
  assert.equal(dst.to.getTime() - dst.from.getTime(), 23 * 3600_000);
});
test("改期精确回写目标行，保留状态、锚点与其它元数据", async () => {
  const { rescheduleTaskLine } = await import('./calendar.ts');
  const source = '# 待办\r\n- [ ] 买菜 @2026-10-01 !高 +@alice ^tk-1234abcd\r\n- [x] 无关 @2026-10-01 ^tk-5678abcd';
  const body = rescheduleTaskLine(source, '^tk-1234abcd', new Date('2026-10-03T16:00:00Z'), null, SH)!;
  assert.equal(body, source.replace('买菜 @2026-10-01', '买菜 @2026-10-04'));
  assert.equal(parseTaskLines(body, SH)[0].dueAt?.toISOString(), '2026-10-03T16:00:00.000Z');
});
test("无日期任务新增日期，歧义锚和代码块拒绝回写", async () => {
  const { rescheduleTaskLine } = await import('./calendar.ts');
  const when = new Date('2026-10-03T16:00:00Z');
  assert.equal(rescheduleTaskLine('- [ ] 买菜 ^tk-1234abcd', '^tk-1234abcd', when, null, SH), '- [ ] 买菜 ^tk-1234abcd @2026-10-04');
  assert.equal(rescheduleTaskLine('```\n- [ ] 买菜 ^tk-1234abcd\n```', '^tk-1234abcd', when, null, SH), null);
  assert.equal(rescheduleTaskLine('- [ ] A ^tk-1234abcd\n- [ ] B ^tk-1234abcd', '^tk-1234abcd', when, null, SH), null);
});
test("定时任务改期保留时长，跨日区间不静默丢失结束日", async () => {
  const { rescheduleTaskLine } = await import('./calendar.ts');
  const source = '- [ ] 开会 @2026-10-01 09:00-10:00 ^tk-1234abcd';
  const start = new Date('2026-10-02T01:00:00Z');
  assert.equal(rescheduleTaskLine(source, '^tk-1234abcd', start, new Date('2026-10-02T02:00:00Z'), SH), source.replace('2026-10-01', '2026-10-02'));
  assert.equal(rescheduleTaskLine(source, '^tk-1234abcd', start, new Date('2026-10-03T02:00:00Z'), SH), null);
});

test('无日期来源任务可改期并撤销回收件箱',async()=>{
 const {rescheduleTaskLine}=await import('./calendar.ts');const original='- [ ] 无日期 ^tk-1234abcd';
 const dated=rescheduleTaskLine(original,'^tk-1234abcd',new Date('2026-10-01T16:00:00Z'),null,SH)!;
 assert.ok(dated.includes('@2026-10-02'));assert.equal(rescheduleTaskLine(dated,'^tk-1234abcd',null,null,SH),original);
});
test('重复例外按实际时间进出窗口，不按旧日期',()=>{
 const base=wallToUtc(2026,10,1,9,0,SH),next=wallToUtc(2026,10,2,9,0,SH);
 const item={id:'x',startsAt:base,dueAt:base,endsAt:null,timezone:SH,rrule:'FREQ=DAILY',rruleUntil:null,status:'open'} as unknown as Parameters<typeof occurrencesOf>[0];
 const override={occurrenceStart:base,action:'moved',newStart:next,newEnd:null} as unknown as Parameters<typeof occurrencesOf>[1][0];
 const from=wallToUtc(2026,10,1,0,0,SH),to=new Date(wallToUtc(2026,10,2,0,0,SH).getTime()-1);
 assert.equal(occurrencesOf(item,[override],from,to).length,0);
 const moved=occurrencesOf(item,[override],new Date(to.getTime()+1),new Date(to.getTime()+86400000));
 assert.ok(moved.some(o=>o.occurrenceStart.getTime()===base.getTime() && o.start.getTime()===next.getTime()));
});
