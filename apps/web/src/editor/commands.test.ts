import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";
import { insertTextAtSelection, setHeading, toggleCodeBlock, toggleLinePrefix, toggleTask, toggleWrap } from "./commands.js";
import { insertSnippet } from "./slash-menu.js";

function testEditor(doc: string, anchor = 0, head = anchor) {
  let state = EditorState.create({ doc, selection: { anchor, head } });
  const view = {
    get state() { return state; },
    dispatch: (...specs: TransactionSpec[]) => { state = state.update(...specs).state; },
  } as unknown as EditorView;
  return {
    view,
    text: () => state.doc.toString(),
    selection: () => state.selection.main,
    run: (command: Command) => command(view),
  };
}

test("包裹格式保留选区，再次执行会取消", () => {
  const editor = testEditor("甲字乙", 1, 2);
  assert.equal(editor.run(toggleWrap("**")), true);
  assert.equal(editor.text(), "甲**字**乙");
  assert.deepEqual({ from: editor.selection().from, to: editor.selection().to }, { from: 3, to: 4 });
  assert.equal(editor.run(toggleWrap("**")), true);
  assert.equal(editor.text(), "甲字乙");
});

test("标题下拉可批量设置 H1-H6，也可恢复正文", () => {
  const editor = testEditor("第一行\n## 第二行", 0, 10);
  assert.equal(editor.run(setHeading(3)), true);
  assert.equal(editor.text(), "### 第一行\n### 第二行");
  assert.equal(editor.run(setHeading(0)), true);
  assert.equal(editor.text(), "第一行\n第二行");
});

test("有序列表覆盖所有选中行，再次执行取消", () => {
  const editor = testEditor("甲\n乙", 0, 3);
  const ordered = toggleLinePrefix("1. ", /^\s*(?:[-*+]|\d+[.)])[ \t]+/);
  assert.equal(editor.run(ordered), true);
  assert.equal(editor.text(), "1. 甲\n1. 乙");
  assert.equal(editor.run(ordered), true);
  assert.equal(editor.text(), "甲\n乙");
});

test("任务按钮对多行使用同一历史事务并保持三态轮转", () => {
  const editor = testEditor("甲\n乙", 0, 3);
  assert.equal(editor.run(toggleTask), true);
  assert.equal(editor.text(), "- [ ] 甲\n- [ ] 乙");
  assert.equal(editor.run(toggleTask), true);
  assert.equal(editor.text(), "- [x] 甲\n- [x] 乙");
  assert.equal(editor.run(toggleTask), true);
  assert.equal(editor.text(), "- 甲\n- 乙");
});

test("代码块包裹与取消保持正文，行中光标会生成合法独占围栏", () => {
  const selected = testEditor("alpha", 0, 5);
  assert.equal(selected.run(toggleCodeBlock), true);
  assert.equal(selected.text(), "```\nalpha\n```");
  assert.equal(selected.run(toggleCodeBlock), true);
  assert.equal(selected.text(), "alpha");

  const inline = testEditor("ab", 1);
  assert.equal(inline.run(toggleCodeBlock), true);
  assert.equal(inline.text(), "a\n```\n\n```\nb");
});

test("工具栏与斜杠菜单共用表格模板", () => {
  const editor = testEditor("");
  assert.equal(editor.run(insertSnippet("table")), true);
  assert.equal(editor.text(), "| 列一 | 列二 |\n| --- | --- |\n|  | |");
  assert.equal(editor.selection().head, 28);

  const afterText = testEditor("上一段", 3);
  assert.equal(afterText.run(insertSnippet("table")), true);
  assert.equal(afterText.text(), "上一段\n| 列一 | 列二 |\n| --- | --- |\n|  | |");
});

test("异步上传结果替换当前选区并把光标放到 Markdown 末尾", () => {
  const editor = testEditor("前选区后", 1, 3);
  assert.equal(editor.run(insertTextAtSelection("[附件](url)", "input.upload")), true);
  assert.equal(editor.text(), "前[附件](url)后");
  assert.equal(editor.selection().head, 10);
});
