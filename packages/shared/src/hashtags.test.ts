import assert from "node:assert/strict";
import { test } from "node:test";
import { hashtagQuery, isHashtag, parseHashtags, splitHashtags } from "./hashtags.ts";

test("抽出中英文标签，忽略标题和颜色", () => {
  assert.deepEqual(parseHashtags("今天聊 #轻舟 和 #Yunli，顺便 #轻舟"), ["轻舟", "yunli"]);
  assert.deepEqual(parseHashtags("# 一级标题\n正文"), []);
  assert.deepEqual(parseHashtags("色值 #fff 和 #112233 不是标签"), []);
});

test("一行最多记 8 个，井号包起来也认", () => {
  const many = Array.from({ length: 10 }, (_, i) => `#t${i}`).join(" ");
  assert.equal(parseHashtags(many).length, 8);
  assert.deepEqual(parseHashtags("看 #话题# 就行"), ["话题"]);
});

test("光标前的 #query 用于补全", () => {
  assert.deepEqual(hashtagQuery("你好 #轻", 5), { query: "轻", start: 3 });
  assert.equal(hashtagQuery("你好 #轻 后面", 10), null);
  assert.deepEqual(hashtagQuery("#", 1), { query: "", start: 0 });
});

test("切段时留下原文", () => {
  const parts = splitHashtags("看 #Arch 吧");
  assert.deepEqual(parts, [
    { type: "text", value: "看 " },
    { type: "hashtag", value: "#Arch", tag: "arch" },
    { type: "text", value: " 吧" },
  ]);
});

test("合法标签才过", () => {
  assert.equal(isHashtag("轻舟"), true);
  assert.equal(isHashtag("fff"), false);
  assert.equal(isHashtag(""), false);
});
