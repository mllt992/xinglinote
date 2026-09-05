import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldSeedSiteNotes } from "./site-publish.ts";

test("站点上线时若还没有任何 published 意图且本里有笔记，应补齐公开页", () => {
  assert.equal(shouldSeedSiteNotes(0, 3), true);
  assert.equal(shouldSeedSiteNotes(0, 1), true);
});

test("已经有人标过 published 时不再批量改笔记，保留单篇挑选", () => {
  assert.equal(shouldSeedSiteNotes(2, 5), false);
  assert.equal(shouldSeedSiteNotes(1, 1), false);
});

test("审核挂起（published=true 但未对外可见）时不重复补齐", () => {
  assert.equal(shouldSeedSiteNotes(2, 2), false);
});

test("空笔记本上线不需要补齐", () => {
  assert.equal(shouldSeedSiteNotes(0, 0), false);
});
