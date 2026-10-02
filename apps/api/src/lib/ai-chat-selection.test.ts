import test from "node:test";
import assert from "node:assert/strict";
import { chatSelectionAllowed } from "./ai-chat-selection.ts";
const shared = { enabled: true, ownerUserId: null, chatModels: ["model-a", "model-b"], chatModel: "legacy" };
test("共享与个人模型选择保持目录和所有权边界", () => {
  assert.equal(chatSelectionAllowed(shared, "alice", "model-b"), true);
  assert.equal(chatSelectionAllowed(shared, "alice", "legacy"), true);
  assert.equal(chatSelectionAllowed(shared, "alice", "unregistered"), false);
  assert.equal(chatSelectionAllowed({ ...shared, ownerUserId: "alice" }, "alice", "model-a"), true);
  assert.equal(chatSelectionAllowed({ ...shared, ownerUserId: "alice" }, "bob", "model-a"), false);
  assert.equal(chatSelectionAllowed({ ...shared, enabled: false }, "alice", "model-a"), false);
  assert.equal(chatSelectionAllowed({ ...shared, chatModel: null, chatModels: [] }, "alice", ""), false);
});
