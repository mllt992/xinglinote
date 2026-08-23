import assert from "node:assert/strict";
import test from "node:test";
import { mcpSourcePath, toMcpSource } from "./mcp-source.ts";

test("MCP 来源包含可直接核验笔记的稳定元数据", () => {
  const source = toMcpSource({
    noteId: "11111111-1111-1111-1111-111111111111",
    title: "同名笔记",
    notebookId: "22222222-2222-2222-2222-222222222222",
    folderId: null,
    workspaceId: "33333333-3333-3333-3333-333333333333",
    version: 12,
    updatedAt: new Date("2026-08-24T00:00:00.000Z"),
    excerpt: "甲".repeat(500),
    score: 0.91,
  }, ["知识库", "同名笔记"]);

  assert.equal(source.note_id, "11111111-1111-1111-1111-111111111111");
  assert.equal(source.notebook_id, "22222222-2222-2222-2222-222222222222");
  assert.equal(source.path, "/知识库/同名笔记");
  assert.equal(source.version, 12);
  assert.equal(source.updated_at, "2026-08-24T00:00:00.000Z");
  assert.equal(source.excerpt.length, 360);
  assert.equal(source.relevance_score, 0.91);
});

test("来源路径不会让标题里的斜杠伪装成目录", () => {
  assert.equal(mcpSourcePath(["笔记本", "研发/运维", "计划"]), "/笔记本/研发／运维/计划");
});

test("同名来源仍由 note_id 唯一标识", () => {
  const base = {
    title: "周报",
    notebookId: "22222222-2222-2222-2222-222222222222",
    folderId: null,
    workspaceId: "33333333-3333-3333-3333-333333333333",
    version: 1,
    updatedAt: new Date("2026-08-24T00:00:00.000Z"),
    excerpt: "摘要",
    score: 1,
  };
  const first = toMcpSource({ ...base, noteId: "11111111-1111-1111-1111-111111111111" }, ["一部", "周报"]);
  const second = toMcpSource({ ...base, noteId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, ["二部", "周报"]);
  assert.equal(first.title, second.title);
  assert.notEqual(first.note_id, second.note_id);
  assert.notEqual(first.path, second.path);
});
