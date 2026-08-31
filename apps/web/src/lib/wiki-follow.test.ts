import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeWikiAttr, pointerDragged } from "./wiki-follow.ts";

test("双链 data 属性解码失败时退回原文", () => {
  assert.equal(decodeWikiAttr("%E4%BC%9A%E8%AE%AE"), "会议");
  assert.equal(decodeWikiAttr("%E0%A4%A"), "%E0%A4%A");
  assert.equal(decodeWikiAttr(undefined), "");
});

test("按下到抬起位移很小才算点击", () => {
  assert.equal(pointerDragged({ x: 0, y: 0 }, { x: 2, y: 2 }), false);
  assert.equal(pointerDragged({ x: 0, y: 0 }, { x: 10, y: 0 }), true);
});
