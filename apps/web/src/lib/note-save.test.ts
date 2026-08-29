import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isSaveHotkey, NOTE_AUTOSAVE_MS, noteDraftChanged, noteMetadataKeys, parseNoteSaveConflict, pickNoteMetadata,
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

test("飞行期间没改的标签采用服务端，避免盖掉 MCP add_tags", () => {
  const sent = draft("标题");
  const live = { ...sent, bodyMd: "正在打字" };
  const saved = { ...draft("标题", 4), tags: ["测试", "mcp"] };
  assert.deepEqual(reconcileSavedNote(live, sent, saved).tags, ["测试", "mcp"]);
  assert.equal(reconcileSavedNote(live, sent, saved).bodyMd, "正在打字");
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

test("自动保存间隔落在 1.5–2 秒，别再短到 800ms", () => {
  assert.equal(NOTE_AUTOSAVE_MS >= 1500 && NOTE_AUTOSAVE_MS <= 2000, true);
});

test("409 冲突载荷能还原成横幅要用的字段", () => {
  const parsed = parseNoteSaveConflict({
    code: "CONFLICT_VERSION",
    fields: {
      version: "12",
      expected_version: "11",
      current_version: "12",
      updatedBy: "星璃",
      title: "手册",
      bodyMd: "服务端正文",
    },
  });
  assert.deepEqual(parsed, {
    version: 12,
    expectedVersion: 11,
    updatedBy: "星璃",
    title: "手册",
    bodyMd: "服务端正文",
  });
  assert.equal(parseNoteSaveConflict({ code: "VALIDATION" }), null);
  assert.equal(parseNoteSaveConflict({ code: "CONFLICT_VERSION", fields: { version: "x" } }), null);
  assert.equal(parseNoteSaveConflict({ code: "CONFLICT_VERSION", fields: { version: "12" } }), null, "没有对方正文就不能当可加载的冲突");
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
