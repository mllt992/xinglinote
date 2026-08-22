import assert from "node:assert/strict";
import test from "node:test";
import { askNeedsNotes, formatAskUserMessage, hitsSupportQuestion, keywordNeedles, packAskContext, rankKeywordNotes, snippetAround } from "./knowledge-ai.ts";
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

test("packAskContext 压预算：每篇最多两段、合计截断", () => {
  const rows = [
    { noteId: "a", title: "甲", excerpt: "x".repeat(400), score: 3 },
    { noteId: "a", title: "甲", excerpt: "y".repeat(400), score: 2 },
    { noteId: "a", title: "甲", excerpt: "z".repeat(400), score: 1 },
    { noteId: "b", title: "乙", excerpt: "k".repeat(400), score: 1 },
  ];
  const packed = packAskContext(rows);
  assert.equal(packed.filter(h => h.noteId === "a").length, 2);
  assert.ok(packed.every(h => h.excerpt.length <= 360));
  assert.ok(packed.reduce((n, h) => n + h.excerpt.length + h.title.length + 16, 0) <= 2200 + 360);
});

test("短换算不翻库，问笔记才翻", () => {
  assert.equal(askNeedsNotes("1亿=? ? M"), false);
  assert.equal(askNeedsNotes("1GB等于多少MB"), false);
  assert.equal(askNeedsNotes("2+3=?"), false);
  assert.equal(askNeedsNotes("安全口令是什么？"), true);
  assert.equal(askNeedsNotes("这个项目的发布流程是什么"), true);
});

test("无关语义近邻不能当引用", () => {
  const kept = hitsSupportQuestion("1亿=? M", [
    { noteId: "a", title: "IP质量检测", excerpt: "查看各个网站识别到的IP状态", score: 1 },
  ]);
  assert.equal(kept.length, 0);
  const hit = hitsSupportQuestion("安全口令是什么", [
    { noteId: "b", title: "火星计划", excerpt: "蓝色灯塔项目的安全口令是青瓷河流。", score: 1 },
  ]);
  assert.equal(hit[0]?.noteId, "b");
});

test("问答 prompt 不带 note UUID", () => {
  const msg = formatAskUserMessage(
    [{ noteId: "11111111-1111-1111-1111-111111111111", title: "灯塔", excerpt: "口令是青瓷", score: 1 }],
    "口令？",
  );
  assert.match(msg, /\[#1\] 《灯塔》/);
  assert.equal(msg.includes("11111111-1111-1111-1111-111111111111"), false);
});
