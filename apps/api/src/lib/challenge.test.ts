import assert from "node:assert/strict";
import test from "node:test";
import { issueChallenge, solveChallenge } from "./challenge.ts";

/** 从题面里把答案算出来，模拟一个老老实实做题的人。 */
function answerOf(question: string) {
  const [a, b] = question.replace("= ?", "").split("+").map(x => Number(x.trim()));
  return String(a + b);
}

test("答对了放行", () => {
  const c = issueChallenge();
  assert.ok(solveChallenge(c.token, answerOf(c.question)));
});

test("答案不在 token 里：这正是原来那版形同虚设的原因", () => {
  const c = issueChallenge();
  const answer = answerOf(c.question);
  // 以前 token 是 `${a+b}.${expires}.${mac}`，split(".")[0] 就是答案
  assert.notEqual(c.token.split(".")[0], answer);
  assert.ok(!c.token.includes(`.${answer}.`), "token 的任何一段都不该等于答案");
});

test("答错了拒绝", () => {
  const c = issueChallenge();
  const wrong = String(Number(answerOf(c.question)) + 1);
  assert.ok(!solveChallenge(c.token, wrong));
});

test("token 一次性：同一份不能反复用", () => {
  const c = issueChallenge();
  const answer = answerOf(c.question);
  assert.ok(solveChallenge(c.token, answer));
  assert.ok(!solveChallenge(c.token, answer), "第二次必须被拒");
});

test("改过的 token 一律不认", () => {
  const c = issueChallenge();
  const [nonce, expires, mac] = c.token.split(".");
  const answer = answerOf(c.question);
  assert.ok(!solveChallenge(`${nonce}.${Number(expires) + 60_000}.${mac}`, answer), "延长有效期要失败");
  assert.ok(!solveChallenge(`${nonce}.${expires}.${mac.slice(0, -1)}x`, answer), "改签名要失败");
  assert.ok(!solveChallenge(`x${nonce}.${expires}.${mac}`, answer), "改 nonce 要失败");
});

test("过期的不认", () => {
  const c = issueChallenge();
  const [nonce, , mac] = c.token.split(".");
  assert.ok(!solveChallenge(`${nonce}.${Date.now() - 1000}.${mac}`, answerOf(c.question)));
});

test("缺参数、非数字答案都直接拒绝", () => {
  const c = issueChallenge();
  assert.ok(!solveChallenge(undefined, "7"));
  assert.ok(!solveChallenge(c.token, undefined));
  assert.ok(!solveChallenge(c.token, "abc"));
  assert.ok(!solveChallenge("不是一个 token", "7"));
});
