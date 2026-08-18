import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, RangeSet } from "@codemirror/state";
import {
  Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType,
} from "@codemirror/view";
import katex from "katex";

/**
 * Obsidian 式 Live Preview：标记（`#`、`**`、`[]()`）平时藏起来只显示内容，
 * 光标落到那一行就把原样式子露出来。
 *
 * 铁律（设计 17 §4.1）：**这里全部是 view-only 装饰**，一个字节都不改文档。
 * 唯一会写文档的是复选框，而它只翻 `[ ]` 中间那一个字符。
 */

class CheckboxWidget extends WidgetType {
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

class TextWidget extends WidgetType {
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

class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const line = document.createElement("span");
    line.className = "cm-md-hr";
    return line;
  }
  ignoreEvent() { return false; }
}

class ImageWidget extends WidgetType {
  constructor(readonly url: string, readonly alt: string) { super(); }
  eq(other: ImageWidget) { return other.url === this.url && other.alt === this.alt; }
  toDOM() {
    const img = document.createElement("img");
    img.className = "cm-md-image";
    img.src = this.url;
    img.alt = this.alt;
    return img;
  }
  ignoreEvent() { return false; }
}

class MathWidget extends WidgetType {
  constructor(readonly source: string, readonly display = false) { super(); }
  eq(other: MathWidget) { return other.source === this.source && other.display === this.display; }
  toDOM() {
    const span = document.createElement("span");
    span.className = this.display ? "cm-md-math cm-md-math-block" : "cm-md-math";
    try {
      // trust 默认 false，KaTeX 不吐原始 HTML；内容也只来自作者自己的文档。
      span.innerHTML = katex.renderToString(this.source, { throwOnError: true, strict: false, displayMode: this.display });
    } catch {
      span.classList.add("cm-md-math-error");
      span.textContent = this.display ? `$$${this.source}$$` : `$${this.source}$`;
    }
    return span;
  }
  ignoreEvent() { return false; }
}

const hide = Decoration.replace({});

/** 有光标或选区落在上面的行要露出原文，用户才改得动。以行为单位，不以字符为单位。 */
function revealedLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) lines.add(n);
  }
  return lines;
}

/** 跨多行的块，只要有任意一行被光标碰到就整块露出原文。 */
function rangeRevealed(state: EditorState, revealed: Set<number>, from: number, to: number): boolean {
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  for (let n = first; n <= last; n++) if (revealed.has(n)) return true;
  return false;
}

type Built = { decorations: DecorationSet; atomic: DecorationSet };

