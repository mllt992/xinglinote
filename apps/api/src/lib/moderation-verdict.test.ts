import assert from "node:assert/strict";
import { test } from "node:test";
import { decideReport, isRetryableModerationFailure, isRisky, normalizeCategories, noteIsPublic, parseVerdict, slugCategoryKey } from "./moderation-verdict.ts";

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

test("verdict 不是 reject / unsure 一律当放行，别把乱写的字段读成拦截", () => {
  assert.equal(parseVerdict('{"verdict":"maybe","score":10}')?.verdict, "pass");
  assert.equal(parseVerdict('{"verdict":"unsure","score":40}')?.verdict, "unsure");
  assert.equal(parseVerdict('{"verdict":"review","score":40}')?.verdict, "unsure");
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
  assert.equal(isRisky({ ...parsed, verdict: "unsure", score: 10 }, 60), true, "拿不准也转人工");
});

test("举报复核：口径一致才自动拍板，打架交人", () => {
  const base = { categories: [] as string[], reason: null };
  assert.equal(decideReport({ ...base, verdict: "reject", score: 80 }, 60), "reject");
  assert.equal(decideReport({ ...base, verdict: "pass", score: 10 }, 60), "pass");
  assert.equal(decideReport({ ...base, verdict: "unsure", score: 90 }, 60), "review");
  assert.equal(decideReport({ ...base, verdict: "reject", score: 20 }, 60), "review", "说违规但分很低，不自动下架");
  assert.equal(decideReport({ ...base, verdict: "pass", score: 85 }, 60), "review", "说没事但分很高，交人");
});

test("超时和 5xx 才重试，普通 4xx 不重试", () => {
  assert.equal(isRetryableModerationFailure(new Error("The operation was aborted due to timeout")), true);
  assert.equal(isRetryableModerationFailure(new Error("模型返回 429")), true);
  assert.equal(isRetryableModerationFailure(new Error("模型返回 503")), true);
  assert.equal(isRetryableModerationFailure(new Error("模型返回 400")), false);
  assert.equal(isRetryableModerationFailure(new Error("模型没有返回可解析的判定")), false);
});

test("类别：旧的 key 数组和新的对象数组都能读，坏项丢掉", () => {
  const fromKeys = normalizeCategories(["politics", "ad", "???"]);
  assert.deepEqual(fromKeys.map(c => c.key), ["politics", "ad"]);
  assert.equal(fromKeys[0]?.label, "涉政敏感");
  const custom = normalizeCategories([{ key: "scam", label: "诈骗" }, { key: "scam", label: "重复" }]);
  assert.deepEqual(custom, [{ key: "scam", label: "诈骗" }]);
  assert.equal(normalizeCategories(null).length, 7);
});

test("类别 key 从中文标签生成时落到 cat，不撞车", () => {
  assert.equal(slugCategoryKey("诈骗引流", []), "cat");
  assert.equal(slugCategoryKey("诈骗引流", ["cat"]), "cat2");
  assert.equal(slugCategoryKey("Hello World", []), "helloworld");
});

test("笔记对外公开必须 published 且不在审核中", () => {
  assert.equal(noteIsPublic({ published: true, moderationStatus: "none", trashedAt: null }), true);
  assert.equal(noteIsPublic({ published: true, moderationStatus: "pending_review", trashedAt: null }), false);
  assert.equal(noteIsPublic({ published: true, moderationStatus: "rejected", trashedAt: null }), false);
  assert.equal(noteIsPublic({ published: false, moderationStatus: "none", trashedAt: null }), false);
  assert.equal(noteIsPublic({ published: true, moderationStatus: "none", trashedAt: new Date() }), false);
});
