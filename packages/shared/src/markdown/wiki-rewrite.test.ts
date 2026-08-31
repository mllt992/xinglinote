import assert from "node:assert/strict";
import { test } from "node:test";
import { applyWikiRawRewrites, previousWikiTargetId, retitleWikiRaw } from "./index.js";

test("改名只换双链标题段，保留节与显示名", () => {
  assert.equal(retitleWikiRaw("[[旧名]]", "新名"), "[[新名]]");
  assert.equal(retitleWikiRaw("[[目录/旧名#决议|纪要]]", "新名"), "[[目录/新名#决议|纪要]]");
  assert.equal(retitleWikiRaw("![[旧名]]", "新名"), "![[新名]]");
  assert.equal(retitleWikiRaw("[[新名]]", "新名"), null);
});

test("按偏移回写多条双链", () => {
  const body = "见 [[旧]] 和 ![[旧#节]] 完";
  const a = body.indexOf("[[旧]]");
  const b = body.indexOf("![[旧#节]]");
  assert.equal(
    applyWikiRawRewrites(body, [
      { raw: "[[旧]]", pos: a, next: "[[新]]" },
      { raw: "![[旧#节]]", pos: b, next: "![[新#节]]" },
    ]),
    "见 [[新]] 和 ![[新#节]] 完",
  );
});

test("原文没改才沿用上一次绑的笔记 id", () => {
  const prev = [{ pos: 3, raw: "[[旧]]", targetNoteId: "id-1" }];
  assert.equal(previousWikiTargetId({ raw: "[[旧]]", pos: 3 }, prev), "id-1");
  assert.equal(previousWikiTargetId({ raw: "[[别的]]", pos: 3 }, prev), null);
});
