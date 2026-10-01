import assert from "node:assert/strict";
import test from "node:test";
import { analyticsPercent, trendGeometry } from "./analytics-chart";

test("空图、单点、全零序列和非有限值没有 NaN", () => {
  assert.equal(trendGeometry([]).created, "");
  const zero = trendGeometry([{ date: "2026-01-01", created: 0, edited: 0, versions: 0 }]);
  assert.equal(zero.created, "M8.00,172.00");
  assert.equal(zero.ceiling, 4);
  assert.ok(!trendGeometry([{ date: "2026-01-01", created: NaN, edited: Infinity, versions: -4 }]).created.includes("NaN"));
});

test("趋势保持实际峰值和零基线，百分比限定在 0–100", () => {
  const chart = trendGeometry([{ date: "a", created: 2, edited: 0, versions: 5 }, { date: "b", created: 0, edited: 1, versions: 0 }]);
  assert.equal(chart.ceiling, 8);
  assert.equal(chart.created, "M8.00,132.00 L592.00,172.00");
  assert.equal(analyticsPercent(1, 3), 33);
  assert.equal(analyticsPercent(4, 0), 0);
  assert.equal(analyticsPercent(5, 4), 100);
});
