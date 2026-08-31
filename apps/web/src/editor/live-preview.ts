import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, RangeSet, StateField } from "@codemirror/state";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import {
  Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType,
} from "@codemirror/view";
import { diagramBlockAt, taskAnchorSuffixStart } from "@kb/shared/markdown";
import { hydrateMath, loadKatex } from "../lib/katex-hydrate";
import { openLightbox } from "../lib/lightbox";
import { renderDiagram } from "../lib/mermaid-hydrate";
import { toSafeHtml } from "../lib/render-html";
import { mountTableEditor } from "./table-edit";
import type { RenderToggles } from "../lib/layout-prefs";

/** 没传开关时一律全开——这个模块被别处直接引用时不该悄悄少渲染点什么。 */
const ALL_ON: RenderToggles = { image: true, math: true, table: true, diagram: true };

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
    // 外面必须套一层固定不动的壳。
    //
    // **小部件的根节点绝对不能被换掉**：CodeMirror 认的就是那个根，把它 replaceWith 掉，
    // DOM 观察器会以为是用户在编辑，转头把新节点的文字**读回文档**——
    // 一张图裂开就能把 `![封面](...)` 原地改成「图片加载失败：封面」。实测过，会真的改。
    // 壳留着、只换壳里面的东西就没事。
    const box = document.createElement("span");
    box.className = "cm-md-image-box";

    const img = document.createElement("img");
    img.className = "cm-md-image";
    // 不加 loading="lazy"：CodeMirror 本来就只渲染视口内的那几行，屏幕外的图根本不在 DOM 里，
    // 再叠一层惰性加载省不下什么，却会让「明明看得见却一直不加载」多出一种可能。
    img.src = this.url;
    img.alt = this.alt;
    img.title = this.alt || this.url;
    // 图挂了别只留一个破图标：换成一块写着 alt 与地址的占位，
    // 至少能一眼看出是哪张图坏了——和坏公式、坏图表一个口径（设计 03 §4.6）。
    img.addEventListener("error", () => {
      const failed = document.createElement("span");
      failed.className = "cm-md-image-error";
      failed.textContent = `图片加载失败：${this.alt || this.url}`;
      failed.title = this.url;
      img.remove();
      box.append(failed);
    }, { once: true });

    // 放大按钮：hover 才出现。不用「点图就放大」——裸单击要留给「把光标放到这儿」，
    // 和双链那条口径一样（§5）。触摸设备没有 hover，所以按钮常驻，靠 CSS 判定。
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
  /** 放大按钮上的事件归自己，其余（点一下把光标放过来）照旧交给 CodeMirror。 */
  ignoreEvent(event: Event) { return !!(event.target as HTMLElement | null)?.closest?.(".cm-md-image-zoom"); }
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

/**
 * 表格：光标不在里面时渲成真表格；单击某格直接在格内改它的 Markdown 内容。
 * 可编辑时再挂上增删行列 / 对齐 / 拖列宽的把手（设计 17 §3.5）。
 */
