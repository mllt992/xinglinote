import assert from "node:assert/strict";
import test from "node:test";
import { shareCookieName, shareCookieValid, shareCookieValue } from "./share-cookie.ts";

const id = "11111111-2222-3333-4444-555555555555";
const hash = "$argon2id$v=19$m=65536,t=3,p=4$aaaa$bbbb";

test("cookie 名只取 token 前缀，不泄露完整 token", () => {
  const token = "abcdefghijklmnopqrstuvwxyz";
  assert.equal(shareCookieName(token), "share_abcdefghijklmnop");
  assert.ok(!shareCookieName(token).includes(token));
});

test("解锁凭证认自己", () => {
  assert.ok(shareCookieValid(shareCookieValue(id, hash), id, hash));
});

test("换了密码，之前发出去的凭证立刻失效", () => {
  const old = shareCookieValue(id, hash);
  assert.ok(!shareCookieValid(old, id, "$argon2id$v=19$m=65536,t=3,p=4$cccc$dddd"));
});

test("光知道 share.id 造不出凭证", () => {
  // 以前 cookie 存的就是 share.id 本身，从工作区分享总览里就能读到
  assert.ok(!shareCookieValid(id, id, hash));
});

test("别的分享的凭证不通用", () => {
  const other = shareCookieValue("99999999-2222-3333-4444-555555555555", hash);
  assert.ok(!shareCookieValid(other, id, hash));
});

test("空值不放行", () => {
  assert.ok(!shareCookieValid(undefined, id, hash));
  assert.ok(!shareCookieValid("", id, hash));
});
