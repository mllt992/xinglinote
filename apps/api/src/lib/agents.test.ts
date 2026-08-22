import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMentions } from "@kb/shared";
import { AGENT_REPLY_MAX, sanitizeAgentReply } from "./agents-text.ts";

test("回复去掉 HTML 并截到评论上限", () => {
  assert.equal(sanitizeAgentReply("  <b>你好</b>\r\n世界  "), "你好\n世界");
  const long = "字".repeat(AGENT_REPLY_MAX + 20);
  const out = sanitizeAgentReply(long);
  assert.equal(out.length, AGENT_REPLY_MAX);
  assert.equal(out.endsWith("…"), true);
});

test("空内容和纯标签不当回复", () => {
  assert.equal(sanitizeAgentReply("   "), "");
  assert.equal(sanitizeAgentReply("<script>alert(1)</script>"), "alert(1)");
});

test("一条正文最多按出现顺序叫到智能体", () => {
  const handles = parseMentions("请 @alpha @beta @gamma @delta 都来看");
  assert.deepEqual(handles.slice(0, 3), ["alpha", "beta", "gamma"]);
});
