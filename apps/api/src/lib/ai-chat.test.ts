import assert from "node:assert/strict";
import { test } from "node:test";
import { extractChatContent, providerErrorHint } from "./ai-chat.ts";

test("抽出普通字符串 content", () => {
  assert.equal(extractChatContent({ choices: [{ message: { content: "  你好  " } }] }), "你好");
});

test("抽出分段 content 和 reasoning_content", () => {
  assert.equal(extractChatContent({
    choices: [{ message: { content: [{ type: "text", text: "一" }, { type: "text", text: "二" }] } }],
  }), "一二");
  assert.equal(extractChatContent({
    choices: [{ message: { content: "", reasoning_content: "先想再答" } }],
  }), "先想再答");
});

test("没有字就当空", () => {
  assert.equal(extractChatContent(null), "");
  assert.equal(extractChatContent({ choices: [] }), "");
});

test("401 说人话，不把整段响应糊上去", () => {
  assert.match(providerErrorHint(401, `{"error":{"message":"Incorrect API key"}}`), /请检查 Key/);
  assert.match(providerErrorHint(404, "{}"), /找不到这个模型/);
});
