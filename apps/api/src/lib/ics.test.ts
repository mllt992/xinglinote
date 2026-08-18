import assert from "node:assert/strict";
import { test } from "node:test";
import { wallToUtc } from "./calendar.ts";
import { buildIcs, escapeText, foldLine, isPrivateAddress, parseIcs, type FeedItem } from "./ics.ts";

const SH = "Asia/Shanghai";
const WS = "11111111-1111-1111-1111-111111111111";

function item(over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    kind: "event", title: "季度对齐", allDay: false,
    startsAt: wallToUtc(2026, 8, 18, 15, 0, SH), endsAt: wallToUtc(2026, 8, 18, 16, 0, SH),
    dueAt: null, timezone: SH, status: "open", rrule: null,
    updatedAt: new Date("2026-08-01T00:00:00Z"), workspaceId: WS,
    ...over,
  };
}

test("折行按字节数，且不把中文字符劈成两半", () => {
  const folded = foldLine(`SUMMARY:${"每周例会".repeat(12)}`);
  for (const line of folded.split("\r\n")) assert.ok(Buffer.from(line, "utf8").length <= 75);
  // 折出来的内容拼回去必须和原文一致：劈坏一个字符这里就会是替换符
  assert.equal(folded.split("\r\n").map((l, i) => (i ? l.slice(1) : l)).join(""), `SUMMARY:${"每周例会".repeat(12)}`);
});

test("转义分号、逗号与换行", () => {
  assert.equal(escapeText("a;b,c\nd\\e"), "a\\;b\\,c\\nd\\\\e");
});

test("全天条目按当地日历日导出，GMT+8 的 8 月 18 日不漂到 17 日", () => {
  const ics = buildIcs([item({ allDay: true, startsAt: wallToUtc(2026, 8, 18, 0, 0, SH), endsAt: null, kind: "task", title: "交房租" })], { name: "我的", publicUrl: "http://kb.local" });
  assert.match(ics, /DTSTART;VALUE=DATE:20260818/);
  assert.match(ics, /DTEND;VALUE=DATE:20260819/);
});

test("任务导成 VEVENT 并把状态写进标题，客户端不认 VTODO 也能看见", () => {
  const open = buildIcs([item({ kind: "task", title: "交周报", status: "open" })], { name: "我的", publicUrl: "http://kb.local" });
  const done = buildIcs([item({ kind: "task", title: "交周报", status: "done" })], { name: "我的", publicUrl: "http://kb.local" });
  assert.match(open, /SUMMARY:☐ 交周报/);
  assert.match(done, /SUMMARY:☑ 交周报/);
});

test("导出只含标题、时间与回链，不含任何正文字段", () => {
  const ics = buildIcs([item()], { name: "我的", publicUrl: "http://kb.local" });
  assert.ok(!ics.includes("DESCRIPTION"));
  assert.match(ics, new RegExp(`URL:http://kb.local/w/${WS}/calendar\\?item=`));
});

test("重复规则原样导出，让客户端自己展开", () => {
  const ics = buildIcs([item({ rrule: "FREQ=WEEKLY;BYDAY=FR" })], { name: "我的", publicUrl: "http://kb.local" });
  assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=FR/);
});

test("解析：Z 时刻、TZID 当地时刻、纯日期各按各的规则", () => {
  const events = parseIcs([
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT", "UID:a", "SUMMARY:UTC 会议", "DTSTART:20260818T070000Z", "DTEND:20260818T080000Z", "END:VEVENT",
    "BEGIN:VEVENT", "UID:b", "SUMMARY:本地会议", "DTSTART;TZID=Asia/Shanghai:20260818T150000", "END:VEVENT",
    "BEGIN:VEVENT", "UID:c", "SUMMARY:全天", "DTSTART;VALUE=DATE:20260818", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n"), SH);
  assert.equal(events.length, 3);
  assert.equal(events[0].startsAt.toISOString(), "2026-08-18T07:00:00.000Z");
  // TZID 的 15:00 与上面的 07:00Z 是同一时刻，说明时区被当真了而不是当字符串
  assert.equal(events[1].startsAt.getTime(), events[0].startsAt.getTime());
  assert.equal(events[2].allDay, true);
  assert.equal(events[2].startsAt.toISOString(), "2026-08-17T16:00:00.000Z");
});

test("解析：合并续行与反转义，长中文标题不被截断", () => {
  const events = parseIcs(["BEGIN:VEVENT", "UID:x", "SUMMARY:同产品\\, 设计对齐", " 与排期确认", "DTSTART:20260818T070000Z", "END:VEVENT"].join("\r\n"), SH);
  assert.equal(events[0].summary, "同产品, 设计对齐与排期确认");
});

test("解析：缺 UID 或缺 DTSTART 的条目丢掉，不建半条数据", () => {
  const events = parseIcs(["BEGIN:VEVENT", "SUMMARY:没有 UID", "DTSTART:20260818T070000Z", "END:VEVENT",
    "BEGIN:VEVENT", "UID:y", "SUMMARY:没有时间", "END:VEVENT"].join("\r\n"), SH);
  assert.equal(events.length, 0);
});

test("导出再解析回来，标题与时刻不变", () => {
  const events = parseIcs(buildIcs([item()], { name: "我的", publicUrl: "http://kb.local" }), SH);
  assert.equal(events[0].summary, "季度对齐");
  assert.equal(events[0].startsAt.toISOString(), wallToUtc(2026, 8, 18, 15, 0, SH).toISOString());
});

test("内网地址一律拒绝，公网放行", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} 应当被拒绝`);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700::1111"]) {
    assert.equal(isPrivateAddress(ip), false, `${ip} 应当放行`);
  }
});
