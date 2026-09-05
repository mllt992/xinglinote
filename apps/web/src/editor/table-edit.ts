/**
 * 表格的可视化编辑（设计 17 §3.5）。
 *
 * 改的仍然是 Markdown 源码：走 `applyTableOp` 只替换这张表占的行。
 * 列宽是本机偏好（localStorage），不进文档。
 */
import type { EditorView } from "@codemirror/view";
import {
  applyTableOp, canDeleteColumn, canDeleteRow, decodeCellBreaks, parseTable,
  type Align, type TableOp,
} from "@kb/shared/markdown";
import {
  activeTableCellInput, tableCellWrappedWith, tableTextSelection, toggleTableCellWrap,
} from "./table-cell-format";
export {
  activeTableCellInput, tableCellWrappedWith, tableTextSelection, toggleTableCellWrap,
} from "./table-cell-format";

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
 * 找到可视化表格某个单元格在表格 Markdown 源码里的内容范围。
 * textarea 里放的是 trim 后的原始单元格内容，所以两边空白不能算进范围；
 * `\|` 则要和解析器一样视作内容，而不是列分隔符。
 */
export function tableCellSourceRange(source: string, row: number, col: number): { from: number; to: number } | null {
  const lines: Array<{ text: string; from: number }> = [];
  let from = 0;
  for (const text of source.split("\n")) {
    lines.push({ text, from });
    from += text.length + 1;
  }
  const dataLines = lines.filter((line, index) => index !== 1 && line.text.trim());
  const line = dataLines[row];
  if (!line) return null;

  const cells: Array<{ from: number; to: number }> = [];
  let start = 0;
  for (let i = 0; i < line.text.length; i++) {
    if (line.text[i] === "\\" && line.text[i + 1] === "|") { i++; continue; }
    if (line.text[i] !== "|") continue;
    cells.push({ from: start, to: i });
    start = i + 1;
  }
  cells.push({ from: start, to: line.text.length });

  const leading = /^\s*\|/.test(line.text);
  const trailing = /\|\s*$/.test(line.text) && !/\\\|\s*$/.test(line.text);
  if (leading) cells.shift();
  if (trailing) cells.pop();
  const cell = cells[col];
  if (!cell) return null;

  let contentFrom = cell.from, contentTo = cell.to;
  while (contentFrom < contentTo && /\s/.test(line.text[contentFrom]!)) contentFrom++;
  while (contentTo > contentFrom && /\s/.test(line.text[contentTo - 1]!)) contentTo--;
  return { from: line.from + contentFrom, to: line.from + contentTo };
}

