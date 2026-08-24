import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { createEditorUndoManager } from "./collab.js";

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
