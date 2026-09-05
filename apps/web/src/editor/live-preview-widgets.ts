import { type EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import {
  Decoration, type DecorationSet, EditorView, WidgetType,
} from "@codemirror/view";
import { hydrateMath, loadKatex } from "../lib/katex-hydrate";
import { openLightbox } from "../lib/lightbox";
import { renderDiagram } from "../lib/mermaid-hydrate";
import { toSafeHtml } from "../lib/render-html";
import { mountTableEditor } from "./table-edit";
import type { RenderToggles } from "../lib/layout-prefs";

/** 没传开关时一律全开——这个模块被别处直接引用时不该悄悄少渲染点什么。 */
export const ALL_ON: RenderToggles = { image: true, math: true, table: true, diagram: true };

/**
 * 就地渲染。标记（`#`、`**`、`[]()`、`[[]]`）平时藏起来只显示内容，光标凑近了才露出原文。
 *
 * 两档粒度：
 * - **整行**（默认，Obsidian 那套）：光标落在哪一行，那一行整行露出原文。
 * - **元素**（即时渲染 / Typora 那套）：只有光标真正进到那个 `**粗体**` 里才露出星号，
 *   同一行别的标记继续保持渲染态；外加表格就地渲成真表格、正文用比例字体。
 *
 * 铁律（设计 17 §4.1）：**这里全部是 view-only 装饰**，一个字节都不改文档。
 * 唯一会写文档的是复选框，而它只翻 `[ ]` 中间那一个字符。
 */

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly from: number) { super(); }
  eq(other: CheckboxWidget) { return other.checked === this.checked && other.from === this.from; }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-md-task";
    box.addEventListener("mousedown", event => {
      event.preventDefault();
      if (view.state.readOnly) return;
      view.dispatch({ changes: { from: this.from + 1, to: this.from + 2, insert: this.checked ? " " : "x" }, userEvent: "input.task" });
    });
    return box;
  }
}

export class TextWidget extends WidgetType {
  constructor(readonly text: string, readonly cls: string) { super(); }
  eq(other: TextWidget) { return other.text === this.text && other.cls === this.cls; }
  toDOM() {
    const span = document.createElement("span");
    span.className = this.cls;
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() { return false; }
}

export class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const line = document.createElement("span");
    line.className = "cm-md-hr";
    return line;
  }
  ignoreEvent() { return false; }
}

export class ImageWidget extends WidgetType {
  constructor(readonly url: string, readonly alt: string) { super(); }
  eq(other: ImageWidget) { return other.url === this.url && other.alt === this.alt; }
  toDOM() {
    const box = document.createElement("span");
    box.className = "cm-md-image-box";

    const img = document.createElement("img");
    img.className = "cm-md-image";
    img.src = this.url;
    img.alt = this.alt;
    img.title = this.alt || this.url;
    img.addEventListener("error", () => {
      const failed = document.createElement("span");
      failed.className = "cm-md-image-error";
      failed.textContent = `图片加载失败：${this.alt || this.url}`;
      failed.title = this.url;
      img.remove();
      box.append(failed);
    }, { once: true });

    const zoom = document.createElement("button");
    zoom.type = "button";
    zoom.className = "cm-md-image-zoom";
    zoom.textContent = "⤢";
    zoom.title = "放大查看";
    zoom.setAttribute("aria-label", "放大查看");
    zoom.addEventListener("mousedown", event => { event.preventDefault(); event.stopPropagation(); });
    zoom.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      openLightbox(this.url, this.alt);
    });

    box.append(img, zoom);
    return box;
  }
  ignoreEvent(event: Event) { return !!(event.target as HTMLElement | null)?.closest?.(".cm-md-image-zoom"); }
}

export class MathWidget extends WidgetType {
  constructor(readonly source: string, readonly display = false) { super(); }
  eq(other: MathWidget) { return other.source === this.source && other.display === this.display; }
  toDOM() {
    const span = document.createElement("span");
    span.className = this.display ? "cm-md-math cm-md-math-block" : "cm-md-math";
    span.textContent = this.display ? `$$${this.source}$$` : `$${this.source}$`;
    void loadKatex().then(({ default: katex }) => {
      try {
        span.innerHTML = katex.renderToString(this.source, { throwOnError: true, strict: false, displayMode: this.display });
      } catch {
        span.classList.add("cm-md-math-error");
      }
    });
    return span;
  }
  ignoreEvent() { return false; }
}

