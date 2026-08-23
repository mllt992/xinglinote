import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildNoteTree,
  flattenFolders,
  folderAncestorIds,
  folderDepth,
  folderDropZone,
  folderMoveExceedsDepth,
  FOLDER_DEPTH_LIMIT,
  isFolderDescendant,
} from "./note-tree.ts";

const folders = [
  { id: "vps", title: "VPS", parentId: null, sortKey: 0 },
  { id: "cn", title: "国内", parentId: "vps", sortKey: 0 },
  { id: "orphan", title: "孤儿", parentId: "missing", sortKey: 0 },
];

const notes = [
  { id: "review", title: "VPS商家测评", folderId: null, createdAt: "2024-03-01T00:00:00.000Z", sortKey: 1 },
  { id: "ip", title: "IP质量检测", folderId: null, createdAt: "2024-02-01T00:00:00.000Z", sortKey: 0 },
  { id: "inside", title: "搬瓦工", folderId: "vps", createdAt: "2024-04-01T00:00:00.000Z", sortKey: 0 },
  { id: "deep", title: "阿里云", folderId: "cn", createdAt: "2024-05-01T00:00:00.000Z", sortKey: 0 },
];

test("buildNoteTree nests notes under folders and keeps root notes visible", () => {
  const tree = buildNoteTree(folders, notes, "name");
  assert.deepEqual(tree.map((n) => `${n.kind}:${n.id}`), ["folder:orphan", "folder:vps", "note:ip", "note:review"]);
  const vps = tree.find((n) => n.id === "vps");
  assert.equal(vps?.kind, "folder");
  if (vps?.kind !== "folder") return;
  assert.deepEqual(vps.children.map((n) => `${n.kind}:${n.id}`), ["folder:cn", "note:inside"]);
});

test("empty folders still appear", () => {
  const tree = buildNoteTree([{ id: "empty", title: "空", parentId: null }], [], "name");
  assert.equal(tree.length, 1);
  assert.equal(tree[0]?.kind, "folder");
  if (tree[0]?.kind !== "folder") return;
  assert.deepEqual(tree[0].children, []);
});

test("cycle in parentId is lifted to root instead of hanging", () => {
  const cycled = [
    { id: "a", title: "A", parentId: "b" },
    { id: "b", title: "B", parentId: "a" },
  ];
  const tree = buildNoteTree(cycled, [], "name");
  const ids: string[] = [];
  const walk = (nodes: typeof tree) => {
    for (const node of nodes) {
      ids.push(node.id);
      if (node.kind === "folder") walk(node.children);
    }
  };
  walk(tree);
  assert.deepEqual(ids.sort(), ["a", "b"]);
});

test("notes whose folder disappeared surface at root", () => {
  const tree = buildNoteTree([], [{ id: "ghost", title: "幽灵", folderId: "gone" }], "name");
  assert.deepEqual(tree.map((n) => n.id), ["ghost"]);
});

test("folder ancestors and descendant checks", () => {
  assert.deepEqual(folderAncestorIds(folders, "cn"), ["cn", "vps"]);
  assert.equal(folderDepth(folders, "cn"), 2);
  assert.equal(folderDepth(folders, null), 0);
  assert.equal(isFolderDescendant(folders, "vps", "cn"), true);
  assert.equal(isFolderDescendant(folders, "cn", "vps"), false);
});

test("folder move rejects cycles and over-deep nests", () => {
  assert.equal(folderMoveExceedsDepth(folders, "vps", "cn"), true);
  assert.equal(folderMoveExceedsDepth(folders, "cn", null), false);
  const chain: Array<{ id: string; title: string; parentId: string | null }> = [];
  for (let i = 0; i < FOLDER_DEPTH_LIMIT; i++) {
    chain.push({ id: `d${i}`, title: `D${i}`, parentId: i ? `d${i - 1}` : null });
  }
  assert.equal(folderMoveExceedsDepth(chain, "d0", null), false);
  const extra = [...chain, { id: "leaf", title: "leaf", parentId: null }];
  assert.equal(folderMoveExceedsDepth(extra, "leaf", `d${FOLDER_DEPTH_LIMIT - 1}`), true);
});

test("flattenFolders walks depth-first and keeps orphans", () => {
  const flat = flattenFolders(folders, "name");
  assert.deepEqual(flat.map((r) => `${r.depth}:${r.folder.id}`), ["0:orphan", "0:vps", "1:cn"]);
});

test("created and custom modes order sibling folders by sortKey", () => {
  const dirs = [
    { id: "b", title: "B", parentId: null, sortKey: 1 },
    { id: "a", title: "A", parentId: null, sortKey: 0 },
  ];
  assert.deepEqual(buildNoteTree(dirs, [], "custom").map((n) => n.id), ["a", "b"]);
  assert.deepEqual(buildNoteTree(dirs, [], "created").map((n) => n.id), ["a", "b"]);
  assert.deepEqual(buildNoteTree(dirs, [], "name").map((n) => n.id), ["a", "b"]);
});

test("folderDropZone splits a row into before / into / after", () => {
  assert.equal(folderDropZone(0), "before");
  assert.equal(folderDropZone(0.1), "before");
  assert.equal(folderDropZone(0.5), "into");
  assert.equal(folderDropZone(0.9), "after");
  assert.equal(folderDropZone(1), "after");
});
