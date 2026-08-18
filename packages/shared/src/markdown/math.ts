import type { MarkdownIt, StateBlock, StateInline } from "markdown-it";

const isSpace = (code: number) => code === 0x20 || code === 0x09 || code === 0x0a;
const isDigit = (code: number) => code >= 0x30 && code <= 0x39;

/**
 * 公式只渲染成占位元素，真正排版交给宿主在客户端补（`hydrateMath`）。
 *
 * 这么做是为了让 KaTeX 能按需加载：它压缩后仍有几百 KB，而大多数笔记里一条公式都没有。
 * 占位元素里先放原始源码，没加载完（或加载失败）时看到的是 `$E=mc^2$`，不是一片空白。
 */
function placeholder(source: string, display: boolean, escapeHtml: (s: string) => string): string {
  const raw = display ? `$$${source}$$` : `$${source}$`;
  const attrs = `class="math math-${display ? "block" : "inline"}" data-math="${escapeHtml(source)}"${display ? ' data-math-display="1"' : ""}`;
  return display ? `<div ${attrs}>${escapeHtml(raw)}</div>\n` : `<span ${attrs}>${escapeHtml(raw)}</span>`;
}

/** `$...$`。左界符后不能跟空白，右界符前不能是空白、后不能是数字，避免把「$5 到 $8」吃成公式。 */
function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x24 /* $ */) return false;
  if (isSpace(src.charCodeAt(start + 1)) || src.charCodeAt(start + 1) === 0x24) return false;
  let pos = start + 1;
  while (pos < state.posMax) {
    const code = src.charCodeAt(pos);
    if (code === 0x5c /* \ */) { pos += 2; continue; }
    if (code === 0x0a) return false;
    if (code === 0x24) break;
    pos++;
  }
  if (pos >= state.posMax || src.charCodeAt(pos) !== 0x24) return false;
  if (isSpace(src.charCodeAt(pos - 1))) return false;
  if (isDigit(src.charCodeAt(pos + 1))) return false;
  if (!silent) {
    const token = state.push("math_inline", "", 0);
    token.content = src.slice(start + 1, pos);
  }
  state.pos = pos + 1;
  return true;
}

/** `$$ … $$`，可同行闭合也可跨行。 */
function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const open = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (open + 2 > max || state.src.slice(open, open + 2) !== "$$") return false;

  const firstLine = state.src.slice(open + 2, max);
  let lastLine = startLine;
  let body = "";
  if (firstLine.trim().endsWith("$$")) {
    body = firstLine.trim().slice(0, -2);
  } else {
    let line = startLine;
    const chunks: string[] = firstLine ? [firstLine] : [];
    for (;;) {
      line++;
      if (line >= endLine) return false;
      const from = state.bMarks[line] + state.tShift[line];
      const to = state.eMarks[line];
      const text = state.src.slice(from, to);
      if (text.trim() === "$$") break;
      chunks.push(text);
    }
    lastLine = line;
    body = chunks.join("\n");
  }
  if (silent) return true;
  state.line = lastLine + 1;
  const token = state.push("math_block", "", 0);
  token.content = body.trim();
  token.map = [startLine, state.line];
  token.block = true;
  return true;
}

export function mathPlugin(md: MarkdownIt) {
  md.inline.ruler.before("escape", "math_inline", mathInline);
  md.block.ruler.before("fence", "math_block", mathBlock, { alt: ["paragraph", "reference", "blockquote", "list"] });
  md.renderer.rules.math_inline = (tokens, idx) => placeholder(tokens[idx].content, false, md.utils.escapeHtml);
  md.renderer.rules.math_block = (tokens, idx) => placeholder(tokens[idx].content, true, md.utils.escapeHtml);
}
