import type { BlockContext, InlineContext, Line, MarkdownConfig } from "@lezer/markdown";
import { tags } from "@lezer/highlight";

const DOLLAR = 36, BANG = 33, BRACKET = 91, BACKSLASH = 92, NEWLINE = 10;
const isSpace = (code: number) => code === 32 || code === 9 || code === NEWLINE;
const isDigit = (code: number) => code >= 48 && code <= 57;

/**
 * 让 CodeMirror 认识 `[[双链]]` 与 `![[嵌入]]`。
 *
 * 语法必须和 `packages/shared/markdown` 里的 markdown-it 规则一致：内层不许再出现方括号、
 * 不许跨行。两边对不上会出现「编辑器画成链接、预览里却是普通文本」这类幻觉。
 */
export const WikiLink: MarkdownConfig = {
  defineNodes: [
    { name: "WikiLink", style: tags.link },
    { name: "WikiMark", style: tags.processingInstruction },
  ],
  parseInline: [{
    name: "WikiLink",
    before: "Link",
    parse(cx: InlineContext, next: number, pos: number) {
      const embed = next === BANG;
      const open = embed ? pos + 1 : pos;
      if (cx.char(open) !== BRACKET || cx.char(open + 1) !== BRACKET) return -1;
      // 只往后看有限的一段：一行里如果有很多 `[`，逐个全文扫会退化成平方复杂度。
      const rest = cx.slice(open + 2, Math.min(cx.end, open + 2 + 512));
      const close = rest.indexOf("]]");
      if (close < 0) return -1;
      const inner = rest.slice(0, close);
      if (!inner.trim() || inner.includes("[") || inner.includes("]") || inner.includes("\n")) return -1;
      const end = open + 2 + close + 2;
      return cx.addElement(cx.elt("WikiLink", pos, end, [
        cx.elt("WikiMark", pos, open + 2),
        cx.elt("WikiMark", end - 2, end),
      ]));
    },
  }],
};

/**
 * `$行内公式$`。判定与 markdown-it 那边同款：左界符后不能跟空白，右界符前不能是空白、
 * 后不能是数字，免得把「$5 到 $8」当成公式。
 */
export const InlineMath: MarkdownConfig = {
  defineNodes: [
    { name: "InlineMath", style: tags.special(tags.monospace) },
    { name: "MathMark", style: tags.processingInstruction },
  ],
  parseInline: [{
    name: "InlineMath",
    before: "Escape",
    parse(cx: InlineContext, next: number, pos: number) {
      if (next !== DOLLAR) return -1;
      const after = cx.char(pos + 1);
      if (isSpace(after) || after === DOLLAR || after < 0) return -1;
      let scan = pos + 1;
      while (scan < cx.end) {
        const code = cx.char(scan);
        if (code === BACKSLASH) { scan += 2; continue; }
        if (code === NEWLINE) return -1;
        if (code === DOLLAR) break;
        scan++;
      }
      if (scan >= cx.end || cx.char(scan) !== DOLLAR) return -1;
      if (isSpace(cx.char(scan - 1))) return -1;
      if (isDigit(cx.char(scan + 1))) return -1;
      const end = scan + 1;
      return cx.addElement(cx.elt("InlineMath", pos, end, [
        cx.elt("MathMark", pos, pos + 1),
        cx.elt("MathMark", scan, end),
      ]));
    },
  }],
};

/**
 * `$$ 块级公式 $$`。同行闭合与跨行都认。
 *
 * 没写闭合的按围栏代码块的老规矩一路吃到文末——这是 Markdown 的通行做法，
 * 但装饰层会检查节点有没有真的闭合，没闭合就只显示源码，免得刚敲下 `$$`
 * 半篇文章突然变成一坨公式。
 */
export const BlockMath: MarkdownConfig = {
  defineNodes: [{ name: "BlockMath", block: true, style: tags.special(tags.monospace) }],
  parseBlock: [{
    name: "BlockMath",
    before: "FencedCode",
    parse(cx: BlockContext, line: Line) {
      if (line.text.slice(line.pos, line.pos + 2) !== "$$") return false;
      const from = cx.lineStart + line.pos;
      const head = line.text.slice(line.pos + 2).trim();
      if (head.endsWith("$$") && head.length > 2) {
        const to = cx.lineStart + line.text.length;
        cx.addElement(cx.elt("BlockMath", from, to));
        cx.nextLine();
        return true;
      }
      let to = cx.lineStart + line.text.length;
      while (cx.nextLine()) {
        to = cx.lineStart + line.text.length;
        if (line.text.slice(line.pos).trim() === "$$") { cx.nextLine(); break; }
      }
      cx.addElement(cx.elt("BlockMath", from, to));
      return true;
    },
  }],
};

const EQUALS = 61, CARET = 94;

const PUNCTUATION = /[!-/:-@[-`{-~¡«»¿‐-‧、-〃《-】！-／：-＠]/;
const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };

/**
 * `==高亮==`。
 *
 * 走**定界符**（`addDelimiter`）而不是自己扫一段 `addElement`：后者的内容不会再被解析，
 * `==**粗的高亮**==` 里的星号就成了字面量，和预览侧对不上。配对与前后空白的判定
 * 照抄 @lezer/markdown 自带的删除线，两种标记的手感因此完全一致。
 */
export const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight", style: { "Highlight/...": tags.special(tags.emphasis) } },
    { name: "HighlightMark", style: tags.processingInstruction },
  ],
  parseInline: [{
    name: "Highlight",
    after: "Emphasis",
    parse(cx: InlineContext, next: number, pos: number) {
      if (next !== EQUALS || cx.char(pos + 1) !== EQUALS || cx.char(pos + 2) === EQUALS) return -1;
      const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
      const spaceBefore = /\s|^$/.test(before), spaceAfter = /\s|^$/.test(after);
      const punctBefore = PUNCTUATION.test(before), punctAfter = PUNCTUATION.test(after);
      return cx.addDelimiter(
        HighlightDelim, pos, pos + 2,
        !spaceAfter && (!punctAfter || spaceBefore || punctBefore),
        !spaceBefore && (!punctBefore || spaceAfter || punctAfter),
      );
    },
  }],
};

/**
 * 脚注引用 `[^标签]`。只认引用，不认定义行——定义行 `[^标签]: …` 在编辑器里就是普通文字，
 * 那样反而清楚：它本来就该被人看见和编辑。
 */
export const FootnoteRef: MarkdownConfig = {
  defineNodes: [{ name: "FootnoteRef", style: tags.special(tags.link) }],
  parseInline: [{
    name: "FootnoteRef",
    before: "Link",
    parse(cx: InlineContext, next: number, pos: number) {
      if (next !== BRACKET || cx.char(pos + 1) !== CARET) return -1;
      const rest = cx.slice(pos + 2, Math.min(cx.end, pos + 2 + 128));
      const close = rest.indexOf("]");
      if (close <= 0) return -1;
      const label = rest.slice(0, close);
      if (!label.trim() || /[\s\]]/.test(label)) return -1;
      const end = pos + 2 + close + 1;
      // `[^1]:` 是定义不是引用
      if (cx.char(end) === 58 /* : */) return -1;
      return cx.addElement(cx.elt("FootnoteRef", pos, end));
    },
  }],
};

export const markdownSyntaxExtensions = [WikiLink, InlineMath, BlockMath, Highlight, FootnoteRef];
