import assert from "node:assert/strict";
import test from "node:test";
import { channelLimit, effectiveLimit, channelQuotaMessage, quotaExceededMessage, resolveUsageRange, tokenQuotaMessage, UNLIMITED } from "./ai-quota.ts";

test("平台 AI 额度：个人设置优先，-1 不限，null 跟随默认", () => {
  assert.equal(effectiveLimit(null, null), null);
  assert.equal(effectiveLimit(null, 20), 20);
  assert.equal(effectiveLimit(5, 20), 5);
  assert.equal(effectiveLimit(0, 20), 0);
  assert.equal(effectiveLimit(UNLIMITED, 20), null);
  assert.equal(effectiveLimit(undefined, -3), null);
});

test("平台 AI 额度：渠道空着不限，0 是不开放", () => {
  assert.equal(channelLimit(null), null);
  assert.equal(channelLimit(undefined), null);
  assert.equal(channelLimit(0), 0);
  assert.equal(channelLimit(12), 12);
  assert.equal(channelLimit(-1), null);
});

test("平台 AI 额度：提示语是给用户看的中文，不含技术细节", () => {
  assert.match(quotaExceededMessage(30), /30 次/);
  assert.match(quotaExceededMessage(0), /还没有给你开放/);
  assert.doesNotMatch(quotaExceededMessage(30), /platform|quota|429/i);
  assert.match(tokenQuotaMessage(1000), /用量已用满/);
  assert.match(tokenQuotaMessage(0), /还没有给你开放/);
  assert.match(channelQuotaMessage("requests"), /这条平台渠道今天的次数已用完/);
  assert.match(channelQuotaMessage("tokens"), /这条平台渠道今天的用量已用完/);
  for (const text of [tokenQuotaMessage(1000), channelQuotaMessage("requests"), channelQuotaMessage("tokens")]) {
    assert.doesNotMatch(text, /platform|quota|429|token/i);
  }
});

test("用量范围：今天、近 7 天、近 30 天，自定义可对调并限制在一年内", () => {
  const now = new Date("2026-09-29T12:00:00+08:00");
  assert.deepEqual(resolveUsageRange({ preset: "today" }, now), { preset: "today", from: "2026-09-29", to: "2026-09-29" });
  assert.deepEqual(resolveUsageRange({}, now), { preset: "7", from: "2026-09-23", to: "2026-09-29" });
  assert.deepEqual(resolveUsageRange({ preset: "30" }, now), { preset: "30", from: "2026-08-31", to: "2026-09-29" });
  assert.deepEqual(resolveUsageRange({ preset: "custom", from: "2026-09-10", to: "2026-09-01" }, now), { preset: "custom", from: "2026-09-01", to: "2026-09-10" });
  const long = resolveUsageRange({ preset: "custom", from: "2020-01-01", to: "2026-09-29" }, now);
  assert.equal(long.to, "2026-09-29");
  assert.equal(long.from, "2025-09-28");
});