class TableWidget extends WidgetType {
  // 字段名不能叫 editable：WidgetType 基类上有一个同名的只读访问器，赋值会当场抛异常
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
  /** 单元格和把手自己处理事件，不能让 CodeMirror 把单击映射回整段源码。 */
  ignoreEvent(event: Event) {
    return !!(event.target as HTMLElement | null)?.closest?.("[data-table-cell], [data-table-handle]");
  }
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
/** 块的首尾行单独标一下，圆角与上下留白只画在两头，中间行才连成一整块。 */
const blockFirst = Decoration.line({ class: "cm-md-block-first" });
const blockLast = Decoration.line({ class: "cm-md-block-last" });
/** 标题行。着色由 HighlightStyle 管，这个类只用来给标题上方留白。 */
const headingLine = Decoration.line({ class: "cm-md-heading" });
/** Callout 的整行装饰按类型分色，每种类型缓存一个，别每次构建都造新对象。 */
const calloutLines = new Map<string, Decoration>();
function calloutLine(type: string): Decoration {
  let deco = calloutLines.get(type);
  if (!deco) {
    deco = Decoration.line({ class: `cm-md-quote-line cm-md-callout cm-md-callout-${type}` });
    calloutLines.set(type, deco);
  }
  return deco;
}

/** 认得的 Callout 类型。和 `packages/shared/markdown/callout.ts` 那份必须一致。 */
const CALLOUTS = new Set([
  "note", "tip", "info", "success", "question", "warning", "failure", "danger",
  "bug", "example", "quote", "abstract", "important", "caution",
]);
const CALLOUT_ALIAS: Record<string, string> = {
  hint: "tip", attention: "warning", error: "danger", fail: "failure",
  summary: "abstract", tldr: "abstract", cite: "quote", help: "question", faq: "question",
};

/**
 * 这个 URL 是不是 `](` 后面的目标地址。
 *
 * GFM Autolink 会把标签里的裸地址也收成 `URL`——`[https://example.com](https://example.com)`
 * 于是有两个同名节点。标签里那个是显示文本，藏掉光标一离开链接就什么都不剩。
 * 目标地址紧跟在 `]` `(` 两个 LinkMark 后面（中间空白不成节点）。
 */
function isDestinationUrl(node: SyntaxNode): boolean {
  const prev = node.prevSibling;
  return prev?.name === "LinkMark" && prev.prevSibling?.name === "LinkMark";
}

/**
 * 这个 Link 节点有没有真的地址。
 *
 * lezer 会给任何一段方括号文字发一个 `Link` 节点——`[草稿] 会议纪要`、`> [!NOTE] 小心`
 * 都算。照单藏掉方括号的话，正文里所有「[方括号]开头」的写法都会莫名其妙少一对括号，
 * 而它们既不是链接也点不开。**没目标地址就当普通文字，一个字节都不动。**
 * 标签里被 Autolink 认出来的 URL 不算地址。
 */
function hasUrl(link: SyntaxNode | null): boolean {
  for (let child = link?.firstChild; child; child = child.nextSibling) {
    if (child.name === "URL" && isDestinationUrl(child)) return true;
  }
  return false;
}

/** `> [!NOTE] 标题` 里的类型；不是 callout 回 null。 */
function calloutTypeOf(text: string): string | null {
  const hit = /^\s*>\s*\[!([A-Za-z]+)\][+-]?/.exec(text);
  if (!hit) return null;
  const lower = hit[1].toLowerCase();
  const type = CALLOUT_ALIAS[lower] ?? lower;
  return CALLOUTS.has(type) ? type : null;
}

/** `scopes` 是这一次构建里所有「要不要露出」的判定范围，光标移动时靠它短路重建。 */
type Built = { decorations: DecorationSet; atomic: DecorationSet; scopes: Array<{ from: number; to: number }> };

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
/**
 * 块级装饰的结果。`spans` 是**所有候选块**的范围（不管这一刻渲没渲），
 * 光标动了以后靠它判断「露出关系有没有变」——没变就不重建，见下面 `update`。
 */
type BlockBuilt = { decorations: DecorationSet; spans: Array<{ from: number; to: number }> };

function blockField(wysiwyg: boolean, noteId: string, render: RenderToggles) {
  const build = (state: EditorState): BlockBuilt => {
    const ranges: Range<Decoration>[] = [];
    const spans: Array<{ from: number; to: number }> = [];
    const revealed = revealer(state, wysiwyg);
    syntaxTree(state).iterate({
      enter: node => {
        if (node.name === "FencedCode") {
          // 图只在即时渲染模式下就地画：整行粒度里光标一进块就整块跳回源码，
          // 而一张图通常有好几行，跳来跳去比不画还难用（同表格）。
          if (!render.diagram || !wysiwyg || !wholeLines(state, node.from, node.to)) return false;
          // 用共享的那份识别逻辑，别在这里再写一套围栏解析。
          const block = diagramBlockAt(state.doc.sliceString(node.from, node.to), 0);
          if (!block?.source.trim()) return false;
          spans.push({ from: node.from, to: node.to });
          if (!revealed(node.from, node.to)) {
            ranges.push(Decoration.replace({ widget: new DiagramWidget(block.source), block: true }).range(node.from, node.to));
          }
          return false;
        }
        // 行内内容占了语法树的绝大部分，而块级公式与表格都不会长在段落或代码块里面。
        if (node.name === "Paragraph" || node.name === "CodeBlock") return false;
        if (node.name === "BlockMath") {
          if (!render.math || !wholeLines(state, node.from, node.to)) return false;
          const raw = state.doc.sliceString(node.from, node.to).trim();
          // 没闭合就别渲染，不然刚敲下 `$$` 后面半篇文章会突然变成一坨公式。
          if (!raw.endsWith("$$") || raw.length <= 4) return false;
          const body = raw.slice(2, -2).trim();
          if (!body) return false;
          spans.push({ from: node.from, to: node.to });
          if (!revealed(node.from, node.to)) {
            ranges.push(Decoration.replace({ widget: new MathWidget(body, true), block: true }).range(node.from, node.to));
          }
          return false;
        }
        if (node.name === "Table") {
          // 表格只在即时渲染模式下就地渲染：整行粒度里光标一进表格就整块跳回源码，
          // 而表格通常有好几行，跳来跳去比不渲染还难用。
          if (!render.table || !wysiwyg || !wholeLines(state, node.from, node.to)) return;
          spans.push({ from: node.from, to: node.to });
          if (revealed(node.from, node.to)) return;      // 回源码态，里面的行内标记照常装饰
          ranges.push(Decoration.replace({ widget: new TableWidget(state.doc.sliceString(node.from, node.to), noteId, !state.readOnly), block: true }).range(node.from, node.to));
          return false;
        }
        return;
      },
    });
    return { decorations: Decoration.set(ranges, true), spans };
  };
  return StateField.define<BlockBuilt>({
    create: build,
    update: (value, tr) => {
      if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return build(tr.state);
      if (!tr.selection) return value;
      // 光标动一下就全文重扫一遍语法树太贵了（长笔记里每次方向键都要走一趟）。
      // 块级件就那么几个，先看这次移动有没有真的改变某个块的「露出 / 渲染」状态，没改就复用。
      const before = revealer(tr.startState, wysiwyg);
      const after = revealer(tr.state, wysiwyg);
      const flipped = value.spans.some(span => before(span.from, span.to) !== after(span.from, span.to));
      return flipped ? build(tr.state) : value;
    },
    provide: field => [
      EditorView.decorations.from(field, value => value.decorations),
      EditorView.atomicRanges.of(view => view.state.field(field, false)?.decorations ?? RangeSet.empty),
    ],
  });
}

function build(view: EditorView, wysiwyg: boolean, render: RenderToggles): Built {
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
  const base = revealer(state, wysiwyg);
  /**
   * 每问一次「这段要不要露出」就把范围记下来。光标动一下时拿它短路：
   * 这些范围的露出结果一个都没翻转，装饰就不可能变，直接复用上一次的结果，
   * 不必把可视区的语法树再走一遍。和 `blockField` 那套是同一个思路。
   */
  const scopes: Array<{ from: number; to: number }> = [];
  const seen = new Set<string>();
  const revealed = (from: number, to: number) => {
    const key = `${from}:${to}`;
    if (!seen.has(key)) { seen.add(key); scopes.push({ from, to }); }
    return base(from, to);
  };
  /** 标记归属的构件范围：元素粒度下判定要以整个 `**粗体**` 为准，而不是那两个星号。 */
  const owner = (node: SyntaxNodeRef) => {
    const parent = node.node.parent;
    return parent ? { from: parent.from, to: parent.to } : { from: node.from, to: node.to };
  };
  /**
   * 给一个多行块的每一行挂整行装饰，范围裁到可视区，别为屏幕外的几千行做无用功。
   * 首尾行额外标记——但首尾按**块**算，不按裁剪后的可视范围算，否则滚一下圆角就跑了。
   */
  const lineDecos = (from: number, to: number, deco: Decoration, limit: { from: number; to: number }) => {
    const first = state.doc.lineAt(from).from;
    const last = state.doc.lineAt(to).from;
    let pos = Math.max(from, limit.from);
    const end = Math.min(to, limit.to);
    while (pos <= end) {
      const line = state.doc.lineAt(pos);
      marks.push(deco.range(line.from));
      if (line.from === first) marks.push(blockFirst.range(line.from));
      if (line.from === last) marks.push(blockLast.range(line.from));
      if (line.to >= end) break;
      pos = line.to + 1;
    }
  };

  // 日历同步会给任务行补稳定块锚。它必须留在源码里保证改文案、移动行后仍能关联，
  // 但属于系统元数据：编辑器和预览都不应把它当正文展示。
  const anchoredLines = new Set<number>();
  for (const visible of view.visibleRanges) {
    let pos = state.doc.lineAt(visible.from).from;
    while (pos <= visible.to) {
      const line = state.doc.lineAt(pos);
      if (!anchoredLines.has(line.number) && /^\s*[-*+]\s+\[[ xX]\]/.test(line.text)) {
        const at = taskAnchorSuffixStart(line.text);
        if (at !== null) replace(hide, line.from + at, line.to);
        anchoredLines.add(line.number);
      }
      if (line.to >= visible.to || line.to === state.doc.length) break;
      pos = line.to + 1;
    }
    tree.iterate({
      from: visible.from,
      to: visible.to,
      enter: node => {
        const line = state.doc.lineAt(node.from);

        switch (node.name) {
          case "ATXHeading1": case "ATXHeading2": case "ATXHeading3":
          case "ATXHeading4": case "ATXHeading5": case "ATXHeading6":
          case "SetextHeading1": case "SetextHeading2":
            marks.push(headingLine.range(state.doc.lineAt(node.from).from));
            return;                                     // 继续往里走，标记还要交给 HeaderMark 处理
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
          case "HighlightMark":
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
          case "Highlight":
            // 着色交给 CSS：HighlightStyle 只改得了字色，而高亮要的是底色
            marks.push(Decoration.mark({ class: "cm-md-mark" }).range(node.from, node.to));
            return;
          case "FootnoteRef":
            marks.push(Decoration.mark({ class: "cm-md-footnote" }).range(node.from, node.to));
            return false;
          case "Blockquote": {
            // Callout 就是打了标记的引用块（设计 17 §3.14），整块跟着类型上色
            const type = calloutTypeOf(state.doc.lineAt(node.from).text);
            lineDecos(node.from, node.to, type ? calloutLine(type) : quoteLine, visible);
            return;
          }
          case "FencedCode":
          case "CodeBlock":
            lineDecos(node.from, node.to, codeLine, visible);
            return;
          case "LinkMark":
          case "URL":
          case "LinkTitle": {
            const parent = node.node.parent;
            if (parent?.name !== "Link" || !hasUrl(parent)) return;
            // 标签里的 Autolink 是显示文本，不能跟目标地址一起藏。
            if (node.name === "URL" && !isDestinationUrl(node.node)) return;
            const scope = wysiwyg ? owner(node) : { from: line.from, to: line.to };
            if (!revealed(scope.from, scope.to)) replace(hide, node.from, node.to);
            return;
          }
          case "Link": {
            if (!hasUrl(node.node)) return;
            const scope = wysiwyg ? { from: node.from, to: node.to } : { from: line.from, to: line.to };
            if (!revealed(scope.from, scope.to)) {
              marks.push(Decoration.mark({ class: "cm-md-link", attributes: { title: "Ctrl/⌘ + 单击打开" } }).range(node.from, node.to));
            }
            return;
          }
          case "Image": {
            if (!render.image || revealed(node.from, node.to)) return false;
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
            if (!render.math || revealed(node.from, node.to)) return false;
            replace(Decoration.replace({ widget: new MathWidget(state.doc.sliceString(node.from + 1, node.to - 1)) }), node.from, node.to);
            return false;
          }
          // 块级公式与表格在 blockField 里处理：跨行替换不能由 ViewPlugin 提供。
          case "BlockMath":
            return false;
          case "Table":
            // 已经渲成表格小部件的，里面的行内标记不必再装饰；回到源码态时照常往里走。
            return render.table && wysiwyg && !revealed(node.from, node.to) ? false : undefined;
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
  return { decorations: Decoration.set(marks, true), atomic: Decoration.set(atoms, true), scopes };
}

function decorator(wysiwyg: boolean, render: RenderToggles) {
  return ViewPlugin.fromClass(
    class {
      built: Built;
      constructor(view: EditorView) { this.built = build(view, wysiwyg, render); }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged
          || syntaxTree(update.startState) !== syntaxTree(update.state)) {
          this.built = build(update.view, wysiwyg, render);
          return;
        }
        if (!update.selectionSet) return;
        // 光标动了不等于装饰要变。先按上一次记下的判定范围比一遍，
        // 一个都没翻转就复用——方向键在长文里连按时，这一条省掉的是绝大多数重建。
        const before = revealer(update.startState, wysiwyg);
        const after = revealer(update.state, wysiwyg);
        if (this.built.scopes.some(scope => before(scope.from, scope.to) !== after(scope.from, scope.to))) {
          this.built = build(update.view, wysiwyg, render);
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
export function wikiAt(state: EditorState, from: number) {
  const text = state.doc.sliceString(from, Math.min(from + 512, state.doc.length));
  const hit = /^!?\[\[([^\]\n]+)\]\]/.exec(text);
  if (!hit) return null;
  const [left, alias] = hit[1].split("|");
  const [title, section] = left.split("#");
  return { title: title.trim() || (alias ?? "").trim(), section: section?.trim() || undefined };
}

/** 最近一次指针按下的种类。触摸屏上没有 Ctrl/⌘ 可按，只能靠它区分。 */
let lastPointer: string = "mouse";

/** 触摸设备：手指与手写笔算，外接鼠标不算。粗指针的媒体查询兜底（模拟器里 pointerType 可能缺）。 */
function coarsePointer(): boolean {
  if (lastPointer === "touch" || lastPointer === "pen") return true;
  if (lastPointer === "mouse") return false;
  return typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
}

/**
 * 跟随链接：桌面是 `Ctrl/⌘ + 单击`——裸单击要留给「点一下改字」这个更常用的动作，
 * 想读的时候右边有预览栏。
 *
 * **触摸设备直接单击跟随**：手机上根本按不出 Ctrl/⌘，也没有并排的预览栏，
 * 不放开这一条，编辑态里的双链就等于死链。想改链接文字的，点它前后一格再拖光标进去。
 */
function followHandler(onWiki?: (title: string, section?: string) => void): Extension {
  return EditorView.domEventHandlers({
    pointerdown(event) {
      lastPointer = event.pointerType || "mouse";
      return false;
    },
    mousedown(event, view) {
      if (event.button !== 0) return false;
      if (!(event.ctrlKey || event.metaKey) && !coarsePointer()) return false;
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

export function livePreview(
  onWiki: ((title: string, section?: string) => void) | undefined,
  wysiwyg: boolean,
  noteId = "",
  render: RenderToggles = ALL_ON,
): Extension {
  return [blockField(wysiwyg, noteId, render), decorator(wysiwyg, render), followHandler(onWiki)];
}
