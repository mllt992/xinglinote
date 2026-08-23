export const NOTE_SORT_MODES = ["created", "name", "custom"] as const;
export type NoteSortMode = (typeof NOTE_SORT_MODES)[number];

export const NOTE_SORT_LABELS: Record<NoteSortMode, string> = {
  created: "创建时间",
  name: "名称",
  custom: "自定义",
};

export function isNoteSortMode(value: unknown): value is NoteSortMode {
  return typeof value === "string" && (NOTE_SORT_MODES as readonly string[]).includes(value);
}

export type NoteSortable = {
  id: string;
  title: string;
  createdAt?: string | Date | null;
  sortKey?: number | null;
};

function createdTime(value: NoteSortable["createdAt"]): number {
  if (!value) return 0;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

export function compareNotes(a: NoteSortable, b: NoteSortable, mode: NoteSortMode): number {
  if (mode === "name") {
    const byName = a.title.localeCompare(b.title, "zh-CN", { numeric: true, sensitivity: "base" });
    if (byName) return byName;
    return a.id.localeCompare(b.id);
  }
  if (mode === "custom") {
    const byKey = (a.sortKey ?? 0) - (b.sortKey ?? 0);
    if (byKey) return byKey;
    const byCreated = createdTime(a.createdAt) - createdTime(b.createdAt);
    if (byCreated) return byCreated;
    return a.id.localeCompare(b.id);
  }
  const byCreated = createdTime(b.createdAt) - createdTime(a.createdAt);
  if (byCreated) return byCreated;
  return a.id.localeCompare(b.id);
}

export function sortNotes<T extends NoteSortable>(notes: readonly T[], mode: NoteSortMode): T[] {
  return notes.slice().sort((a, b) => compareNotes(a, b, mode));
}

export function nextSortKey(keys: readonly number[]): number {
  return keys.reduce((max, key) => Math.max(max, key), -1) + 1;
}

export function moveNoteId(ids: readonly string[], fromId: string, toId: string): string[] | null {
  if (fromId === toId) return ids.slice();
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from < 0 || to < 0) return null;
  const next = ids.slice();
  next.splice(from, 1);
  next.splice(to, 0, fromId);
  return next;
}

/** 把 `fromId` 插到 `toId` 前或后。`fromId` 可以原本不在列表里（跨父目录拖过来）。 */
export function placeId(
  ids: readonly string[],
  fromId: string,
  toId: string,
  where: "before" | "after",
): string[] | null {
  if (fromId === toId) return ids.slice();
  const next = ids.filter((id) => id !== fromId);
  const to = next.indexOf(toId);
  if (to < 0) return null;
  next.splice(where === "before" ? to : to + 1, 0, fromId);
  return next;
}
