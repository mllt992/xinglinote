import type { MarkdownIt, Token } from "markdown-it";

export type OutlineItem = { level: number; text: string; slug: string; line: number };

/** 锚点 slug：保留中日韩与字母数字，其余折成连字符。同名标题按出现顺序加序号。 */
export function slugifyHeading(text: string): string {
  const base = text
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\-_]/gu, "");
  return base || "section";
}

/** 标题里的可见文字：吃掉行内标记，双链取别名或标题。 */
export function headingText(inline: Token | undefined): string {
  if (!inline) return "";
  if (!inline.children?.length) return inline.content;
  let out = "";
  for (const child of inline.children) {
    if (child.type === "text" || child.type === "code_inline") out += child.content;
    else if (child.type === "wikilink") {
      const ref = child.meta as { title: string; alias?: string } | undefined;
      out += ref?.alias ?? ref?.title ?? "";
    } else if (child.type === "softbreak" || child.type === "hardbreak") out += " ";
  }
  return out.trim();
}

/** 给 h1–h6 补 id，`[[标题#节]]` 与目录面板都靠它跳转。 */
export function headingAnchorPlugin(md: MarkdownIt) {
  md.core.ruler.push("heading_anchor", state => {
    const seen = new Map<string, number>();
    for (let i = 0; i < state.tokens.length; i++) {
      const token = state.tokens[i];
      if (token.type !== "heading_open") continue;
      const slug = slugifyHeading(headingText(state.tokens[i + 1]));
      const nth = (seen.get(slug) ?? 0) + 1;
      seen.set(slug, nth);
      token.attrSet("id", nth === 1 ? slug : `${slug}-${nth}`);
    }
  });
}

/** 从已解析的 token 流抽目录，供大纲面板与滚动同步使用。 */
export function outlineFromTokens(tokens: Token[]): OutlineItem[] {
  const out: OutlineItem[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== "heading_open") continue;
    const text = headingText(tokens[i + 1]);
    const slug = slugifyHeading(text);
    const nth = (seen.get(slug) ?? 0) + 1;
    seen.set(slug, nth);
    out.push({ level: Number(token.tag.slice(1)), text, slug: nth === 1 ? slug : `${slug}-${nth}`, line: token.map?.[0] ?? 0 });
  }
  return out;
}
