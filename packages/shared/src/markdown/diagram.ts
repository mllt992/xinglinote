import type { MarkdownIt } from "markdown-it";

/** 目前只认 mermaid 一种。以后要加别的图，往这里加语言名即可。 */
const LANGS = new Set(["mermaid"]);

/** fence 的 info 串取第一个词：` ```mermaid ` 与 ` ``` mermaid  title ` 都算。 */
function language(info: string): string {
  return (info.trim().split(/\s+/)[0] ?? "").toLowerCase();
}

/**
 * ` ```mermaid ` 只渲染成占位元素，画图交给宿主在客户端补（`hydrateDiagrams`）。
 *
 * 和公式同一个套路（见 `math.ts`）：mermaid 压缩后比 KaTeX 还大，而绝大多数笔记里
 * 一张图都没有，所以解析阶段一个字节都不下载。占位元素里先摆原始源码——没加载完、
 * 加载失败、或者图本身写错了，看到的都是那段 mermaid 源码，不是一片空白。
 *
 * 注意：源码留在 fence 里原样不动，导出回 Obsidian 还是同一段 ` ```mermaid `（规格 §9.4）。
 */
export function diagramPlugin(md: MarkdownIt) {
  const fallback = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const lang = language(token.info);
    const source = token.content.replace(/\n+$/, "");
    // 空的图块按普通代码块走：刚敲完 ```mermaid 还没写内容时不该冒出一个报错框。
    if (!LANGS.has(lang) || !source.trim()) {
      return fallback
        ? fallback(tokens, idx, options, env, self)
        : self.renderToken(tokens, idx, options);
    }
    // 行号（`sourceLines`）由 source_line 规则提前打在 token 上，这里连同一起吐出去。
    token.attrSet("class", `diagram diagram-${lang}`);
    token.attrSet("data-diagram", lang);
    token.attrSet("data-diagram-src", source);
    return `<div${self.renderAttrs(token)}><pre class="diagram-source">${md.utils.escapeHtml(source)}</pre></div>\n`;
  };
}

export type DiagramBlock = {
  /** 整块（含前后围栏行）在源码里的字符区间，可直接拿去替换。 */
  from: number;
  to: number;
  /** 围栏之间的正文，不含围栏行本身。 */
  source: string;
  lang: string;
};

const FENCE_OPEN = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/;

/**
 * 找出 `offset` 落在哪个图块里（围栏行上也算）。AI 改图靠它认出「当前这张图」，
 * 替换时也靠它给出精确区间——除了这一块，正文一个字节都不动。
 */
export function diagramBlockAt(text: string, offset: number): DiagramBlock | null {
  const lines = (text ?? "").split("\n");
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const start = pos;
    pos += lines[i].length + 1;
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) continue;
    const [, indent, marker, info] = open;
    const lang = info.toLowerCase();

    // 找配对的收尾围栏：同种符号、不短于开头、后面不带 info。没找到就算开到文末。
    const closer = new RegExp(`^\\s{0,3}\\${marker[0]}{${marker.length},}\\s*$`);
    let end = lines.length;
    let scan = pos;
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      scan += lines[j].length + 1;
      if (closer.test(lines[j])) { end = j; close = scan - 1; break; }
    }
    const to = close >= 0 ? close : text.length;
    if (LANGS.has(lang) && offset >= start && offset <= to) {
      const body = lines.slice(i + 1, end).map(l => (l.startsWith(indent) ? l.slice(indent.length) : l));
      return { from: start, to, lang, source: body.join("\n") };
    }
    // 不是我们要的块也得跳过去，免得把代码块里的 ``` 当成新块的开头。
    i = end;
    pos = close >= 0 ? close + 1 : text.length;
  }
  return null;
}

/** 把一段 mermaid 源码包成可以直接落进正文的代码块。 */
export function diagramFence(source: string, lang = "mermaid"): string {
  return `\`\`\`${lang}\n${source.trim()}\n\`\`\``;
}
