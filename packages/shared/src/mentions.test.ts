import assert from "node:assert/strict";
import { test } from "node:test";
import { mentionQuery, parseMentions, splitMentions } from "./mentions.ts";

test("按首次出现收集 @handle，忽略大小写和重复", () => {
  assert.deepEqual(parseMentions("请 @Helper 和 @archivist 看，再 @helper 确认"), ["helper", "archivist"]);
});

test("邮箱和普通字中间的 @ 不当艾特", () => {
  assert.deepEqual(parseMentions("写信到 contact@example.com 或 a@b"), []);
});

test("开头、空白、括号前的 @ 都算", () => {
  assert.deepEqual(parseMentions("@alpha 看一下（@beta）以及\n@gamma"), ["alpha", "beta", "gamma"]);
});

test("不足三位或不合法的 handle 丢掉", () => {
  assert.deepEqual(parseMentions("@ab @1bad @好的 @ok_handle"), ["ok_handle"]);
});

test("光标前的 @query 用于补全", () => {
  assert.deepEqual(mentionQuery("你好 @He", 6), { query: "he", start: 3 });
  assert.equal(mentionQuery("你好 @He 后面", 11), null);
  assert.deepEqual(mentionQuery("@", 1), { query: "", start: 0 });
});

test("切段时保留前后文本，mention 给出小写 handle", () => {
  const parts = splitMentions("找 @Arch 帮忙");
  assert.deepEqual(parts, [
    { type: "text", value: "找 " },
    { type: "mention", value: "@Arch", handle: "arch" },
    { type: "text", value: " 帮忙" },
  ]);
});
