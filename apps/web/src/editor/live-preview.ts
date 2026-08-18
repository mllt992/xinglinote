import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, RangeSet, StateField } from "@codemirror/state";
import type { SyntaxNodeRef } from "@lezer/common";
import {
  Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType,
} from "@codemirror/view";
import { diagramBlockAt } from "@kb/shared/markdown";
import { hydrateMath, loadKatex } from "../lib/katex-hydrate";
import { renderDiagram } from "../lib/mermaid-hydrate";
import { toSafeHtml } from "../lib/render-html";

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
    // 先摆源码，KaTeX 到位再替换。按需加载，第一条公式出现前不会去下这几百 KB。
    span.textContent = this.display ? `$$${this.source}$$` : `$${this.source}$`;
    void loadKatex().then(({ default: katex }) => {
      try {
        // trust 默认 false，KaTeX 不吐原始 HTML；内容也只来自作者自己的文档。
        span.innerHTML = katex.renderToString(this.source, { throwOnError: true, strict: false, displayMode: this.display });
      } catch {
        span.classList.add("cm-md-math-error");
      }
    });
    return span;
  }
  ignoreEvent() { return false; }
}

/** 表格：光标不在里面时渲成真表格，进去了就回源码——改的还是 Markdown，一个字节不动。 */
class TableWidget extends WidgetType {
  constructor(readonly source: string) { super(); }
  eq(other: TableWidget) { return other.source === this.source; }
  toDOM() {
    const box = document.createElement("div");
    box.className = "cm-md-table markdown";
    box.innerHTML = toSafeHtml(this.source);
    void hydrateMath(box);
    return box;
  }
  ignoreEvent() { return false; }
}

