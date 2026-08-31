import assert from "node:assert/strict";
import test from "node:test";
import { editorPreviewMode, editorWysiwyg } from "./editor-mode";

test("即时渲染开关只控制单栏编辑，分栏左侧始终使用纯 Markdown", () => {
  assert.equal(editorPreviewMode("write", true), "live");
  assert.equal(editorPreviewMode("write", false), "source");
  assert.equal(editorPreviewMode("split", true), "source");
  assert.equal(editorPreviewMode("split", false), "source");
  assert.equal(editorWysiwyg("live"), true);
  assert.equal(editorWysiwyg("source"), false);
});
