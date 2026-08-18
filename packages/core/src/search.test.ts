import assert from "node:assert/strict";
import { test } from "node:test";
import { coverage, recencyBoost, scoreNote, tokenize } from "./search.ts";

const fields = (title: string, body = "", tags: string[] = []) => ({ title, body, tags });

test("中文按 2-gram 切，英文整词不切", () => {
  assert.deepEqual(tokenize("家庭账本").map(p => p.grams), [["家庭", "庭账", "账本"]]);
  assert.deepEqual(tokenize("budget").map(p => p.grams), [["budget"]]);
  assert.deepEqual(tokenize("家庭 budget").map(p => p.raw), ["家庭", "budget"]);
  assert.deepEqual(tokenize("账").map(p => p.grams), [["账"]]);      // 单字就是自己
});

test("中英夹杂的一段也能切开", () => {
  assert.deepEqual(tokenize("记账app").map(p => p.raw), ["记账", "app"]);
});

test("账本 与 家庭账本 互相搜得到", () => {
  const 短 = tokenize("账本"), 长 = tokenize("家庭账本");
  assert.ok(scoreNote(短, fields("家庭账本")) > 0, "短查询要能命中长标题");
  assert.ok(scoreNote(长, fields("账本")) > 0, "长查询要能命中短标题");
});

test("整串命中排在部分命中前面", () => {
  const q = tokenize("家庭账本");
  const exact = scoreNote(q, fields("家庭账本"));
  const partial = scoreNote(q, fields("账本"));
  assert.ok(exact > partial, `整串 ${exact} 应当高于部分 ${partial}`);
});

test("标题命中比正文命中重", () => {
  const q = tokenize("账本");
  assert.ok(scoreNote(q, fields("账本", "无关正文")) > scoreNote(q, fields("无关标题", "账本")));
});

test("标签也算命中", () => {
  const q = tokenize("账本");
  assert.ok(scoreNote(q, fields("无关", "无关", ["账本"])) > 0);
});

test("完全不沾边给 0 分", () => {
  assert.equal(scoreNote(tokenize("账本"), fields("旅行计划", "去云南")), 0);
  assert.equal(scoreNote(tokenize("budget"), fields("旅行计划", "去云南")), 0);
});

test("英文不做 gram，避免噪声", () => {
  assert.equal(coverage(tokenize("budget")[0], "bud"), 0);
  assert.equal(coverage(tokenize("budget")[0], "the budget file"), 1);
});

test("新鲜度加成随时间衰减", () => {
  const now = Date.UTC(2026, 0, 100);
  const fresh = recencyBoost(new Date(now), now);
  const old = recencyBoost(new Date(now - 90 * 86400000), now);
  assert.ok(fresh > old && Math.abs(old - 0.5) < 1e-9);
});