/** ```mermaid：光标不在块里就画成图，进去了就回源码。和表格同一个口径。 */
class DiagramWidget extends WidgetType {
  constructor(readonly source: string) { super(); }
  eq(other: DiagramWidget) { return other.source === this.source; }
  toDOM() {
    const box = document.createElement("div");
    box.className = "cm-md-diagram";
    // 先摆源码，mermaid 到位再替换。画错了就停在源码上，光标进去照常改。
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

const hide = Decoration.replace({});
const codeLine = Decoration.line({ class: "cm-md-code-line" });
const quoteLine = Decoration.line({ class: "cm-md-quote-line" });

type Built = { decorations: DecorationSet; atomic: DecorationSet };

/**
 * 这段标记要不要露出原文。
 * 元素粒度看光标是否落在这个构件里（贴边也算，不然刚打完 `**` 就立刻藏起来，
 * 想接着改还得倒回去）；整行粒度看光标在不在同一行。
 */
function revealer(state: EditorState, wysiwyg: boolean) {
  const selection = state.selection.ranges;
  return (from: number, to: number): boolean => {
    if (wysiwyg) return selection.some(r => r.from <= to && r.to >= from);
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;
    return selection.some(r => state.doc.lineAt(r.from).number <= last && state.doc.lineAt(r.to).number >= first);
  };
}

/** 块级替换必须严格盖住整行，否则 CodeMirror 直接抛异常。对不齐就不渲染。 */
function wholeLines(state: EditorState, from: number, to: number): boolean {
  return state.doc.lineAt(from).from === from && state.doc.lineAt(to).to === to;
}

/**
 * 块级装饰（块级公式、表格）**只能走 StateField**：CodeMirror 明令
 * 「Block decorations may not be specified via plugins」，跨行的替换同理。
 * 所以这里跟下面的行内装饰分成两套，别再合回去。
 */
function blockField(wysiwyg: boolean) {
  const build = (state: EditorState): DecorationSet => {
    const ranges: Range<Decoration>[] = [];
    const revealed = revealer(state, wysiwyg);
    syntaxTree(state).iterate({
      enter: node => {
        if (node.name === "FencedCode") {
          // 图只在即时渲染模式下就地画：整行粒度里光标一进块就整块跳回源码，
          // 而一张图通常有好几行，跳来跳去比不画还难用（同表格）。
          if (!wysiwyg || revealed(node.from, node.to) || !wholeLines(state, node.from, node.to)) return false;
          // 用共享的那份识别逻辑，别在这里再写一套围栏解析。
          const block = diagramBlockAt(state.doc.sliceString(node.from, node.to), 0);
          if (block?.source.trim()) {
            ranges.push(Decoration.replace({ widget: new DiagramWidget(block.source), block: true }).range(node.from, node.to));
          }
          return false;
        }
        // 行内内容占了语法树的绝大部分，而块级公式与表格都不会长在段落或代码块里面。
        if (node.name === "Paragraph" || node.name === "CodeBlock") return false;
        if (node.name === "BlockMath") {
          if (revealed(node.from, node.to) || !wholeLines(state, node.from, node.to)) return false;
          const raw = state.doc.sliceString(node.from, node.to).trim();
          // 没闭合就别渲染，不然刚敲下 `$$` 后面半篇文章会突然变成一坨公式。
          if (!raw.endsWith("$$") || raw.length <= 4) return false;
          const body = raw.slice(2, -2).trim();
          if (body) ranges.push(Decoration.replace({ widget: new MathWidget(body, true), block: true }).range(node.from, node.to));
          return false;
        }
        if (node.name === "Table") {
          // 表格只在即时渲染模式下就地渲染：整行粒度里光标一进表格就整块跳回源码，
          // 而表格通常有好几行，跳来跳去比不渲染还难用。
          if (!wysiwyg || revealed(node.from, node.to) || !wholeLines(state, node.from, node.to)) return;
          ranges.push(Decoration.replace({ widget: new TableWidget(state.doc.sliceString(node.from, node.to)), block: true }).range(node.from, node.to));
          return false;
        }
        return;
      },
    });
    return Decoration.set(ranges, true);
  };
  return StateField.define<DecorationSet>({
    create: build,
    update: (value, tr) => (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState)) ? build(tr.state) : value,
    provide: field => [
      EditorView.decorations.from(field),
      EditorView.atomicRanges.of(view => view.state.field(field, false) ?? RangeSet.empty),
    ],
  });
}

function build(view: EditorView, wysiwyg: boolean): Built {
  const marks: Range<Decoration>[] = [];
  // 只有「被替换掉的」区间该是原子的：方向键要能一步跨过藏起来的标记。
  // 样式类的 mark 与整行装饰绝不能进这里，否则那段文字就没法把光标放进去改。
  const atoms: Range<Decoration>[] = [];
  const replace = (deco: Decoration, from: number, to: number) => {
    if (from >= to) return;
    marks.push(deco.range(from, to));
    atoms.push(deco.range(from, to));
  };

  const { state } = view;
  const tree = syntaxTree(state);
  const revealed = revealer(state, wysiwyg);
  /** 标记归属的构件范围：元素粒度下判定要以整个 `**粗体**` 为准，而不是那两个星号。 */
  const owner = (node: SyntaxNodeRef) => {
    const parent = node.node.parent;
    return parent ? { from: parent.from, to: parent.to } : { from: node.from, to: node.to };
  };
  /** 给一个多行块的每一行挂整行装饰，范围裁到可视区，别为屏幕外的几千行做无用功。 */
  const lineDecos = (from: number, to: number, deco: Decoration, limit: { from: number; to: number }) => {
    let pos = Math.max(from, limit.from);
    const end = Math.min(to, limit.to);
    while (pos <= end) {
      const line = state.doc.lineAt(pos);
      marks.push(deco.range(line.from));
      if (line.to >= end) break;
      pos = line.to + 1;
    }
  };

  for (const visible of view.visibleRanges) {
    tree.iterate({
      from: visible.from,
      to: visible.to,
      enter: node => {
        const line = state.doc.lineAt(node.from);

        switch (node.name) {
          case "HeaderMark": {
            const scope = wysiwyg ? owner(node) : { from: line.from, to: line.to };
            if (revealed(scope.from, scope.to)) return;
            // 连同后面的空格一起藏，不然标题会顶着一格缩进。
            let to = node.to;
            while (to < line.to && state.doc.sliceString(to, to + 1) === " ") to++;
            replace(hide, node.from, to);
            return;
          }
          case "EmphasisMark":
          case "StrikethroughMark": {
            const scope = wysiwyg ? owner(node) : { from: line.from, to: line.to };
            if (!revealed(scope.from, scope.to)) replace(hide, node.from, node.to);
            return;
          }
          case "CodeMark": {
            // 只藏行内代码的反引号；围栏代码块的 ``` 留着，不然看不出块边界。
            if (node.node.parent?.name !== "InlineCode") return;
            const scope = wysiwyg ? owner(node) : { from: line.from, to: line.to };
            if (!revealed(scope.from, scope.to)) replace(hide, node.from, node.to);
            return;
          }
          case "QuoteMark":
            // 引用标记一律按行判定：一段长引用不该因为光标在末行就整段露出。
            if (!revealed(line.from, line.to)) replace(hide, node.from, node.to);
            return;
          case "Blockquote":
            lineDecos(node.from, node.to, quoteLine, visible);
            return;
          case "FencedCode":
          case "CodeBlock":
            lineDecos(node.from, node.to, codeLine, visible);
            return;
          case "LinkMark":
          case "URL":
          case "LinkTitle": {
            if (node.node.parent?.name !== "Link") return;
            const scope = wysiwyg ? owner(node) : { from: line.from, to: line.to };
            if (!revealed(scope.from, scope.to)) replace(hide, node.from, node.to);
            return;
          }
          case "Link": {
            const scope = wysiwyg ? { from: node.from, to: node.to } : { from: line.from, to: line.to };
            if (!revealed(scope.from, scope.to)) {
              marks.push(Decoration.mark({ class: "cm-md-link", attributes: { title: "Ctrl/⌘ + 单击打开" } }).range(node.from, node.to));
            }
            return;
          }
          case "Image": {
            if (revealed(node.from, node.to)) return false;
            const parsed = /^!\[([^\]]*)\]\(([^)\s]+)/.exec(state.doc.sliceString(node.from, node.to));
            if (parsed) replace(Decoration.replace({ widget: new ImageWidget(parsed[2], parsed[1]) }), node.from, node.to);
            return false;
          }
          case "WikiLink": {
            if (revealed(node.from, node.to)) return false;
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
          case "InlineMath": {
            if (revealed(node.from, node.to)) return false;
            replace(Decoration.replace({ widget: new MathWidget(state.doc.sliceString(node.from + 1, node.to - 1)) }), node.from, node.to);
            return false;
          }
          // 块级公式与表格在 blockField 里处理：跨行替换不能由 ViewPlugin 提供。
          case "BlockMath":
            return false;
          case "Table":
            // 已经渲成表格小部件的，里面的行内标记不必再装饰；回到源码态时照常往里走。
            return wysiwyg && !revealed(node.from, node.to) ? false : undefined;
          case "TaskMarker": {
            // 复选框一直是复选框（Obsidian、Typora 都这样），光标在这一行也不退回 `[ ]`。
            const checked = state.doc.sliceString(node.from + 1, node.to - 1).trim().toLowerCase() === "x";
            replace(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }), node.from, node.to);
            return false;
          }
          case "ListMark": {
            const mark = state.doc.sliceString(node.from, node.to);
            if (mark !== "-" && mark !== "*" && mark !== "+") return;
            // 即时渲染下圆点一直是圆点；整行粒度下光标进来要能改标记。
            if (!wysiwyg && revealed(line.from, line.to)) return;
            replace(Decoration.replace({ widget: new TextWidget("•", "cm-md-bullet") }), node.from, node.to);
            return;
          }
          case "HorizontalRule":
            if (!revealed(line.from, line.to)) replace(Decoration.replace({ widget: new RuleWidget() }), node.from, node.to);
            return;
          default:
            return;
        }
      },
    });
  }
  return { decorations: Decoration.set(marks, true), atomic: Decoration.set(atoms, true) };
}

function decorator(wysiwyg: boolean) {
  return ViewPlugin.fromClass(
    class {
      built: Built;
      constructor(view: EditorView) { this.built = build(view, wysiwyg); }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.selectionSet
          || syntaxTree(update.startState) !== syntaxTree(update.state)) {
          this.built = build(update.view, wysiwyg);
        }
      }
    },
    {
      decorations: p => p.built.decorations,
      provide: p => EditorView.atomicRanges.of(view => view.plugin(p)?.built.atomic ?? RangeSet.empty),
    },
  );
}

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

export function livePreview(onWiki: ((title: string, section?: string) => void) | undefined, wysiwyg: boolean): Extension {
  return [blockField(wysiwyg), decorator(wysiwyg), followHandler(onWiki)];
}
