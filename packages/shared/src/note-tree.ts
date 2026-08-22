import { compareNotes, sortNotes, type NoteSortMode, type NoteSortable } from "./note-sort.js";

/** 设计 03 §5.3：目录深度一期上限 8。 */
export const FOLDER_DEPTH_LIMIT = 8;

export type TreeFolder = {
  id: string;
  title: string;
  parentId: string | null;
  sortKey?: number | null;
};

export type TreeNoteItem = NoteSortable & {
  folderId: string | null;
};

export type NoteTreeNode =
  | { kind: "folder"; id: string; folder: TreeFolder; children: NoteTreeNode[] }
  | { kind: "note"; id: string; note: TreeNoteItem };

function parentKey(id: string | null | undefined): string {
  return id ?? "";
}

function compareFolders(a: TreeFolder, b: TreeFolder, mode: NoteSortMode): number {
  return compareNotes(
    { id: a.id, title: a.title, sortKey: a.sortKey ?? 0 },
    { id: b.id, title: b.title, sortKey: b.sortKey ?? 0 },
    mode === "created" ? "custom" : mode,
  );
}

/** 从某目录一路走到本根。含自身，根在最后。成环或缺父时停。 */
export function folderAncestorIds(folders: readonly TreeFolder[], folderId: string | null | undefined): string[] {
  if (!folderId) return [];
  const parentOf = new Map(folders.map((f) => [f.id, f.parentId ?? null]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (let cur: string | null | undefined = folderId; cur; cur = parentOf.get(cur)) {
    if (seen.has(cur)) break;
    if (!parentOf.has(cur) && cur !== folderId) break;
    seen.add(cur);
    out.push(cur);
  }
  return out;
}

export function folderDepth(folders: readonly TreeFolder[], folderId: string | null | undefined): number {
  return folderAncestorIds(folders, folderId).length;
}

/** 某目录是不是另一个的子孙（含自身）。 */
export function isFolderDescendant(folders: readonly TreeFolder[], ancestorId: string, maybeId: string): boolean {
  return folderAncestorIds(folders, maybeId).includes(ancestorId);
}

function descendantDepth(byParent: Map<string, TreeFolder[]>, folderId: string, seen: Set<string>): number {
  if (seen.has(folderId)) return 0;
  seen.add(folderId);
  const kids = byParent.get(folderId) ?? [];
  if (!kids.length) return 1;
  return 1 + Math.max(...kids.map((k) => descendantDepth(byParent, k.id, seen)));
}

/** 把 `folderId` 挂到 `nextParentId` 之后，整棵子树会不会超过深度上限。 */
export function folderMoveExceedsDepth(
  folders: readonly TreeFolder[],
  folderId: string,
  nextParentId: string | null,
): boolean {
  if (nextParentId === folderId) return true;
  if (nextParentId && isFolderDescendant(folders, folderId, nextParentId)) return true;
  const byParent = new Map<string, TreeFolder[]>();
  for (const f of folders) {
    const key = parentKey(f.parentId);
    const list = byParent.get(key);
    if (list) list.push(f);
    else byParent.set(key, [f]);
  }
  const parentDepth = folderDepth(folders, nextParentId);
  const height = descendantDepth(byParent, folderId, new Set());
  return parentDepth + height > FOLDER_DEPTH_LIMIT;
}

export function flattenFolders(
  folders: readonly TreeFolder[],
  mode: NoteSortMode = "name",
): Array<{ folder: TreeFolder; depth: number }> {
  const known = new Set(folders.map((f) => f.id));
  const byParent = new Map<string, TreeFolder[]>();
  for (const f of folders) {
    const parent = f.parentId && known.has(f.parentId) ? f.parentId : null;
    const key = parentKey(parent);
    const list = byParent.get(key);
    if (list) list.push(f);
    else byParent.set(key, [f]);
  }
  for (const list of byParent.values()) list.sort((a, b) => compareFolders(a, b, mode));

  const out: Array<{ folder: TreeFolder; depth: number }> = [];
  const walk = (parentId: string | null, depth: number, trail: Set<string>) => {
    for (const folder of byParent.get(parentKey(parentId)) ?? []) {
      if (trail.has(folder.id)) continue;
      out.push({ folder, depth });
      const next = new Set(trail);
      next.add(folder.id);
      walk(folder.id, depth + 1, next);
    }
  };
  walk(null, 0, new Set());
  return out;
}

/**
 * 把扁平的目录 + 笔记收成一棵树。
 *
 * 每一层先目录后笔记。目录按名称 / 自定义 key；笔记跟中栏排序模式走。
 * `parent_id` 成环或缺父的目录提到本根，避免整棵树走丢。
 */
export function buildNoteTree(
  folders: readonly TreeFolder[],
  notes: readonly TreeNoteItem[],
  mode: NoteSortMode,
): NoteTreeNode[] {
  const known = new Set(folders.map((f) => f.id));
  const byParent = new Map<string, TreeFolder[]>();
  for (const f of folders) {
    const parent = f.parentId && known.has(f.parentId) ? f.parentId : null;
    const key = parentKey(parent);
    const list = byParent.get(key);
    if (list) list.push(f);
    else byParent.set(key, [f]);
  }
  for (const list of byParent.values()) list.sort((a, b) => compareFolders(a, b, mode));

  const notesByFolder = new Map<string, TreeNoteItem[]>();
  for (const n of notes) {
    const folderId = n.folderId && known.has(n.folderId) ? n.folderId : null;
    const key = parentKey(folderId);
    const list = notesByFolder.get(key);
    if (list) list.push(n);
    else notesByFolder.set(key, [n]);
  }
  for (const [key, list] of notesByFolder) notesByFolder.set(key, sortNotes(list, mode));

  const walk = (parentId: string | null, trail: Set<string>): NoteTreeNode[] => {
    const nodes: NoteTreeNode[] = [];
    for (const folder of byParent.get(parentKey(parentId)) ?? []) {
      if (trail.has(folder.id)) continue;
      const next = new Set(trail);
      next.add(folder.id);
      nodes.push({ kind: "folder", id: folder.id, folder, children: walk(folder.id, next) });
    }
    for (const note of notesByFolder.get(parentKey(parentId)) ?? []) {
      nodes.push({ kind: "note", id: note.id, note });
    }
    return nodes;
  };

  const root = walk(null, new Set());
  const placed = new Set<string>();
  const mark = (nodes: NoteTreeNode[]) => {
    for (const node of nodes) {
      placed.add(node.id);
      if (node.kind === "folder") mark(node.children);
    }
  };
  mark(root);
  for (const folder of folders) {
    if (placed.has(folder.id)) continue;
    const node: NoteTreeNode = { kind: "folder", id: folder.id, folder, children: walk(folder.id, new Set([folder.id])) };
    root.push(node);
    mark([node]);
  }
  return root;
}
