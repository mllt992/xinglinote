import assert from "node:assert/strict";
import { test } from "node:test";
import { applyHunks, collapseDiff, diffLines, diffStats, hunksOf } from "./diff.js";

test("完全相同的文本没有增删", () => {
  const lines = diffLines("一\n二\n三\n", "一\n二\n三\n");
  assert.deepEqual(diffStats(lines), { added: 0, removed: 0 });
  assert.equal(lines.length, 3);
});

test("改一行只报一增一删，并且带上行号", () => {
  const lines = diffLines("一\n二\n三\n", "一\n贰\n三\n");
  assert.deepEqual(diffStats(lines), { added: 1, removed: 1 });
  const del = lines.find(l => l.op === "del");
  const add = lines.find(l => l.op === "add");
  assert.equal(del?.aLine, 2);
  assert.equal(add?.bLine, 2);
});

test("中间插入的行不会把后面的内容整段判成改动", () => {
  const lines = diffLines("a\nb\nc\n", "a\nx\nb\nc\n");
  assert.deepEqual(diffStats(lines), { added: 1, removed: 0 });
  assert.equal(lines.filter(l => l.op === "same").length, 3);
});

test("空文本和有内容的文本互相对比", () => {
  assert.deepEqual(diffStats(diffLines("", "a\nb\n")), { added: 2, removed: 0 });
  assert.deepEqual(diffStats(diffLines("a\nb\n", "")), { added: 0, removed: 2 });
});

test("没改动的大段会被折叠，改动附近的上下文保留", () => {
  const long = Array.from({ length: 40 }, (_, i) => `行 ${i}`).join("\n");
  const edited = long.replace("行 20", "行 20 改过");
  const chunks = collapseDiff(diffLines(long, edited), 3);
  const gap = chunks.filter(c => c.kind === "gap");
  assert.equal(gap.length, 2);
  const shown = chunks.filter(c => c.kind === "lines").flatMap(c => c.lines);
  assert.ok(shown.some(l => l.text === "行 17"));
  assert.ok(shown.some(l => l.text === "行 23"));
  assert.ok(!shown.some(l => l.text === "行 5"));
});

test("连续的增删算一块，隔着未改动行就分块", () => {
  const lines = diffLines("a\nb\nc\nd\ne\n", "a\nB\nc\nD\nE\n");
  const hunks = hunksOf(lines);
  assert.equal(hunks.length, 2);
  assert.deepEqual([hunks[0].added, hunks[0].removed], [1, 1]);
  assert.deepEqual([hunks[1].added, hunks[1].removed], [2, 2]);
});

test("逐块采纳：全接受等于新文，全不接受等于原文", () => {
  const before = "a\nb\nc\nd\ne";
  const after = "a\nB\nc\nD\nE";
  const lines = diffLines(before, after);
  const all = new Set(hunksOf(lines).map(h => h.index));
  assert.equal(applyHunks(lines, all), after);
  assert.equal(applyHunks(lines, new Set()), before);
});

test("逐块采纳：只接受其中一块", () => {
  const lines = diffLines("a\nb\nc\nd\ne", "a\nB\nc\nD\nE");
  assert.equal(applyHunks(lines, new Set([0])), "a\nB\nc\nd\ne");
  assert.equal(applyHunks(lines, new Set([1])), "a\nb\nc\nD\nE");
});
