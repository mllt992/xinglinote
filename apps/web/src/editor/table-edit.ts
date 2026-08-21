/**
 * 表格的可视化编辑（设计 17 §3.5）。
 *
 * 唯一的原则：**改的仍然是 Markdown 源码**。每个动作都走
 * `applyTableOp` 把这一段表格重排一遍再写回去，只替换这张表占的那几行，
 * 表外一个字节都不动——否则行级 diff 会出满屏假变更。
 *
 * 列宽是个例外：Markdown 没有列宽这个概念，写进去就导不回 Obsidian 了，
 * 所以它只是本机偏好，存 localStorage，不进文档、不进备份、不进 MCP。
 */
import type { EditorView } from "@codemirror/view";
import { applyTableOp, canDeleteColumn, canDeleteRow, parseTable, type Align, type TableOp } from "@kb/shared/markdown";

const WIDTH_KEY = "kb.table-width";
const MIN_COL = 48, MAX_COL = 720;

type WidthMap = Record<string, number>;

/**
 * 列宽表在内存里留一份：每张表渲染一次就 `JSON.parse` 一次 localStorage，
 * 一篇满是表格的笔记里光标动一下就要解析十几遍。别处（另一个标签页）改了走 storage 事件失效。
 */
let cached: WidthMap | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("storage", event => { if (!event.key || event.key === WIDTH_KEY) cached = null; });
}

function readWidths(): WidthMap {
  if (cached) return cached;
  try { cached = JSON.parse(localStorage.getItem(WIDTH_KEY) ?? "{}") as WidthMap; } catch { cached = {}; }
  return cached!;
}
function writeWidths(map: WidthMap) {
  // 只保留最近 400 条，不然一个用得久的库会把 localStorage 撑满
  const entries = Object.entries(map).slice(-400);
  cached = Object.fromEntries(entries);
  try { localStorage.setItem(WIDTH_KEY, JSON.stringify(cached)); } catch { /* 隐私模式写不进就算了 */ }
}

/** 表格的身份：笔记 + 表头那一行的文字。用行号会因为上面插了一行就全乱套。 */
export const tableKey = (noteId: string, header: string) => `${noteId}::${header.slice(0, 120)}`;

const ALIGNS: Array<[Align, string, string]> = [
  ["left", "左对齐", "⇤"], ["center", "居中", "↔"], ["right", "右对齐", "⇥"], [null, "不指定", "–"],
];

function button(label: string, title: string, onClick: () => void, disabled = false) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.dataset.tableHandle = "1";
  b.disabled = disabled;
  b.addEventListener("mousedown", e => { e.preventDefault(); e.stopPropagation(); });
  b.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); if (!disabled) onClick(); });
  return b;
}

export type TableEditorOptions = {
  view: EditorView;
  /** 这张表在文档里的原始源码，也是替换范围的长度依据。 */
  source: string;
  /** 只读态不挂任何把手。 */
  canEdit: boolean;
  /** 列宽偏好的命名空间；换篇笔记不该共用宽度。 */
  noteId: string;
};

/**
 * 给已经渲染好的表格挂上把手。`box` 是 TableWidget 的外层容器，
 * 里面已经有渲染器吐出的 `.table-scroll > table`。
 */
