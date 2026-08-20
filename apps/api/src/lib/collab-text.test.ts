import assert from "node:assert/strict";
import { test } from "node:test";
import { externalChange, mergeableCollabVersion, minimalPatch } from "./collab-text.ts";

test("最小替换：只掐掉公共前后缀，中间那段才是改动", () => {
  assert.deepEqual(minimalPatch("abcdef", "abXYef"), { at: 2, remove: 2, insert: "XY" });
  assert.deepEqual(minimalPatch("abc", "abc"), null);
  assert.deepEqual(minimalPatch("", "hi"), { at: 0, remove: 0, insert: "hi" });
  assert.deepEqual(minimalPatch("hi", ""), { at: 0, remove: 2, insert: "" });
});

test("最小替换：纯插入不删字，纯删除不插字", () => {
  // 前后缀会一直吃到能吃为止（这里「第」也是公共前缀的一部分），所以只断言性质，不写死落点
  const insert = minimalPatch("第一段\n第三段", "第一段\n第二段\n第三段")!;
  assert.equal(insert.remove, 0);
  assert.equal(insert.insert.length, 4);
  const remove = minimalPatch("一二三四", "一四")!;
  assert.equal(remove.insert, "");
  assert.deepEqual([remove.at, remove.remove], [1, 2]);
});

test("最小替换：把补丁打回去必须还原成目标文本", () => {
  const cases: Array<[string, string]> = [
    ["", "abc"], ["abc", ""], ["aaa", "aaaa"], ["aaaa", "aaa"],
    ["# 标题\n正文", "# 标题\n新的正文"], ["abab", "ab"], ["ab", "abab"],
    ["- [ ] 甲\n- [ ] 乙", "- [x] 甲\n- [ ] 乙"],
  ];
  for (const [from, to] of cases) {
    const p = minimalPatch(from, to);
    const out = p ? from.slice(0, p.at) + p.insert + from.slice(p.at + p.remove) : from;
    assert.equal(out, to, `${JSON.stringify(from)} → ${JSON.stringify(to)}`);
  }
});

test("外部写：DB 里就是房间自己写的那份，就不该回灌", () => {
  // 房里之后又编辑了，该往下写而不是往回灌——否则刚敲的字会被自己上一次的存档冲掉
  assert.equal(externalChange("房里的新文本", "房间上次写的", "房间上次写的"), null);
  assert.equal(externalChange("一样的", "一样的", "别的"), null);
});

test("外部写：DB 既不是当前文本也不是上次写的那份，才算别人动过", () => {
  const p = externalChange("原文加了一句", "原文", "原文加了一句");
  assert.deepEqual(p, { at: 2, remove: 4, insert: "" });
});

test("版本合并：5 分钟内的连续协同落库复用同一条", () => {
  const now = Date.parse("2026-08-20T10:00:00Z");
  const rows = [{ id: "v9", version: 9, source: "collab", createdAt: new Date(now - 60_000) }];
  assert.equal(mergeableCollabVersion(rows, 9, now), "v9");
  assert.equal(mergeableCollabVersion(rows, 8, now), null, "版本对不上不合并");
});

test("版本合并：超时、或上一条不是协同产生的，都另起一条", () => {
  const now = Date.parse("2026-08-20T10:00:00Z");
  assert.equal(mergeableCollabVersion([{ id: "v9", version: 9, source: "collab", createdAt: new Date(now - 6 * 60_000) }], 9, now), null);
  assert.equal(mergeableCollabVersion([{ id: "v9", version: 9, source: "ui", createdAt: new Date(now) }], 9, now), null, "别把人手动存的那一版改掉");
  assert.equal(mergeableCollabVersion([], 9, now), null);
});
