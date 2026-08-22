import type { MarkdownIt, StateInline } from "markdown-it";
import { isHashtag, normalizeHashtag } from "../hashtags.js";

const TAG = /^[\p{L}\p{N}_]{1,32}/u;
const BOUNDARY = /[\s([（「『"'“‘]/;

/**
 * `#标签`。只在 env.hashtags 打开时才标——笔记正文里的井号仍是标题或普通字。
 */
function tokenize(state: StateInline, silent: boolean): boolean {
  if (!(state.env as { hashtags?: boolean } | undefined)?.hashtags) return false;

  const src = state.src;
  const pos = state.pos;
  if (pos >= state.posMax || src.charCodeAt(pos) !== 0x23) return false;
  if (pos > 0 && !BOUNDARY.test(src[pos - 1]!)) return false;

  const m = TAG.exec(src.slice(pos + 1, state.posMax));
  if (!m) return false;
  let end = pos + 1 + m[0].length;
  if (end < state.posMax && src[end] === "#") end += 1;
  const tag = normalizeHashtag(m[0]);
  if (!isHashtag(tag)) return false;

  if (!silent) {
    const open = state.push("hashtag_open", "a", 1);
    open.attrSet("class", "hashtag");
    open.attrSet("href", `?tag=${encodeURIComponent(tag)}`);
    open.attrSet("data-hashtag", tag);
    const text = state.push("text", "", 0);
    text.content = `#${m[0]}`;
    state.push("hashtag_close", "a", -1);
  }
  state.pos = end;
  return true;
}

export function hashtagPlugin(md: MarkdownIt) {
  md.inline.ruler.before("emphasis", "hashtag", tokenize);
}
