import type { MarkdownIt } from "markdown-it";

/**
 * 给块级元素打上 `data-line`（0 基，指向源码行号），源码⇄预览滚动同步靠它对齐。
 * 只在 `env.sourceLines` 打开时加，公开页与 MCP 返回的 HTML 保持干净。
 */
export function sourceLinePlugin(md: MarkdownIt) {
  md.core.ruler.push("source_line", state => {
    if ((state.env as { sourceLines?: boolean } | undefined)?.sourceLines !== true) return;
    for (const token of state.tokens) {
      if (!token.block || !token.map || token.nesting === -1 || token.hidden) continue;
      token.attrSet("data-line", String(token.map[0]));
    }
  });
}
