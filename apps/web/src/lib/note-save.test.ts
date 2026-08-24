import assert from "node:assert/strict";
import { test } from "node:test";
import { isSaveHotkey, noteDraftChanged, reconcileSavedNote, type NoteDraft } from "./note-save.js";

const draft = (title: string, version = 3): NoteDraft => ({
  id: "note-1",
  title,
  bodyMd: "正文",
  version,
  aiIndex: true,
  published: false,
  tags: ["测试"],
});

test("旧保存响应不会覆盖请求期间输入的数字和顿号", () => {
  const sent = draft("绑定 Telegram");
  const live = { ...draft("11、绑定 Telegram、2"), serverField: "old" };
  const saved = { ...draft("绑定 Telegram", 4), serverField: "fresh" };
  assert.equal(noteDraftChanged(live, sent), true);
  assert.deepEqual(reconcileSavedNote(live, sent, saved), { ...live, version: 4, serverField: "fresh" });
});

test("没有后续编辑时采用完整服务端响应", () => {
  const sent = draft("11、绑定 Telegram");
  const saved = { ...draft("11、绑定 Telegram", 4), serverField: "fresh" };
  assert.equal(noteDraftChanged(sent, sent), false);
  assert.strictEqual(reconcileSavedNote(sent, sent, saved), saved);
});

test("保存快捷键兼容 Ctrl 和 Cmd，但不抢 Alt 组合键", () => {
  assert.equal(isSaveHotkey({ ctrlKey: true, metaKey: false, altKey: false, key: "s" }), true);
  assert.equal(isSaveHotkey({ ctrlKey: false, metaKey: true, altKey: false, key: "S" }), true);
  assert.equal(isSaveHotkey({ ctrlKey: true, metaKey: false, altKey: true, key: "s" }), false);
  assert.equal(isSaveHotkey({ ctrlKey: true, metaKey: false, altKey: false, key: "k" }), false);
});
