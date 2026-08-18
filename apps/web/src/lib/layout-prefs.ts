/** 三栏布局的宽度与折叠状态。纯本机偏好，不进备份、不进 MCP。 */
export type LayoutPrefs = {
  notebooksWidth: number;
  treeWidth: number;
  showNotebooks: boolean;
  showTree: boolean;
};

const KEY = "kb.layout";

export const DEFAULT_LAYOUT: LayoutPrefs = {
  notebooksWidth: 224,
  treeWidth: 288,
  showNotebooks: true,
  showTree: true,
};

export const NOTEBOOKS_MIN = 160, NOTEBOOKS_MAX = 420;
export const TREE_MIN = 200, TREE_MAX = 560;

export const clamp = (value: number, min: number, max: number) => Math.min(Math.max(Math.round(value), min), max);

export function loadLayout(): LayoutPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<LayoutPrefs> | null;
    if (!raw) return DEFAULT_LAYOUT;
    return {
      notebooksWidth: clamp(Number(raw.notebooksWidth) || DEFAULT_LAYOUT.notebooksWidth, NOTEBOOKS_MIN, NOTEBOOKS_MAX),
      treeWidth: clamp(Number(raw.treeWidth) || DEFAULT_LAYOUT.treeWidth, TREE_MIN, TREE_MAX),
      showNotebooks: raw.showNotebooks !== false,
      showTree: raw.showTree !== false,
    };
  } catch { return DEFAULT_LAYOUT; }
}

export function saveLayout(prefs: LayoutPrefs) {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* 隐私模式下写不进去就算了 */ }
}
