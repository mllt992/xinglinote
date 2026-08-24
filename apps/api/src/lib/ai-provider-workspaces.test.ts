import assert from "node:assert/strict";
import test from "node:test";
import { providerWorkspaceIds, resolveProviderWorkspaceIds } from "./ai-provider-workspaces.ts";

test("Provider 旧行回退到 workspace_id", () => {
  assert.deepEqual(providerWorkspaceIds({ workspaceId: "legacy" }), ["legacy"]);
  assert.deepEqual(providerWorkspaceIds({ workspaceId: "legacy", workspaceIds: [] }), ["legacy"]);
});

test("Provider 多工作区去重且以 workspace_ids 为准", () => {
  assert.deepEqual(providerWorkspaceIds({ workspaceId: "legacy", workspaceIds: ["a", "b", "a"] }), ["a", "b"]);
  assert.deepEqual(resolveProviderWorkspaceIds({ workspaceIds: ["a", "b", "a"] }), ["a", "b"]);
});
