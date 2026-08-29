import assert from "node:assert/strict";
import test from "node:test";
import { editorWysiwyg } from "./editor-mode";

test("分栏左侧始终使用纯 Markdown，编辑模式尊重即时渲染开关", () => {
  assert.equal(editorWysiwyg("split", true), false);
  assert.equal(editorWysiwyg("split", false), false);
  assert.equal(editorWysiwyg("write", true), true);
  assert.equal(editorWysiwyg("write", false), false);
});
