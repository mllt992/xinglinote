import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isSaveHotkey, noteDraftChanged, noteMetadataKeys, pickNoteMetadata,
  reconcileSavedNote, sameNoteMetadataValue, type NoteDraft,
} from "./note-save.js";

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

test("协同保存把正文与元数据分开，正文变化不会误发旧版本 PATCH", () => {
  assert.deepEqual(noteMetadataKeys({ bodyMd: "新正文" }), []);
  assert.deepEqual(noteMetadataKeys({ title: "新标题", tags: ["甲"] }), ["title", "tags"]);
  assert.deepEqual(pickNoteMetadata({ ...draft("新标题"), tags: ["甲"] }, ["title", "tags"]), {
    title: "新标题",
    tags: ["甲"],
  });
  assert.equal(sameNoteMetadataValue(draft("标题"), { ...draft("标题"), bodyMd: "另一份正文" }, "title"), true);
  assert.equal(sameNoteMetadataValue(draft("标题"), { ...draft("标题"), tags: ["另一项"] }, "tags"), false);
});
