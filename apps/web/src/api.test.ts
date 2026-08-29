import assert from "node:assert/strict";
import test from "node:test";
import { readJsonLines } from "./api.ts";

test("NDJSON 解析保留跨 chunk 的中文字符", async () => {
  const bytes = new TextEncoder().encode('{"type":"delta","delta":"你"}\n{"type":"delta","delta":"好"}\n');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 29));
      controller.enqueue(bytes.slice(29, 37));
      controller.enqueue(bytes.slice(37));
      controller.close();
    },
  });
  const events: Array<{ delta: string }> = [];
  await readJsonLines(stream, event => { events.push(event as { delta: string }); });
  assert.equal(events.map(event => event.delta).join(""), "你好");
});
