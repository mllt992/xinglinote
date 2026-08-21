import { isNoteSortMode, type NoteSortMode } from "@kb/shared";

export type { NoteSortMode };

const STORAGE_KEY = "kb.notebook-note-sort";
/** 笔记本自己的排序，按工作区记。和「本内笔记怎么排」是两件事，别共用一个键。 */
const NOTEBOOK_KEY = "kb.workspace-notebook-sort";

function readCache(key = STORAGE_KEY): Record<string, NoteSortMode> {
  try {
    const raw = localStorage.getItem(key);
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

/** 侧栏里笔记本怎么排。默认「自定义」——侧栏是人自己摆出来的秩序，不该被创建时间冲掉。 */
export function loadWorkspaceNotebookSort(workspaceId: string): NoteSortMode {
  return readCache(NOTEBOOK_KEY)[workspaceId] ?? "custom";
}

export function saveWorkspaceNotebookSort(workspaceId: string, mode: NoteSortMode): void {
  try {
    localStorage.setItem(NOTEBOOK_KEY, JSON.stringify({ ...readCache(NOTEBOOK_KEY), [workspaceId]: mode }));
  } catch {
    /* 同上 */
  }
}
