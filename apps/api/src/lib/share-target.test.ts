import assert from "node:assert/strict";
import { test } from "node:test";
import { shareCoversNote } from "./share-target.ts";

test("单篇 / 单节分享只覆盖自己那篇", async () => {
  assert.equal(await shareCoversNote({ targetType: "note", targetId: "n1" }, "n1"), true);
  assert.equal(await shareCoversNote({ targetType: "heading", targetId: "n1" }, "n1"), true);
  assert.equal(await shareCoversNote({ targetType: "note", targetId: "n1" }, "n2"), false);
});

test("附件分享不能当笔记通道用", async () => {
  assert.equal(await shareCoversNote({ targetType: "attachment", targetId: "a1" }, "n1"), false);
});
