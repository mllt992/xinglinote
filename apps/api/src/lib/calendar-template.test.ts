import assert from "node:assert/strict";
import { test } from "node:test";
import { wallToUtc } from "./calendar.ts";
import { itemsToTemplate, planTemplate, type SourceItem, type TemplateItem } from "./calendar-template.ts";

const SH = "Asia/Shanghai";
const NY = "America/New_York";

function src(over: Partial<SourceItem> = {}): SourceItem {
  return { kind: "task", title: "写周报", bodyMd: "", allDay: false, startsAt: null, endsAt: null, dueAt: null, timezone: SH, priority: 0, ...over };
}
function tpl(over: Partial<TemplateItem> = {}): TemplateItem {
  return { kind: "task", title: "写周报", bodyMd: "", allDay: false, offsetDays: 0, startMin: null, durationMin: null, priority: 0, reminders: [], ...over };
}

test("折算：第 0 天按最早的当地日算，同一天的晚场不会被折成第二天", () => {
  const items = itemsToTemplate([
    src({ title: "早会", kind: "event", startsAt: wallToUtc(2026, 9, 7, 9, 0, SH), endsAt: wallToUtc(2026, 9, 7, 9, 30, SH) }),
    src({ title: "复盘", kind: "event", startsAt: wallToUtc(2026, 9, 7, 23, 0, SH), endsAt: wallToUtc(2026, 9, 7, 23, 45, SH) }),
    src({ title: "交周报", dueAt: wallToUtc(2026, 9, 9, 18, 0, SH) }),
  ]);
  assert.deepEqual(items.map(i => [i.title, i.offsetDays, i.startMin, i.durationMin]), [
    ["早会", 0, 9 * 60, 30],
    ["复盘", 0, 23 * 60, 45],
    ["交周报", 2, 18 * 60, null],
  ]);
});

test("折算：全天条目不记时刻；没期限的条目落在第 0 天且不定时刻", () => {
  const items = itemsToTemplate([
    src({ title: "出差", kind: "event", allDay: true, startsAt: wallToUtc(2026, 9, 7, 0, 0, SH) }),
    src({ title: "随手记" }),
  ]);
  assert.equal(items[0]!.startMin, null);
  assert.equal(items[0]!.allDay, true);
  assert.deepEqual([items[1]!.offsetDays, items[1]!.startMin], [0, null]);
});

test("折算：一条都没有时刻时不会除以零，全部落在第 0 天", () => {
  const items = itemsToTemplate([src({ title: "a" }), src({ title: "b" })]);
  assert.deepEqual(items.map(i => i.offsetDays), [0, 0]);
});

test("往返：折算再摊回同一天，时刻分毫不差", () => {
  const start = wallToUtc(2026, 9, 7, 14, 30, SH);
  const [item] = itemsToTemplate([src({ kind: "event", title: "评审", startsAt: start, endsAt: wallToUtc(2026, 9, 7, 15, 30, SH) })]);
  const [planned] = planTemplate([item!], "2026-09-07", SH);
  assert.equal(planned!.start!.toISOString(), start.toISOString());
  assert.equal(planned!.end!.toISOString(), wallToUtc(2026, 9, 7, 15, 30, SH).toISOString());
});

test("摊回：偏移天数按当地日历日走，跨夏令时仍是同一个墙上时刻", () => {
  // 美东 2026-11-01 凌晨退出夏令时。第 0 天定在 10-31，第 1 天必须还是当地 09:00。
  const planned = planTemplate([tpl({ offsetDays: 0, startMin: 9 * 60 }), tpl({ offsetDays: 1, startMin: 9 * 60 })], "2026-10-31", NY);
  assert.equal(planned[0]!.start!.toISOString(), wallToUtc(2026, 10, 31, 9, 0, NY).toISOString());
  assert.equal(planned[1]!.start!.toISOString(), wallToUtc(2026, 11, 1, 9, 0, NY).toISOString());
  // 若按 +86400 秒算，第二天会变成当地 08:00
  assert.notEqual(planned[1]!.start!.getTime() - planned[0]!.start!.getTime(), 86400_000);
});

test("摊回：跨月偏移不越界", () => {
  const [planned] = planTemplate([tpl({ offsetDays: 25, startMin: 0 })], "2026-09-10", SH);
  assert.equal(planned!.base.toISOString(), wallToUtc(2026, 10, 5, 0, 0, SH).toISOString());
});

test("摊回：不定时刻的条目落在当地零点，且不生成结束时刻", () => {
  const [planned] = planTemplate([tpl({ startMin: null, durationMin: 60 })], "2026-09-07", SH);
  assert.equal(planned!.start, null);
  assert.equal(planned!.end, null);
  assert.equal(planned!.base.toISOString(), wallToUtc(2026, 9, 7, 0, 0, SH).toISOString());
});

test("折算有上限，不让一次多选把模板撑爆", () => {
  const many = Array.from({ length: 150 }, (_, i) => src({ title: `t${i}` }));
  assert.equal(itemsToTemplate(many).length, 100);
});

test("折算：夏令时切换那天的时刻按墙钟读，不靠「时刻 − 当地零点」减出来", () => {
  // 美东 2026-11-01 凌晨退夏令时，这一天有 25 小时。当地 09:00 折算出来必须还是 540 分钟。
  const [item] = itemsToTemplate([src({ timezone: NY, dueAt: wallToUtc(2026, 11, 1, 9, 0, NY) })]);
  assert.equal(item!.startMin, 9 * 60);
});
