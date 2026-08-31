import assert from "node:assert/strict";
import test from "node:test";
import { editorWysiwyg } from "./editor-mode";

test("编辑模式固定即时渲染，分栏左侧固定纯 Markdown", () => {
  assert.equal(editorWysiwyg("live"), true);
  assert.equal(editorWysiwyg("source"), false);
});
