import assert from "node:assert/strict";
import { test } from "node:test";
import { compareNotes, isNoteSortMode, moveNoteId, nextSortKey, placeId, sortNotes } from "@kb/shared";

const notes = [
  { id: "c", title: "笔记10", createdAt: "2024-03-01T00:00:00.000Z", sortKey: 2 },
  { id: "a", title: "笔记2", createdAt: "2024-01-01T00:00:00.000Z", sortKey: 0 },
  { id: "b", title: "alpha", createdAt: "2024-02-01T00:00:00.000Z", sortKey: 1 },
];

test("isNoteSortMode only accepts known modes", () => {
  assert.equal(isNoteSortMode("created"), true);
  assert.equal(isNoteSortMode("name"), true);
  assert.equal(isNoteSortMode("custom"), true);
  assert.equal(isNoteSortMode("updated"), false);
  assert.equal(isNoteSortMode(""), false);
});

test("name sort is locale-aware and numeric", () => {
  const named = [
    { id: "c", title: "File10", createdAt: "2024-01-01T00:00:00.000Z" },
    { id: "a", title: "File2", createdAt: "2024-01-01T00:00:00.000Z" },
    { id: "b", title: "Alpha", createdAt: "2024-01-01T00:00:00.000Z" },
  ];
  assert.deepEqual(sortNotes(named, "name").map((n) => n.id), ["b", "a", "c"]);
});

test("created sort puts newest first", () => {
  assert.deepEqual(sortNotes(notes, "created").map((n) => n.id), ["c", "b", "a"]);
});

test("custom sort uses sortKey then createdAt", () => {
  assert.deepEqual(sortNotes(notes, "custom").map((n) => n.id), ["a", "b", "c"]);
  const tied = [
    { id: "x", title: "x", createdAt: "2024-06-01T00:00:00.000Z", sortKey: 0 },
    { id: "y", title: "y", createdAt: "2024-05-01T00:00:00.000Z", sortKey: 0 },
  ];
  assert.deepEqual(sortNotes(tied, "custom").map((n) => n.id), ["y", "x"]);
});

test("compareNotes falls back to id", () => {
  const a = { id: "aa", title: "同名", createdAt: "2024-01-01T00:00:00.000Z", sortKey: 1 };
  const b = { id: "bb", title: "同名", createdAt: "2024-01-01T00:00:00.000Z", sortKey: 1 };
  assert.ok(compareNotes(a, b, "name") < 0);
  assert.ok(compareNotes(a, b, "created") < 0);
  assert.ok(compareNotes(a, b, "custom") < 0);
});

test("nextSortKey continues after the current max", () => {
  assert.equal(nextSortKey([]), 0);
  assert.equal(nextSortKey([0, 3, 1]), 4);
  assert.equal(nextSortKey([-2]), 0);
});

test("moveNoteId reorders and rejects unknown ids", () => {
  assert.deepEqual(moveNoteId(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  assert.deepEqual(moveNoteId(["a", "b", "c"], "a", "c"), ["b", "c", "a"]);
  assert.deepEqual(moveNoteId(["a", "b"], "a", "a"), ["a", "b"]);
  assert.equal(moveNoteId(["a", "b"], "z", "a"), null);
});

test("placeId inserts before or after and accepts an outsider", () => {
  assert.deepEqual(placeId(["a", "b", "c"], "c", "a", "before"), ["c", "a", "b"]);
  assert.deepEqual(placeId(["a", "b", "c"], "c", "a", "after"), ["a", "c", "b"]);
  assert.deepEqual(placeId(["a", "b", "c"], "a", "c", "after"), ["b", "c", "a"]);
  assert.deepEqual(placeId(["a", "b"], "z", "b", "after"), ["a", "b", "z"]);
  assert.equal(placeId(["a", "b"], "z", "missing", "before"), null);
});
