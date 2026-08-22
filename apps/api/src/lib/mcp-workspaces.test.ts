import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkspaceIds, tokenWorkspaceIds } from "./mcp-workspaces.ts";

test("tokenWorkspaceIds：优先数组，空数组回退到主工作区", () => {
  assert.deepEqual(tokenWorkspaceIds({ workspaceId: "a", workspaceIds: ["b", "c"] }), ["b", "c"]);
  assert.deepEqual(tokenWorkspaceIds({ workspaceId: "a", workspaceIds: [] }), ["a"]);
  assert.deepEqual(tokenWorkspaceIds({ workspaceId: "a", workspaceIds: null }), ["a"]);
  assert.deepEqual(tokenWorkspaceIds({ workspaceId: "a", workspaceIds: ["a", "a", "b"] }), ["a", "b"]);
});

test("resolveWorkspaceIds：数组优先，单数兼容，至少一个", () => {
  assert.deepEqual(resolveWorkspaceIds({ workspaceIds: ["a", "b"], workspaceId: "c" }), ["a", "b"]);
  assert.deepEqual(resolveWorkspaceIds({ workspaceId: "c" }), ["c"]);
  assert.deepEqual(resolveWorkspaceIds({ workspaceIds: ["a", "a"] }), ["a"]);
  assert.throws(() => resolveWorkspaceIds({}), /至少选一个工作区/);
  assert.throws(() => resolveWorkspaceIds({ workspaceIds: [] }), /至少选一个工作区/);
});
