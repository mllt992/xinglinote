import assert from "node:assert/strict";
import { test } from "node:test";
import { commentAnchorAt, resolveCommentAnchor } from "./note-comments.js";

test("保存选区与前后文，并能在原位置精确定位", () => {
  const source = "开头\n需要评论的句子\n结尾";
  const text = "需要评论的句子";
  const from = source.indexOf("需要");
  const anchor = commentAnchorAt(source, 7, { from, to: from + text.length, text });
  assert.ok(anchor);
  assert.equal(anchor.version, 7);
  assert.deepEqual(resolveCommentAnchor(source, anchor), { from, to: from + text.length, state: "exact" });
});

test("前面插入内容后仍能重新定位", () => {
  const source = "甲\n目标句\n乙";
  const from = source.indexOf("目标句");
  const anchor = commentAnchorAt(source, 2, { from, to: from + 3, text: "目标句" })!;
  assert.deepEqual(resolveCommentAnchor(`新增\n${source}`, anchor), { from: from + 3, to: from + 6, state: "moved" });
});

test("重复原文用上下文消歧，无法消歧时不误跳", () => {
  const source = "第一节：同一句。\n第二节：同一句。";
  const from = source.lastIndexOf("同一句");
  const anchor = commentAnchorAt(source, 3, { from, to: from + 3, text: "同一句" })!;
  const changed = `前言\n${source}`;
  const moved = changed.lastIndexOf("同一句");
  assert.deepEqual(resolveCommentAnchor(changed, anchor), { from: moved, to: moved + 3, state: "moved" });
  assert.equal(resolveCommentAnchor("同一句\n同一句", { ...anchor, from: 99, to: 102, prefix: "", suffix: "" }), null);
});

test("原文被改掉后锚点明确失效", () => {
  const anchor = commentAnchorAt("旧原文", 1, { from: 0, to: 3, text: "旧原文" })!;
  assert.equal(resolveCommentAnchor("新原文", anchor), null);
});
