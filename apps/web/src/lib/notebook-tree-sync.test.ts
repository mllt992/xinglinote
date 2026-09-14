import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pickNotebookAfterLoad,
  shouldApplyNotebookTree,
  shouldFollowNoteNotebook,
} from "./notebook-tree-sync.ts";

test("shouldApplyNotebookTree rejects stale responses", () => {
  assert.equal(shouldApplyNotebookTree("a", "a"), true);
  assert.equal(shouldApplyNotebookTree("a", "b"), false);
  assert.equal(shouldApplyNotebookTree(undefined, "a"), false);
  assert.equal(shouldApplyNotebookTree("a", undefined), false);
});

test("pickNotebookAfterLoad keeps preferred when still listed", () => {
  const nbs = [{ id: "n1" }, { id: "n2" }];
  assert.equal(pickNotebookAfterLoad(nbs, "n2"), "n2");
  assert.equal(pickNotebookAfterLoad(nbs, "gone"), "n1");
  assert.equal(pickNotebookAfterLoad([], "n1"), undefined);
  assert.equal(pickNotebookAfterLoad(nbs, undefined), "n1");
});

test("shouldFollowNoteNotebook yields to intentional notebook pick", () => {
  assert.equal(shouldFollowNoteNotebook("n1", null), true);
  assert.equal(shouldFollowNoteNotebook("n1", "n1"), true);
  assert.equal(shouldFollowNoteNotebook("n1", "n2"), false);
  assert.equal(shouldFollowNoteNotebook(undefined, "n2"), false);
});
