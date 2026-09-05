/**
 * 表格单元格编辑态的行内格式（设计 17 §3.5）。
 */
import type { EditorView } from "@codemirror/view";

export function activeTableCellInput(view: EditorView): HTMLTextAreaElement | null {
  const active = view.dom.ownerDocument.activeElement;
  if (!(active instanceof HTMLTextAreaElement) || !active.classList.contains("cm-table-cell-input") || !view.dom.contains(active)) {
    return null;
  }
  return active;
}

/**
 * 单元格编辑态下套 / 脱一对行内标记（`**` / `~~` / `*` / `` ` `` / `==`）。
 * 快捷键与工具条都先走这里：焦点在 textarea 上时 CodeMirror 的选区根本指不到格内文字。
 */
export function toggleTableCellWrap(view: EditorView, marker: string): boolean {
  const input = activeTableCellInput(view);
  if (!input || view.state.readOnly) return false;
  const len = marker.length;
  const start = input.selectionStart, end = input.selectionEnd;
  const value = input.value;
  const before = value.slice(Math.max(0, start - len), start);
  const after = value.slice(end, end + len);
  const starred = marker === "*"
    && value.slice(Math.max(0, start - 2), start) === "**"
    && value.slice(end, end + 2) === "**";
  let next: string, from: number, to: number;
  if (before === marker && after === marker && !starred) {
    next = value.slice(0, start - len) + value.slice(start, end) + value.slice(end + len);
    from = start - len;
    to = end - len;
  } else {
    next = value.slice(0, start) + marker + value.slice(start, end) + marker + value.slice(end);
    from = start + len;
    to = end + len;
  }
  input.value = next;
  input.setSelectionRange(from, to);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

export function tableCellWrappedWith(view: EditorView, marker: string): boolean | null {
  const input = activeTableCellInput(view);
  if (!input) return null;
  const len = marker.length;
  const start = input.selectionStart, end = input.selectionEnd;
  if (start === end) {
    const lineStart = input.value.lastIndexOf("\n", start - 1) + 1;
    const lineEndIdx = input.value.indexOf("\n", start);
    const lineEnd = lineEndIdx < 0 ? input.value.length : lineEndIdx;
    const before = input.value.slice(lineStart, start);
    const after = input.value.slice(start, lineEnd);
    const open = before.lastIndexOf(marker);
    const close = after.indexOf(marker);
    if (open < 0 || close < 0) return false;
    if (marker === "*" && (before.slice(open - 1, open + 1) === "**" || after.slice(close, close + 2) === "**")) return false;
    return true;
  }
  const before = input.value.slice(Math.max(0, start - len), start);
  const after = input.value.slice(end, end + len);
  if (before !== marker || after !== marker) return false;
  if (marker === "*" && input.value.slice(Math.max(0, start - 2), start) === "**" && input.value.slice(end, end + 2) === "**") {
    return false;
  }
  return true;
}

type TextSelection = { text: string; from: number; to: number };

export function tableTextSelection(view: EditorView): TextSelection | null {
  const active = activeTableCellInput(view);
  if (!active) return null;
  const cellFrom = Number(active.dataset.tableSourceFrom);
  const start = active.selectionStart, end = active.selectionEnd;
  if (!Number.isSafeInteger(cellFrom) || start === end) return null;
  const box = active.closest<HTMLElement>(".cm-md-table");
  if (!box) return null;
  let tableFrom: number;
  try { tableFrom = view.posAtDOM(box); } catch { return null; }
  // textarea 里是解码后的换行；源码里是 `<br>`，两边字节对不上时宁可放弃，别引用错位。
  const selection = {
    text: active.value.slice(start, end),
    from: tableFrom + cellFrom + start,
    to: tableFrom + cellFrom + end,
  };
  return view.state.sliceDoc(selection.from, selection.to) === selection.text ? selection : null;
}