export function mountTableEditor(box: HTMLElement, opts: TableEditorOptions) {
  const table = box.querySelector("table");
  if (!table) return;
  const parsed = parseTable(opts.source);
  if (!parsed) return;                       // 解析不出来就只当普通表格渲染，不给编辑入口

  const header = parsed.rows[0]?.join(" | ") ?? "";
  const widths = readWidths();
  const colKey = (i: number) => `${tableKey(opts.noteId, header)}::${i}`;

  // 列宽走 colgroup：改 <col> 的宽度不会引起单元格重排，也不用给每个 td 加内联样式
  const cols = document.createElement("colgroup");
  const width = parsed.rows[0]?.length ?? 0;
  for (let i = 0; i < width; i++) {
    const col = document.createElement("col");
    const w = widths[colKey(i)];
    if (w) col.style.width = `${w}px`;
    cols.append(col);
  }
  table.prepend(cols);
  if (!opts.canEdit) return;

  box.classList.add("cm-table-editable");

  /**
   * 找到这张表此刻在文档里的位置再替换。不能把构造时的 from 记死：
   * 上面的内容一变，那个偏移就指到别处去了。
   */
  function apply(op: TableOp) {
    const view = opts.view;
    const from = view.posAtDOM(box);
    const to = from + opts.source.length;
    if (view.state.sliceDoc(from, to) !== opts.source) return;   // 文档已经变了，这次点击作废
    const next = applyTableOp(opts.source, op);
    if (next === null) return;
    view.dispatch({ changes: { from, to, insert: next }, userEvent: "input.table" });
    view.focus();
  }

  const tools = document.createElement("div");
  tools.className = "cm-table-tools";
  tools.dataset.tableHandle = "1";
  tools.hidden = true;
  box.append(tools);

  let armed: { kind: "col"; index: number } | { kind: "row"; index: number } | null = null;

  function showColumnTools(th: HTMLTableCellElement, index: number) {
    armed = { kind: "col", index };
    tools.replaceChildren(
      button("＋←", "在左边插入一列", () => apply({ kind: "insertColumn", at: index, side: "left" })),
      button("＋→", "在右边插入一列", () => apply({ kind: "insertColumn", at: index, side: "right" })),
      button("✕", canDeleteColumn(parsed!) ? "删除这一列" : "只剩一列了，删了整张表就散了", () => apply({ kind: "deleteColumn", at: index }), !canDeleteColumn(parsed!)),
      ...ALIGNS.map(([align, title, glyph]) => button(glyph, title, () => apply({ kind: "setAlign", at: index, align }))),
    );
    tools.dataset.axis = "col";
    tools.hidden = false;
    tools.style.left = `${th.offsetLeft}px`;
    tools.style.top = "0px";
  }

  function showRowTools(tr: HTMLTableRowElement, index: number) {
    armed = { kind: "row", index };
    const removable = canDeleteRow(parsed!, index);
    tools.replaceChildren(
      button("＋↑", "在上面插入一行", () => apply({ kind: "insertRow", at: index, side: "above" })),
      button("＋↓", "在下面插入一行", () => apply({ kind: "insertRow", at: index, side: "below" })),
      button("✕", removable ? "删除这一行" : "表头是表格存在的前提，删不得", () => apply({ kind: "deleteRow", at: index }), !removable),
    );
    tools.dataset.axis = "row";
    tools.hidden = false;
    tools.style.left = "0px";
    tools.style.top = `${tr.offsetTop}px`;
  }

  box.addEventListener("mousemove", e => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-table-handle]")) return;           // 别在自己的把手上又换一套把手
    const cell = target.closest("th, td") as HTMLTableCellElement | null;
    if (!cell) { tools.hidden = true; armed = null; return; }
    const row = cell.parentElement as HTMLTableRowElement;
    const rowIndex = cell.tagName === "TH" ? 0 : Array.from(table!.querySelectorAll("tbody tr")).indexOf(row) + 1;
    const colIndex = Array.from(row.children).indexOf(cell);
    // 上边缘 8px 内当成「操作这一列」，其余当成「操作这一行」——和电子表格的手感一致
    const box2 = cell.getBoundingClientRect();
    if (e.clientY - box2.top <= 8 || cell.tagName === "TH") showColumnTools(cell, colIndex);
    else showRowTools(row, rowIndex);
  });
  box.addEventListener("mouseleave", () => { tools.hidden = true; armed = null; });

  // —— 拖列边界改显示宽度 ——
  for (const [i, th] of Array.from(table.querySelectorAll("thead th")).entries()) {
    const grip = document.createElement("span");
    grip.className = "cm-table-grip";
    grip.dataset.tableHandle = "1";
    grip.title = "拖动改这一列的显示宽度（不写进 Markdown）";
    grip.addEventListener("mousedown", e => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = (th as HTMLElement).getBoundingClientRect().width;
      const col = cols.children[i] as HTMLElement | undefined;
      if (!col) return;
      const move = (ev: MouseEvent) => {
        const next = Math.min(MAX_COL, Math.max(MIN_COL, Math.round(startW + ev.clientX - startX)));
        col.style.width = `${next}px`;
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        const map = readWidths();
        map[colKey(i)] = parseInt(col.style.width, 10) || startW;
        writeWidths(map);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
    (th as HTMLElement).style.position = "relative";
    th.append(grip);
  }

  // 键盘等价路径（设计 14 的无障碍要求）：焦点在表格里时用 Alt+方向键增删
  box.addEventListener("keydown", e => {
    if (!e.altKey || !armed) return;
    const map: Record<string, TableOp | undefined> = {
      ArrowLeft: armed.kind === "col" ? { kind: "insertColumn", at: armed.index, side: "left" } : undefined,
      ArrowRight: armed.kind === "col" ? { kind: "insertColumn", at: armed.index, side: "right" } : undefined,
      ArrowUp: armed.kind === "row" ? { kind: "insertRow", at: armed.index, side: "above" } : undefined,
      ArrowDown: armed.kind === "row" ? { kind: "insertRow", at: armed.index, side: "below" } : undefined,
      Backspace: armed.kind === "col" ? { kind: "deleteColumn", at: armed.index } : { kind: "deleteRow", at: armed.index },
    };
    const op = map[e.key];
    if (!op) return;
    e.preventDefault();
    e.stopPropagation();
    apply(op);
  });
}
