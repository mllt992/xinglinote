import assert from "node:assert/strict";
import test from "node:test";
import { effectiveLimit, quotaExceededMessage, UNLIMITED } from "./ai-quota.ts";

test("平台 AI 额度：个人设置优先，-1 不限，null 跟随默认", () => {
  assert.equal(effectiveLimit(null, null), null);
  assert.equal(effectiveLimit(null, 20), 20);
  assert.equal(effectiveLimit(5, 20), 5);
  assert.equal(effectiveLimit(0, 20), 0);
  assert.equal(effectiveLimit(UNLIMITED, 20), null);
  assert.equal(effectiveLimit(undefined, -3), null);
});

test("平台 AI 额度：提示语是给用户看的中文，不含技术细节", () => {
  assert.match(quotaExceededMessage(30), /30 次/);
  assert.match(quotaExceededMessage(0), /还没有给你开放/);
  assert.doesNotMatch(quotaExceededMessage(30), /platform|quota|429/i);
});