function build(view: EditorView): Built {
  const marks: Range<Decoration>[] = [];
  // 只有「被替换掉的」区间该是原子的：方向键要能一步跨过藏起来的标记。
  // 样式类的 mark 装饰绝不能进这里，否则链接和双链的文字就没法把光标放进去改。
  const atoms: Range<Decoration>[] = [];
  const replace = (deco: Decoration, from: number, to: number) => {
    if (from >= to) return;
    marks.push(deco.range(from, to));
    atoms.push(deco.range(from, to));
  };

  const { state } = view;
  const revealed = revealedLines(state);
  const tree = syntaxTree(state);

  for (const visible of view.visibleRanges) {
    tree.iterate({
      from: visible.from,
      to: visible.to,
      enter: node => {
        const line = state.doc.lineAt(node.from);
        const open = revealed.has(line.number);

        switch (node.name) {
          case "HeaderMark": {
            if (open) return;
            // 连同后面的空格一起藏，不然标题会顶着一格缩进。
            let to = node.to;
            while (to < line.to && state.doc.sliceString(to, to + 1) === " ") to++;
            replace(hide, node.from, to);
            return;
          }
          case "EmphasisMark":
          case "StrikethroughMark":
            if (!open) replace(hide, node.from, node.to);
            return;
          case "CodeMark":
            // 只藏行内代码的反引号；围栏代码块的 ``` 留着，不然看不出块边界。
            if (!open && node.node.parent?.name === "InlineCode") replace(hide, node.from, node.to);
            return;
          case "QuoteMark":
            if (!open) replace(hide, node.from, node.to);
            return;
          case "LinkMark":
          case "URL":
          case "LinkTitle":
            if (!open && node.node.parent?.name === "Link") replace(hide, node.from, node.to);
            return;
          case "Link":
            if (!open) {
              marks.push(Decoration.mark({ class: "cm-md-link", attributes: { title: "Ctrl/⌘ + 单击打开" } }).range(node.from, node.to));
            }
            return;
          case "Image": {
            if (open) return false;
            const parsed = /^!\[([^\]]*)\]\(([^)\s]+)/.exec(state.doc.sliceString(node.from, node.to));
            if (parsed) replace(Decoration.replace({ widget: new ImageWidget(parsed[2], parsed[1]) }), node.from, node.to);
            return false;
          }
          case "WikiLink": {
            if (open) return false;
            const embed = state.doc.sliceString(node.from, node.from + 1) === "!";
            const innerFrom = node.from + (embed ? 3 : 2);
            const innerTo = node.to - 2;
            if (innerFrom >= innerTo) return false;
            replace(hide, node.from, innerFrom);
            replace(hide, innerTo, node.to);
            // `[[标题|别名]]` 只显示别名，标题连同竖线一起藏。
            const pipe = state.doc.sliceString(innerFrom, innerTo).indexOf("|");
            if (pipe >= 0) replace(hide, innerFrom, innerFrom + pipe + 1);
            marks.push(Decoration.mark({
              class: embed ? "cm-md-wiki cm-md-wiki-embed" : "cm-md-wiki",
              attributes: { "data-wiki-from": String(node.from), title: "Ctrl/⌘ + 单击打开" },
            }).range(pipe >= 0 ? innerFrom + pipe + 1 : innerFrom, innerTo));
            return false;
          }
          case "BlockMath": {
            if (rangeRevealed(state, revealed, node.from, node.to)) return false;
            const raw = state.doc.sliceString(node.from, node.to).trim();
            // 没闭合就别渲染，不然刚敲下 `$$` 后面半篇文章会突然变成一坨公式。
            if (!raw.endsWith("$$") || raw.length <= 4) return false;
            const body = raw.slice(2, -2).trim();
            if (!body) return false;
            replace(Decoration.replace({ widget: new MathWidget(body, true), block: true }), node.from, node.to);
            return false;
          }
          case "InlineMath": {
            if (open) return false;
            replace(Decoration.replace({ widget: new MathWidget(state.doc.sliceString(node.from + 1, node.to - 1)) }), node.from, node.to);
            return false;
          }
          case "TaskMarker": {
            // 复选框一直是复选框（Obsidian 同款），光标在这一行也不退回 `[ ]`。
            const checked = state.doc.sliceString(node.from + 1, node.to - 1).trim().toLowerCase() === "x";
            replace(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }), node.from, node.to);
            return false;
          }
          case "ListMark": {
            if (open) return;
            const mark = state.doc.sliceString(node.from, node.to);
            if (mark === "-" || mark === "*" || mark === "+") {
              replace(Decoration.replace({ widget: new TextWidget("•", "cm-md-bullet") }), node.from, node.to);
            }
            return;
          }
          case "HorizontalRule":
            if (!open) replace(Decoration.replace({ widget: new RuleWidget() }), node.from, node.to);
            return;
          default:
            return;
        }
      },
    });
  }
  return { decorations: Decoration.set(marks, true), atomic: Decoration.set(atoms, true) };
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    built: Built;
    constructor(view: EditorView) { this.built = build(view); }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet
        || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.built = build(update.view);
      }
    }
  },
  {
    decorations: plugin => plugin.built.decorations,
    provide: plugin => EditorView.atomicRanges.of(view => view.plugin(plugin)?.built.atomic ?? RangeSet.empty),
  },
);

/** 从某个位置起把整条 `[[…]]` 抠出来。比在语法树里向上爬稳，也不怕 resolveInner 落在标记上。 */
function wikiAt(state: EditorState, from: number) {
  const text = state.doc.sliceString(from, Math.min(from + 512, state.doc.length));
  const hit = /^!?\[\[([^\]\n]+)\]\]/.exec(text);
  if (!hit) return null;
  const [left, alias] = hit[1].split("|");
  const [title, section] = left.split("#");
  return { title: title.trim() || (alias ?? "").trim(), section: section?.trim() || undefined };
}

/**
 * 跟随链接：`Ctrl/⌘ + 单击`。不用裸单击，是为了留住「点一下改字」这个更常用的动作
 * ——想读的时候右边有预览栏。
 */
function followHandler(onWiki?: (title: string, section?: string) => void): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!(event.ctrlKey || event.metaKey) || event.button !== 0) return false;
      const target = event.target as HTMLElement;

      const wiki = target.closest<HTMLElement>(".cm-md-wiki");
      if (wiki && onWiki) {
        const ref = wikiAt(view.state, Number(wiki.dataset.wikiFrom));
        if (!ref) return false;
        event.preventDefault();
        onWiki(ref.title, ref.section);
        return true;
      }

      const link = target.closest<HTMLElement>(".cm-md-link");
      if (!link) return false;
      let node = syntaxTree(view.state).resolveInner(view.posAtDOM(link), 1);
      while (node.parent && node.name !== "Link") node = node.parent;
      if (node.name !== "Link") return false;
      const href = /\]\(\s*<?([^)>\s]+)/.exec(view.state.doc.sliceString(node.from, node.to))?.[1];
      if (!href) return false;
      event.preventDefault();
      const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
      window.open(href, external ? "_blank" : "_self", external ? "noreferrer,noopener" : undefined);
      return true;
    },
  });
}

export function livePreview(onWiki?: (title: string, section?: string) => void): Extension {
  return [livePreviewPlugin, followHandler(onWiki)];
}
