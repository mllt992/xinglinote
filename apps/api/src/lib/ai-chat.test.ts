import assert from "node:assert/strict";
import { test } from "node:test";
import { extractChatContent, providerErrorHint } from "./ai-chat.ts";
import { parseOpenAiChatStream } from "./ai-stream.ts";

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

test("SSE 流能跨网络块保住中文并读出 usage", async () => {
  const bytes = new TextEncoder().encode([
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
    "data: [DONE]\n\n",
  ].join(""));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 51));
      controller.enqueue(bytes.slice(51, 77));
      controller.enqueue(bytes.slice(77));
      controller.close();
    },
  });
  const events = [];
  for await (const event of parseOpenAiChatStream(body)) events.push(event);
  assert.equal(events.map(e => e.delta ?? "").join(""), "你好");
  assert.equal(events.find(e => e.usage)?.usage?.completion_tokens, 2);
});
