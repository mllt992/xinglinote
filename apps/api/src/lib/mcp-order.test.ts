import assert from "node:assert/strict";
import test from "node:test";
import { reorderSubset } from "./mcp-order.ts";

test("只重排点名条目并保留未列出条目的槽位", () => {
  assert.deepEqual(reorderSubset(["a", "hidden", "b", "c"], ["c", "a", "b"]), ["c", "hidden", "a", "b"]);
});

test("拒绝重复或不属于当前层的 id", () => {
  assert.equal(reorderSubset(["a", "b"], ["a", "a"]), null);
  assert.equal(reorderSubset(["a", "b"], ["a", "outside"]), null);
});
