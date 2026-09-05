import type MarkdownIt from "markdown-it";

/**
 * 即便 `html: false`，也认字面量 `<br>` / `<br/>` / `<br />` 为硬换行。
 *
 * 用途只有一个：GFM 表格单元格不能真换行，编辑器把单元格里的换行序列化成 `<br>`
 *（Obsidian / Typora 同口径）。别处用户写的 HTML 仍然不解析——只有这一种标签。
 */
export function breakTagPlugin(md: MarkdownIt) {
  md.inline.ruler.before("html_inline", "break_tag", (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x3c /* < */) return false;
    const match = /^<br\s*\/?>/i.exec(state.src.slice(state.pos));
    if (!match) return false;
    if (!silent) state.push("hardbreak", "br", 0);
    state.pos += match[0].length;
    return true;
  });
}
