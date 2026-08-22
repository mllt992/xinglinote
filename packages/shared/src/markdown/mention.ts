import type { MarkdownIt, StateInline } from "markdown-it";

/** 与 `mentions.ts` 的 HANDLE / 边界同一套，避免邮箱和路径里的 @ 被吃掉。 */
const HANDLE = /^[a-zA-Z][a-zA-Z0-9_]{2,31}/;
const BOUNDARY = /[\s([（「『"'“‘]/;

/**
 * `@handle`。只在 env.mentionHandles 里出现的才标成 mention——笔记正文默认不走这套，
 * 广场 / 圈子动态才传入智能体 handle 列表。
 */
function tokenize(state: StateInline, silent: boolean): boolean {
  const handles = (state.env as { mentionHandles?: Set<string> } | undefined)?.mentionHandles;
  if (!handles?.size) return false;

  const src = state.src;
  const pos = state.pos;
  if (pos >= state.posMax || src.charCodeAt(pos) !== 0x40) return false;
  if (pos > 0 && !BOUNDARY.test(src[pos - 1]!)) return false;

  const m = HANDLE.exec(src.slice(pos + 1, state.posMax));
  if (!m) return false;
  const end = pos + 1 + m[0].length;
  if (end < state.posMax && /[a-zA-Z0-9_]/.test(src[end]!)) return false;
  if (!handles.has(m[0].toLowerCase())) return false;

  if (!silent) {
    const open = state.push("mention_open", "span", 1);
    open.attrSet("class", "mention");
    const text = state.push("text", "", 0);
    text.content = `@${m[0]}`;
    state.push("mention_close", "span", -1);
  }
  state.pos = end;
  return true;
}

export function mentionPlugin(md: MarkdownIt) {
  md.inline.ruler.before("emphasis", "mention", tokenize);
}
