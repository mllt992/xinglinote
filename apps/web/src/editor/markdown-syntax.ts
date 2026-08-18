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

export const markdownSyntaxExtensions = [WikiLink, InlineMath, BlockMath];
