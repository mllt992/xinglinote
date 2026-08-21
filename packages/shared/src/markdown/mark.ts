import type { MarkdownIt, StateInline } from "markdown-it";

const MARKER = 0x3d; /* = */

/**
 * `==高亮==`。
 *
 * 结构照抄 markdown-it 自带的删除线：走**定界符**那一套而不是自己扫一遍，
 * 这样 `==**粗的高亮**==` 这种嵌套才会正常解析，配对规则也和 `~~` 完全一致。
 *
 * 注意这是 Obsidian 的私有语法，不在 CommonMark / GFM 里；导到别的工具会显示成字面量
 * `==`。闭集里收它是因为它在中文笔记里太常用（规格 §9.2 有注明这条局限）。
 */
function tokenize(state: StateInline, silent: boolean): boolean {
  if (silent) return false;
  const start = state.pos;
  if (state.src.charCodeAt(start) !== MARKER) return false;

  const scanned = state.scanDelims(state.pos, true);
  let len = scanned.length;
  if (len < 2) return false;

  // 奇数个 `=` 里落单的那一个当普通文字，剩下的成对入队
  if (len % 2) {
    const token = state.push("text", "", 0);
    token.content = "=";
    len--;
  }
  for (let i = 0; i < len; i += 2) {
    const token = state.push("text", "", 0);
    token.content = "==";
    state.delimiters.push({
      marker: MARKER,
      length: 0,
      token: state.tokens.length - 1,
      end: -1,
      open: scanned.can_open,
      close: scanned.can_close,
    });
  }
  state.pos += scanned.length;
  return true;
}

type Delimiter = { marker: number; end: number; token: number };

function pair(state: StateInline, delimiters: Delimiter[]) {
  const lone: number[] = [];
  for (const startDelim of delimiters) {
    if (startDelim.marker !== MARKER || startDelim.end === -1) continue;
    const endDelim = delimiters[startDelim.end];

    let token = state.tokens[startDelim.token];
    token.type = "mark_open";
    token.tag = "mark";
    token.nesting = 1;
    token.markup = "==";
    token.content = "";

    token = state.tokens[endDelim.token];
    token.type = "mark_close";
    token.tag = "mark";
    token.nesting = -1;
    token.markup = "==";
    token.content = "";

    const before = state.tokens[endDelim.token - 1];
    if (before?.type === "text" && before.content === "=") lone.push(endDelim.token - 1);
  }
  // 落单的 `=` 要挪到闭合标记后面去，不然它会被关在 <mark> 里
  while (lone.length) {
    const i = lone.pop()!;
    let j = i + 1;
    while (j < state.tokens.length && state.tokens[j].type === "mark_close") j++;
    j--;
    if (i !== j) {
      const token = state.tokens[j];
      state.tokens[j] = state.tokens[i];
      state.tokens[i] = token;
    }
  }
}

function postProcess(state: StateInline): boolean {
  pair(state, state.delimiters as unknown as Delimiter[]);
  for (const meta of state.tokens_meta ?? []) {
    if (meta?.delimiters) pair(state, meta.delimiters as unknown as Delimiter[]);
  }
  return true;
}

export function markPlugin(md: MarkdownIt) {
  md.inline.ruler.before("emphasis", "mark", tokenize);
  md.inline.ruler2.before("emphasis", "mark", postProcess);
}
