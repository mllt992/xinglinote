import MarkdownIt from "markdown-it";
import { diagramPlugin } from "./diagram.js";
import { headingAnchorPlugin, outlineFromTokens, type OutlineItem } from "./headings.js";
import { mathPlugin } from "./math.js";
import { sourceLinePlugin } from "./source-lines.js";
import { taskListPlugin } from "./tasklist.js";
import { wikilinkPlugin, type WikiResolver } from "./wikilink.js";

export type { DiagramBlock } from "./diagram.js";
export type { OutlineItem } from "./headings.js";
export type { WikiRef, WikiResolution, WikiResolver } from "./wikilink.js";
export { diagramBlockAt, diagramFence } from "./diagram.js";
export { slugifyHeading } from "./headings.js";
export { toggleTaskAt } from "./tasklist.js";
export { parseWikiRef } from "./wikilink.js";

/** 库内（登录后）与公开页（文档站 / 分享 / 广场）的双链规则不同，其余完全一致。 */
export type RenderMode = "library" | "public";

export type MarkdownEnv = {
  mode?: RenderMode;
  /** 把一条双链解析成地址。返回 undefined = 宿主自己接管点击。 */
  resolveWiki?: WikiResolver;
  /** 复选框是否可点。只读视图传 false。 */
  interactiveTasks?: boolean;
  /** 给块级元素打 `data-line`，供源码⇄预览滚动同步对齐。只在 App 编辑器里开。 */
  sourceLines?: boolean;
};

/**
 * 全站唯一的 Markdown 解析器（架构 05 §5）。App 预览、文档站、分享页、广场帖、MCP 返回
 * 必须都走这里，禁止任何地方再 new 一个 markdown-it，否则 wikilink 行为会漂。
 *
 * 语法闭集见规格 §9.2：CommonMark + GFM（表格 / 删除线 / 任务列表）+ `$公式$` + `[[双链]]`
 * + ```` ```mermaid ```` 图块。
 * `html: false` —— 用户 HTML 一律不解析。
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false })
  .use(wikilinkPlugin)
  .use(mathPlugin)
  .use(taskListPlugin)
  .use(diagramPlugin)
  .use(headingAnchorPlugin)
  .use(sourceLinePlugin);

/** 外链一律新窗口打开并断掉 opener。站内相对链接不动。 */
const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = String(tokens[idx].attrGet("href") ?? "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("/")) {
    tokens[idx].attrSet("target", "_blank");
    tokens[idx].attrSet("rel", "noreferrer noopener");
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/**
 * 表格套一层横向滚动容器。
 *
 * 别改成给 `<table>` 自己加 `display: block; overflow-x: auto`——那样表格不再是表格盒，
 * 列宽会被容器压扁，中文表头会被挤成一列一个字。容器负责滚动，表格负责自己的列宽。
 */
md.renderer.rules.table_open = (tokens, idx, options, _env, self) =>
  `<div class="table-scroll">${self.renderToken(tokens, idx, options)}`;
md.renderer.rules.table_close = (tokens, idx, options, _env, self) =>
  `${self.renderToken(tokens, idx, options)}</div>`;

/** 渲染成 HTML。注意：**调用方仍须自行 sanitize**（浏览器端用 DOMPurify）。 */
export function renderMarkdown(source: string, env: MarkdownEnv = {}): string {
  return md.render(source ?? "", { mode: "library", ...env });
}

/** 抽目录树，供大纲面板、`[[标题#节]]` 跳转与滚动同步使用。 */
export function outlineOf(source: string): OutlineItem[] {
  return outlineFromTokens(md.parse(source ?? "", {}));
}

/** 中日韩表意文字与假名。这些按「字」算，其余按「词」算。 */
const CJK = /[㐀-鿿豈-﫿぀-ヿ]/gu;

/** 字数：中日韩按字算，拉丁按词算。标记符号不计入（先过 `plainTextOf`）。 */
export function countWords(source: string): number {
  const plain = plainTextOf(source);
  const cjk = plain.match(CJK)?.length ?? 0;
  const latin = plain.replace(CJK, " ").match(/[\p{L}\p{N}'’-]+/gu)?.length ?? 0;
  return cjk + latin;
}

/** 纯文本摘要：搜索片段、动态预览、分享卡片用，避免把标记符号也算进字数。 */
export function plainTextOf(source: string): string {
  return (source ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_a, title: string, alias?: string) => alias || title)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
