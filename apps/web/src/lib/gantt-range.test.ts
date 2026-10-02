import test from "node:test";
import assert from "node:assert/strict";
import { defaultGanttRange, ganttInterval, overlapsGanttRange } from "./gantt-range.ts";
test("default 15-day window spans today across month boundaries", () => {
  assert.deepEqual(defaultGanttRange("2026-10-02"), { from: "2026-09-25", to: "2026-10-09" });
  for (const n of [7, 15, 30]) { const r = defaultGanttRange("2026-10-02", n); assert.equal((Date.parse(r.to) - Date.parse(r.from)) / 86400000 + 1, n); }
});
test("inclusive overlap keeps spanning and one-date tasks but isolates undated tasks", () => {
  const r = { from: "2026-10-01", to: "2026-10-15" };
  assert.equal(overlapsGanttRange({ startAt: "2026-09-01", dueAt: "2026-11-01" }, r), true);
  assert.equal(overlapsGanttRange({ startAt: null, dueAt: "2026-10-15" }, r), true);
  assert.equal(overlapsGanttRange({ startAt: "2026-10-16", dueAt: null }, r), false);
  assert.equal(overlapsGanttRange({ startAt: null, dueAt: null }, r), false);
  assert.deepEqual(ganttInterval({ startAt: "2026-10-15", dueAt: "2026-10-01" }), r);
});

test("task dates follow the project UTC+8 calendar", () => { assert.deepEqual(ganttInterval({ startAt: null, dueAt: "2026-10-01T16:00:00Z" }), { from: "2026-10-02", to: "2026-10-02" }); });
