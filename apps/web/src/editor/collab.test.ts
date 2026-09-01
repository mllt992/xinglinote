import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { createEditorUndoManager, createReconnectController } from "./collab.js";

test("协同撤销不跟踪初始补种，只跟踪编辑器注册的本地 origin", () => {
  const doc = new Y.Doc();
  const text = doc.getText("body");
  const manager = createEditorUndoManager(text);

  text.insert(0, "已有正文");
  assert.equal(manager.undoStack.length, 0);

  const editorOrigin = {};
  manager.addTrackedOrigin(editorOrigin);
  doc.transact(() => text.insert(text.length, "新增"), editorOrigin);
  assert.equal(manager.undoStack.length, 1);
  manager.undo();
  assert.equal(text.toString(), "已有正文");

  manager.destroy();
  doc.destroy();
});

test("连续断连只暂停一次，不在 close 回调里递归 disconnect，并会降频恢复", async () => {
  const calls: string[] = [];
  const controller = createReconnectController({
    pause: () => calls.push("pause"),
    resume: () => calls.push("resume"),
    offline: () => calls.push("offline"),
    connecting: () => calls.push("connecting"),
  }, { failureLimit: 3, cooldownMs: 5 });

  controller.closed();
  controller.closed();
  assert.deepEqual(calls, []);
  controller.closed();
  // 即使底层在同一轮 close 里重复通知，也必须保持幂等，不能再次 pause/触发递归链。
  for (let i = 0; i < 10_000; i++) controller.closed();
  assert.deepEqual(calls, ["pause", "offline"]);

  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(calls, ["pause", "offline", "connecting", "resume"]);
  controller.destroy();
});

test("成功同步会清零连续失败，销毁后不会再恢复连接", async () => {
  const calls: string[] = [];
  const actions = {
    pause: () => calls.push("pause"),
    resume: () => calls.push("resume"),
    offline: () => calls.push("offline"),
    connecting: () => calls.push("connecting"),
  };
  const reset = createReconnectController(actions, { failureLimit: 3, cooldownMs: 5 });
  reset.closed();
  reset.closed();
  reset.synced();
  reset.closed();
  assert.deepEqual(calls, [], "同步后的第一次断连不能沿用旧失败次数");
  reset.destroy();

  const disposed = createReconnectController(actions, { failureLimit: 1, cooldownMs: 5 });
  disposed.closed();
  disposed.destroy();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(calls, ["pause", "offline"], "卸载后定时器不能复活已销毁的 provider");
});
