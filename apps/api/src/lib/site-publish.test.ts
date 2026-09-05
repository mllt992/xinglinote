import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldSeedSiteNotes } from "./site-publish.ts";

test("站点上线时若还没有任何对外页且本里有笔记，应补齐公开页", () => {
  assert.equal(shouldSeedSiteNotes(0, 3), true);
  assert.equal(shouldSeedSiteNotes(0, 1), true);
});

test("已经有对外页时不再批量改笔记，保留单篇挑选", () => {
  assert.equal(shouldSeedSiteNotes(2, 5), false);
  assert.equal(shouldSeedSiteNotes(1, 1), false);
});

test("空笔记本上线不需要补齐", () => {
  assert.equal(shouldSeedSiteNotes(0, 0), false);
});
