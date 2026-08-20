import assert from "node:assert/strict";
import test from "node:test";
import { hashCode, hashSecret, matchesSecret, registrationCode, secretHashes, secureToken } from "./tokens.ts";

test("注册码的 hash 忽略大小写和空格：人是照着抄的", () => {
  const code = "ABCD-EFGH";
  assert.equal(hashCode(code), hashCode(" abcd-efgh "));
});

test("机器生成的令牌大小写敏感：折叠成大写等于白扔掉一截熵", () => {
  assert.notEqual(hashSecret("kbk_ab12"), hashSecret("KBK_AB12"));
  // 这正是修掉的那个 bug：以前两者是同一个 hash
  assert.equal(hashCode("kbk_ab12"), hashCode("KBK_AB12"));
});

test("secretHashes 同时给出新旧两种 hash，老库里的令牌还能用", () => {
  const token = "kbk_aa_bBcC";
  const hashes = secretHashes(token);
  assert.equal(hashes[0], hashSecret(token));
  assert.ok(hashes.includes(hashCode(token)), "旧的大写折叠 hash 也要在里面");
});

test("全大写的令牌两种算法一致，就只回一个", () => {
  assert.deepEqual(secretHashes("ABC123"), [hashSecret("ABC123")]);
});

test("matchesSecret 只认真正匹配的那个", () => {
  const stored = hashSecret("right");
  assert.ok(matchesSecret(secretHashes("right"), stored));
  assert.ok(!matchesSecret(secretHashes("wrong"), stored));
});

test("secureToken 是 base64url，且每次不同", () => {
  const a = secureToken(24);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(a, secureToken(24));
});

test("注册码只用不易混淆的字符，分组带横杠", () => {
  const code = registrationCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){4}$/);
});
