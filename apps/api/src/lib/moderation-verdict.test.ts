import assert from "node:assert/strict";
import { test } from "node:test";
import { isRetryableModerationFailure, isRisky, noteIsPublic, parseVerdict } from "./moderation-verdict.ts";

test("代码块围栏和前后客套话都能剥掉", () => {
  const raw = "好的，判定如下：\n```json\n{\"verdict\":\"reject\",\"score\":88,\"categories\":[\"ad\"],\"reason\":\"贴了外部推广链接\"}\n```\n希望有帮助。";
  assert.deepEqual(parseVerdict(raw), { verdict: "reject", score: 88, categories: ["ad"], reason: "贴了外部推广链接" });
});

test("裸 JSON 也认，缺字段有兜底", () => {
  assert.deepEqual(parseVerdict('{"verdict":"pass"}'), { verdict: "pass", score: null, categories: [], reason: null });
});

test("风险分越界会夹回 0–100，小数四舍五入", () => {
  assert.equal(parseVerdict('{"verdict":"pass","score":180}')?.score, 100);
  assert.equal(parseVerdict('{"verdict":"pass","score":-5}')?.score, 0);
  assert.equal(parseVerdict('{"verdict":"pass","score":59.6}')?.score, 60);
});

test("verdict 不是 reject 一律当放行，别把乱写的字段读成拦截", () => {
  assert.equal(parseVerdict('{"verdict":"maybe","score":10}')?.verdict, "pass");
});

test("读不出 JSON 回 null，交给调用方按模型不可用处理", () => {
  assert.equal(parseVerdict("这条内容我拿不准。"), null);
  assert.equal(parseVerdict('{"verdict":'), null);
});

test("阈值：分数够到就转人工，差一分就放行", () => {
  const parsed = { verdict: "pass" as const, score: 60, categories: [], reason: null };
  assert.equal(isRisky(parsed, 60), true);
  assert.equal(isRisky({ ...parsed, score: 59 }, 60), false);
  assert.equal(isRisky({ ...parsed, score: null }, 60), false);
  assert.equal(isRisky({ ...parsed, verdict: "reject", score: 0 }, 60), true, "模型直接说不行时不看分数");
});

test("超时和 5xx 才重试，普通 4xx 不重试", () => {
  assert.equal(isRetryableModerationFailure(new Error("The operation was aborted due to timeout")), true);
  assert.equal(isRetryableModerationFailure(new Error("模型返回 429")), true);
  assert.equal(isRetryableModerationFailure(new Error("模型返回 503")), true);
  assert.equal(isRetryableModerationFailure(new Error("模型返回 400")), false);
  assert.equal(isRetryableModerationFailure(new Error("模型没有返回可解析的判定")), false);
});

test("笔记对外公开必须 published 且不在审核中", () => {
  assert.equal(noteIsPublic({ published: true, moderationStatus: "none", trashedAt: null }), true);
  assert.equal(noteIsPublic({ published: true, moderationStatus: "pending_review", trashedAt: null }), false);
  assert.equal(noteIsPublic({ published: true, moderationStatus: "rejected", trashedAt: null }), false);
  assert.equal(noteIsPublic({ published: false, moderationStatus: "none", trashedAt: null }), false);
  assert.equal(noteIsPublic({ published: true, moderationStatus: "none", trashedAt: new Date() }), false);
});
