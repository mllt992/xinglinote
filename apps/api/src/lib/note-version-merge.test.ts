import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeableNoteVersion } from "./note-version-merge.ts";

const now = Date.parse("2026-03-26T10:00:00Z");
const row = (source: string, extra: Partial<{ id: string; version: number; editorId: string; createdAt: Date }> = {}) => ({
  id: extra.id ?? "v9",
  version: extra.version ?? 9,
  source,
  editorId: extra.editorId ?? "alice",
  createdAt: extra.createdAt ?? new Date(now - 60_000),
});

test("5 分钟内同一 source、同一人、版本对得上才合并", () => {
  assert.equal(mergeableNoteVersion([row("ui")], { currentVersion: 9, source: "ui", editorId: "alice", now }), "v9");
  assert.equal(mergeableNoteVersion([row("mcp")], { currentVersion: 9, source: "mcp", editorId: "alice", now }), "v9");
});

test("超时、换人、换 source、版本对不上，都另起一条", () => {
  assert.equal(mergeableNoteVersion([row("ui", { createdAt: new Date(now - 6 * 60_000) })], { currentVersion: 9, source: "ui", editorId: "alice", now }), null);
  assert.equal(mergeableNoteVersion([row("ui")], { currentVersion: 9, source: "ui", editorId: "bob", now }), null, "别人的自动保存不能并进你的");
  assert.equal(mergeableNoteVersion([row("mcp")], { currentVersion: 9, source: "ui", editorId: "alice", now }), null, "MCP 写过就封版");
  assert.equal(mergeableNoteVersion([row("ui")], { currentVersion: 8, source: "ui", editorId: "alice", now }), null);
  assert.equal(mergeableNoteVersion([], { currentVersion: 9, source: "ui", editorId: "alice", now }), null);
});

test("协同不限编辑者：房间是一处落库", () => {
  assert.equal(mergeableNoteVersion([row("collab")], { currentVersion: 9, source: "collab", now }), "v9");
  assert.equal(mergeableNoteVersion([row("collab")], { currentVersion: 9, source: "collab", editorId: "bob", now }), null, "一旦传入 editorId 仍要核对");
});