export class TableWidget extends WidgetType {
  constructor(readonly source: string, readonly noteId: string, readonly canEdit: boolean) { super(); }
  eq(other: TableWidget) { return other.source === this.source && other.canEdit === this.canEdit && other.noteId === this.noteId; }
  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-md-table markdown";
    box.innerHTML = toSafeHtml(this.source);
    void hydrateMath(box);
    mountTableEditor(box, { view, source: this.source, canEdit: this.canEdit, noteId: this.noteId });
    return box;
  }
  ignoreEvent(event: Event) {
    return !!(event.target as HTMLElement | null)?.closest?.("[data-table-cell], [data-table-handle]");
  }
}

export class DiagramWidget extends WidgetType {
  constructor(readonly source: string) { super(); }
  eq(other: DiagramWidget) { return other.source === this.source; }
  toDOM() {
    const box = document.createElement("div");
    box.className = "cm-md-diagram";
    const pre = document.createElement("pre");
    pre.textContent = this.source;
    box.append(pre);
    void renderDiagram(this.source)
      .then(svg => { box.innerHTML = svg; })
      .catch(() => box.classList.add("cm-md-diagram-error"));
    return box;
  }
  ignoreEvent() { return false; }
}

export const hide = Decoration.replace({});
export const codeLine = Decoration.line({ class: "cm-md-code-line" });
export const quoteLine = Decoration.line({ class: "cm-md-quote-line" });
export const blockFirst = Decoration.line({ class: "cm-md-block-first" });
export const blockLast = Decoration.line({ class: "cm-md-block-last" });
export const headingLine = Decoration.line({ class: "cm-md-heading" });
const calloutLines = new Map<string, Decoration>();
export function calloutLine(type: string): Decoration {
  let deco = calloutLines.get(type);
  if (!deco) {
    deco = Decoration.line({ class: `cm-md-quote-line cm-md-callout cm-md-callout-${type}` });
    calloutLines.set(type, deco);
  }
  return deco;
}

export const CALLOUTS = new Set([
  "note", "tip", "info", "success", "question", "warning", "failure", "danger",
  "bug", "example", "quote", "abstract", "important", "caution",
]);
export const CALLOUT_ALIAS: Record<string, string> = {
  hint: "tip", attention: "warning", error: "danger", fail: "failure",
  summary: "abstract", tldr: "abstract", cite: "quote", help: "question", faq: "question",
};

export function isDestinationUrl(node: SyntaxNode): boolean {
  const prev = node.prevSibling;
  return prev?.name === "LinkMark" && prev.prevSibling?.name === "LinkMark";
}

export function hasUrl(link: SyntaxNode | null): boolean {
  for (let child = link?.firstChild; child; child = child.nextSibling) {
    if (child.name === "URL" && isDestinationUrl(child)) return true;
  }
  return false;
}

export function calloutTypeOf(text: string): string | null {
  const hit = /^\s*>\s*\[!([A-Za-z]+)\][+-]?/.exec(text);
  if (!hit) return null;
  const lower = hit[1].toLowerCase();
  const type = CALLOUT_ALIAS[lower] ?? lower;
  return CALLOUTS.has(type) ? type : null;
}

export type Built = { decorations: DecorationSet; atomic: DecorationSet; scopes: Array<{ from: number; to: number }> };

export function revealer(state: EditorState, wysiwyg: boolean) {
  const selection = state.selection.ranges;
  return (from: number, to: number): boolean => {
    if (wysiwyg) return selection.some(r => r.from <= to && r.to >= from);
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;
    return selection.some(r => state.doc.lineAt(r.from).number <= last && state.doc.lineAt(r.to).number >= first);
  };
}

export function wholeLines(state: EditorState, from: number, to: number): boolean {
  return state.doc.lineAt(from).from === from && state.doc.lineAt(to).to === to;
}

export type BlockBuilt = { decorations: DecorationSet; spans: Array<{ from: number; to: number }> };