/** 由表格内的源码偏移反查可视化单元格，用于定位时只高亮单元格而不拆掉整张表。 */
export function tableCellAtSourceOffset(source: string, offset: number): { row: number; col: number } | null {
  const parsed = parseTable(source);
  if (!parsed || offset < 0 || offset > source.length) return null;
  for (let row = 0; row < parsed.rows.length; row++) {
    for (let col = 0; col < (parsed.rows[row]?.length ?? 0); col++) {
      const range = tableCellSourceRange(source, row, col);
      if (range && range.from <= offset && offset <= range.to) return { row, col };
    }
  }
  return null;
}

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
  function apply(op: TableOp, focusEditor = true) {
    const view = opts.view;
    const from = view.posAtDOM(box);
    const to = from + opts.source.length;
    if (view.state.sliceDoc(from, to) !== opts.source) return false; // 文档已经变了，这次点击作废
    const next = applyTableOp(opts.source, op);
    if (next === null) return false;
    // 单元格 mousedown 拦了默认行为，CM 光标往往还停在文末。
    // 写回后 view.focus() 会把旧光标滚进视口，看起来像整篇跳到文末。
    // 仅锁 scrollTop 不够：单元格变高后表会相对视口挪位，按表的屏幕位置回锚更稳。
    const scrollDOM = view.scrollDOM;
    const scrollTop = scrollDOM.scrollTop;
    const anchorTop = box.getBoundingClientRect().top;
    // 光标放在表前一个字符，避免落进块小部件范围把表拆回源码；文首的表则放在表后。
    const cursor = from > 0 ? from - 1 : from + next.length;
    view.dispatch({
      changes: { from, to, insert: next },
      selection: { anchor: cursor, head: cursor },
      userEvent: "input.table",
      scrollIntoView: false,
    });
    const restore = () => {
      for (const candidate of Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-md-table"))) {
        let candidateFrom = -1;
        try { candidateFrom = view.posAtDOM(candidate); } catch { continue; }
        if (candidateFrom !== from) continue;
        scrollDOM.scrollTop = scrollTop + (candidate.getBoundingClientRect().top - anchorTop);
        return;
      }
      scrollDOM.scrollTop = scrollTop;
    };
    restore();
    if (focusEditor) view.focus();
    restore();
    requestAnimationFrame(() => { restore(); requestAnimationFrame(restore); });
    window.setTimeout(restore, 0);
    window.setTimeout(restore, 48);
    return true;
  }

  const tools = document.createElement("div");
  tools.className = "cm-table-tools";
  tools.dataset.tableHandle = "1";
  tools.hidden = true;
  box.append(tools);

  let armed: { kind: "col"; index: number } | { kind: "row"; index: number } | null = null;
  let activeCell: { cell: HTMLTableCellElement; finish: (save: boolean, refocus?: boolean) => boolean } | null = null;

  /** 表格写回会重建整个 widget；按原文位置找到新 widget，再打开指定单元格。 */
  function reopenCell(from: number, row: number, col: number) {
    queueMicrotask(() => {
      for (const candidate of Array.from(opts.view.dom.querySelectorAll<HTMLElement>(".cm-md-table"))) {
        let candidateFrom = -1;
        try { candidateFrom = opts.view.posAtDOM(candidate); } catch { continue; }
        if (candidateFrom !== from) continue;
        const tr = candidate.querySelectorAll("tr")[row];
        const cell = tr?.querySelectorAll<HTMLTableCellElement>(":scope > th, :scope > td")[col];
        cell?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
        return;
      }
    });
  }

  /**
   * 单格编辑用真实 textarea 承接输入，不把 CodeMirror 的选区挪进块级替换范围。
   * 保存仍然走 setCell -> applyTableOp，所以写回的唯一事实源还是 Markdown。
   */
  function editCell(cell: HTMLTableCellElement, row: number, col: number) {
    if (cell.querySelector(".cm-table-cell-input")) return;
    if (activeCell && activeCell.cell !== cell) {
      const from = opts.view.posAtDOM(box);
      // 有修改时 widget 会重建，必须在新 widget 里继续；没修改则当前 DOM 还能直接用。
      if (activeCell.finish(true, false)) { reopenCell(from, row, col); return; }
    }
    tools.hidden = true;
    armed = null;

    const raw = parsed!.rows[row]?.[col] ?? "";
    const original = decodeCellBreaks(raw);
    const oldChildren = Array.from(cell.childNodes);
    const oldHeight = cell.getBoundingClientRect().height;
    const input = document.createElement("textarea");
    input.className = "cm-table-cell-input";
    input.rows = 1;
    input.value = original;
    const sourceRange = tableCellSourceRange(opts.source, row, col);
    if (sourceRange && opts.source.slice(sourceRange.from, sourceRange.to) === raw) {
      input.dataset.tableSourceFrom = String(sourceRange.from);
    }
    input.setAttribute("aria-label", `${row === 0 ? "表头" : `第 ${row} 行`}第 ${col + 1} 列`);
    input.title = "Shift+Enter 换行，Enter 保存，Esc 取消；Ctrl/⌘+B / Shift+X 加粗 / 删除线";
    input.style.minHeight = `${Math.max(32, Math.round(oldHeight - 2))}px`;

    let finished = false;
    const restore = (refocus: boolean) => {
      cell.classList.remove("cm-table-cell-editing");
      cell.replaceChildren(...oldChildren);
      if (refocus) cell.focus();
    };
    const finish = (save: boolean, refocus = true) => {
      if (finished) return false;
      finished = true;
      input.removeEventListener("blur", onBlur);
      if (activeCell?.cell === cell) activeCell = null;
      if (!save || input.value === original) { restore(refocus); return false; }
      // 写回失败通常意味着协作端刚改过这张表；保留当前表格，不误写到别的位置。
      const changed = apply({ kind: "setCell", row, col, text: input.value }, refocus);
      if (!changed) restore(refocus);
      return changed;
    };
    const onBlur = () => finish(true, false);
    const fit = () => {
      input.style.height = "0";
      input.style.height = `${Math.max(oldHeight - 2, input.scrollHeight)}px`;
    };

    input.addEventListener("mousedown", event => event.stopPropagation());
    input.addEventListener("click", event => event.stopPropagation());
    input.addEventListener("keydown", event => {
      event.stopPropagation();
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.altKey) {
        const key = event.key.toLowerCase();
        const marker = key === "b" ? "**"
          : key === "i" ? "*"
          : key === "e" ? "`"
          : key === "x" && event.shiftKey ? "~~"
          : null;
        if (marker) {
          event.preventDefault();
          toggleTableCellWrap(opts.view, marker);
          fit();
          return;
        }
      }
      if (event.key === "Escape") { event.preventDefault(); finish(false); return; }
      if (event.key === "Enter" && !event.shiftKey) {
        // Enter 保存时不要 view.focus()——那会把 CM 光标（常在表外）滚进视口。
        event.preventDefault();
        finish(true, false);
        return;
      }
      // Shift+Enter：放行，让 textarea 自己插入换行；input 事件会抬高高度。
      if (event.key === "Tab") {
        event.preventDefault();
        const width = parsed!.rows[0]?.length ?? 1;
        const count = parsed!.rows.length * width;
        const current = row * width + col;
        const next = (current + (event.shiftKey ? count - 1 : 1)) % count;
        const nextRow = Math.floor(next / width), nextCol = next % width;
        const target = table!.querySelectorAll("tr")[nextRow]
          ?.querySelectorAll<HTMLTableCellElement>(":scope > th, :scope > td")[nextCol];
        const from = opts.view.posAtDOM(box);
        if (finish(true, false)) reopenCell(from, nextRow, nextCol);
        else target && editCell(target, nextRow, nextCol);
      }
    });
    input.addEventListener("input", fit);
    input.addEventListener("blur", onBlur);

    cell.classList.add("cm-table-cell-editing");
    cell.replaceChildren(input);
    fit();
    activeCell = { cell, finish };
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  for (const [row, tr] of Array.from(table.querySelectorAll("tr")).entries()) {
    for (const [col, cell] of Array.from(tr.querySelectorAll(":scope > th, :scope > td")).entries()) {
      const td = cell as HTMLTableCellElement;
      td.dataset.tableCell = "1";
      td.tabIndex = 0;
      td.title = "点击编辑单元格";
      td.addEventListener("mousedown", event => {
        if ((event.target as HTMLElement).closest(".cm-table-cell-input, [data-table-handle]")) return;
        event.preventDefault();
        event.stopPropagation();
        editCell(td, row, col);
      });
      td.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== "F2") return;
        event.preventDefault();
        event.stopPropagation();
        editCell(td, row, col);
      });
    }
  }

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
    if (target.closest(".cm-table-cell-input")) { tools.hidden = true; armed = null; return; }
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
