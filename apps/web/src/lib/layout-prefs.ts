/** 三栏布局的宽度与折叠状态。纯本机偏好，不进备份、不进 MCP。 */
export type LayoutPrefs = {
  notebooksWidth: number;
  treeWidth: number;
  showNotebooks: boolean;
  showTree: boolean;
  /** 打字机滚动：光标行钉在视口中间。 */
  typewriter: boolean;
  /** 即时渲染（Typora 那套）：标记按元素显隐、表格就地渲染、正文比例字体。 */
  wysiwyg: boolean;
  /** Vim keymap。默认关：少数人的强需求、多数人的灾难（设计 17 §3.3）。 */
  vim: boolean;
};

const KEY = "kb.layout";

export const DEFAULT_LAYOUT: LayoutPrefs = {
  notebooksWidth: 224,
  treeWidth: 288,
  showNotebooks: true,
  showTree: true,
  typewriter: false,
  wysiwyg: true,
  vim: false,
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
      typewriter: raw.typewriter === true,
      wysiwyg: raw.wysiwyg !== false,
      vim: raw.vim === true,
    };
  } catch { return DEFAULT_LAYOUT; }
}

export function saveLayout(prefs: LayoutPrefs) {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* 隐私模式下写不进去就算了 */ }
}
