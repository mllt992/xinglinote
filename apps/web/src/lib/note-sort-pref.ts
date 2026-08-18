import { isNoteSortMode, type NoteSortMode } from "@kb/shared";

export type { NoteSortMode };

const STORAGE_KEY = "kb.notebook-note-sort";

function readCache(): Record<string, NoteSortMode> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, NoteSortMode> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (id && isNoteSortMode(value)) out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadNotebookNoteSort(notebookId: string): NoteSortMode {
  return readCache()[notebookId] ?? "created";
}

export function saveNotebookNoteSort(notebookId: string, mode: NoteSortMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readCache(), [notebookId]: mode }));
  } catch {
    /* 隐私模式或配额满时忽略，本次会话内 state 仍生效 */
  }
}
