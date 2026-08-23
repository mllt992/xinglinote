import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://unit:unit@127.0.0.1:1/unit";
const { readIdempotencyKey, requestHash } = await import("./mcp-idempotency.ts");

test("参数哈希不受对象键顺序和 client_request_id 影响", () => {
  const a = requestHash({ title: "同一篇", nested: { z: 1, a: 2 }, client_request_id: crypto.randomUUID() });
  const b = requestHash({ nested: { a: 2, z: 1 }, title: "同一篇", client_request_id: crypto.randomUUID() });
  assert.equal(a, b);
});

test("相同幂等键配不同业务参数能被识别", () => {
  assert.notEqual(requestHash({ title: "第一篇" }), requestHash({ title: "第二篇" }));
});

test("HTTP 幂等头优先于参数键", () => {
  assert.equal(readIdempotencyKey(" header-key ", { client_request_id: crypto.randomUUID() }), "header-key");
});

test("超长幂等键不会被静默截断成碰撞", () => {
  assert.throws(() => readIdempotencyKey("x".repeat(201), {}), /200/);
});
