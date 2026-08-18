import type { MarkdownIt, StateInline } from "markdown-it";

/** 一条双链引用。源码里始终写标题，库内再绑 ID（规格 §9.4）。 */
export type WikiRef = { title: string; section?: string; alias?: string; embed: boolean };

/** 宿主对一条双链的解析结果。给不出 href 的按「存在但不可见」渲染成纯文本。 */
export type WikiResolution = { href?: string; missing?: boolean; label?: string };

export type WikiResolver = (ref: WikiRef) => WikiResolution | undefined;

/** `[[标题#节|别名]]` / `![[嵌入]]`。内层不允许再出现 `[`，避免和普通链接抢。 */
export function parseWikiRef(inner: string, embed: boolean): WikiRef | null {
  const pipe = inner.indexOf("|");
  const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : undefined;
  const left = pipe >= 0 ? inner.slice(0, pipe) : inner;
  const hash = left.indexOf("#");
  const title = (hash >= 0 ? left.slice(0, hash) : left).trim();
  const section = hash >= 0 ? left.slice(hash + 1).trim() : undefined;
  if (!title) return null;
  return { title, section: section || undefined, alias: alias || undefined, embed };
}

function tokenize(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  let pos = state.pos;
  const embed = src.charCodeAt(pos) === 0x21; /* ! */
  if (embed) pos++;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
  const close = src.indexOf("]]", pos + 2);
  if (close < 0 || close > state.posMax) return false;
  const inner = src.slice(pos + 2, close);
  if (!inner.trim() || inner.includes("[") || inner.includes("]") || inner.includes("\n")) return false;
  const ref = parseWikiRef(inner, embed);
  if (!ref) return false;
  if (!silent) {
    const token = state.push("wikilink", "", 0);
    token.meta = ref;
    token.content = src.slice(state.pos, close + 2);
  }
  state.pos = close + 2;
  return true;
}

/** 双链插件。代码块与行内代码由更早的规则吃掉，所以里面的 `[[` 不会被当链接（设计 03 §4.1）。 */
export function wikilinkPlugin(md: MarkdownIt) {
  md.inline.ruler.before("link", "wikilink", tokenize);
  md.renderer.rules.wikilink = (tokens, idx, _options, env) => {
    const ref = tokens[idx].meta as WikiRef;
    const scope = env as { resolveWiki?: WikiResolver; mode?: "library" | "public" } | undefined;
    const hit = scope?.resolveWiki?.(ref);
    const esc = md.utils.escapeHtml;
    const label = esc(hit?.label ?? ref.alias ?? (ref.section ? `${ref.title} › ${ref.section}` : ref.title));
    const body = ref.embed ? `↳ ${label}` : label;
    const cls = ["wiki", ref.embed ? "embed" : "", hit?.missing ? "missing" : ""].filter(Boolean).join(" ");
    const data = [
      `data-wiki="${esc(encodeURIComponent(ref.title))}"`,
      ref.section ? `data-wiki-section="${esc(encodeURIComponent(ref.section))}"` : "",
      ref.embed ? `data-wiki-embed="1"` : "",
    ].filter(Boolean).join(" ");
    if (hit?.href) return `<a class="${cls}" href="${esc(hit.href)}" ${data}>${body}</a>`;
    // 库内一律可点：没解析出来的点了去消歧，还没建的点了就地新建（规格 §9.4）。
    // 公开页给不出地址就只能是纯文本，「存在但不可见」不许泄露成可点入口（规格 §9.5）。
    if (scope?.mode === "public") return `<span class="${cls} plain" ${data}>${body}</span>`;
    return `<span class="${cls}" role="link" tabindex="0" ${data}>${body}</span>`;
  };
}
