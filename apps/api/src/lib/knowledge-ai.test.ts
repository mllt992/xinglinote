import assert from "node:assert/strict";
import test from "node:test";
import { keywordNeedles, rankKeywordNotes, snippetAround } from "./knowledge-ai.ts";
import { tokenize } from "@kb/core";

test("中文问句拆成 2-gram，而不是整句去 ILIKE", () => {
  const needles = keywordNeedles("智能体在哪配置");
  assert.ok(needles.includes("智能"));
  assert.ok(needles.includes("能体"));
  assert.ok(needles.includes("配置"));
  assert.ok(needles.includes("智能体在哪配置"));
});

test("问「智能体在哪配置」能命中只写了智能体/配置的笔记", () => {
  const hits = rankKeywordNotes("智能体在哪配置", [
    { id: "a", title: "智能体", bodyMd: "实例后台的智能体页可以配置模型、人设和知识检索。", tags: [] },
    { id: "b", title: "旅行计划", bodyMd: "下周去云南。", tags: [] },
    { id: "c", title: "网络配置与协议", bodyMd: "VPS 防火墙端口。", tags: [] },
  ], 8);
  assert.ok(hits.some(h => h.noteId === "a"));
  assert.equal(hits.some(h => h.noteId === "b"), false);
  assert.equal(hits[0]?.noteId, "a");
});

test("摘录落在命中附近", () => {
  const parts = tokenize("安全口令");
  const excerpt = snippetAround("前言若干字。蓝色灯塔项目的安全口令是青瓷河流。后记。", parts);
  assert.match(excerpt, /安全口令/);
  assert.match(excerpt, /青瓷河流/);
});
