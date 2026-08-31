/** 三栏布局的宽度与折叠状态。纯本机偏好，不进备份、不进 MCP。 */
export type LayoutPrefs = {
  notebooksWidth: number;
  treeWidth: number;
  showNotebooks: boolean;
  showTree: boolean;
  /** 打字机滚动：光标行钉在视口中间。 */
  typewriter: boolean;
  /** Vim keymap。默认关：少数人的强需求、多数人的灾难（设计 17 §3.3）。 */
  vim: boolean;
  /** 拼写检查。默认开——这是散文编辑器，CodeMirror 关掉它的默认是给代码用的。 */
  spellcheck: boolean;
  /** 正文字号档位。1 是基准，正文与预览一起缩放。 */
  fontScale: number;
  /**
   * 宽栏：放开 46rem 的正文行宽，让正文铺满整个编辑区（设计 17 §3.2）。
   * 默认关——易读行宽是默认值该有的样子；宽屏上嫌右边空得慌的人自己开。
   */
  wide: boolean;
  /**
   * 就地渲染哪些东西。默认全开；关掉的那项在编辑器里退回源码（预览栏不受影响）。
   * 「只想看源码但保留表格」这类需求靠它，而不是把整个即时渲染关掉。
   */
  render: RenderToggles;
};

export type RenderToggles = { image: boolean; math: boolean; table: boolean; diagram: boolean };
export const RENDER_KEYS = ["image", "math", "table", "diagram"] as const;
export const RENDER_LABELS: Record<keyof RenderToggles, string> = {
  image: "图片", math: "公式", table: "表格", diagram: "图表",
};

/** 字号档位。给固定几档而不是自由输入：自由输入会调出 13.7px 这种半像素的糊字。 */
export const FONT_SCALES = [0.875, 1, 1.125, 1.25] as const;

const KEY = "kb.layout";

export const DEFAULT_LAYOUT: LayoutPrefs = {
  notebooksWidth: 224,
  treeWidth: 288,
  showNotebooks: true,
  showTree: true,
  typewriter: false,
  vim: false,
  spellcheck: true,
  fontScale: 1,
  wide: false,
  render: { image: true, math: true, table: true, diagram: true },
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
      vim: raw.vim === true,
      spellcheck: raw.spellcheck !== false,
      // 存进去的值可能是老版本或者被人手改过，不在档位里就退回基准
      fontScale: (FONT_SCALES as readonly number[]).includes(Number(raw.fontScale)) ? Number(raw.fontScale) : 1,
      wide: raw.wide === true,
      // 缺项一律当开：新增一项渲染时，老用户不该莫名其妙少一样东西
      render: Object.fromEntries(RENDER_KEYS.map(k => [k, (raw.render as Partial<RenderToggles> | undefined)?.[k] !== false])) as RenderToggles,
    };
  } catch { return DEFAULT_LAYOUT; }
}

export function saveLayout(prefs: LayoutPrefs) {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* 隐私模式下写不进去就算了 */ }
}
