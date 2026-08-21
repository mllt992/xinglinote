import type { MarkdownIt, Token } from "markdown-it";

/**
 * Callout：`> [!NOTE] 可选标题` 打头的引用块。
 *
 * 语法取 GitHub 的 alert 写法，类型集合取 Obsidian 的那一套——两边同源，
 * 而且**导出去仍然是一个合法的引用块**：不认这套语法的工具（GitHub 只认其中 5 种）
 * 会把它渲染成普通引用，内容一个字不丢。这是它能进闭集的前提（规格 §9.2）。
 *
 * 折叠写法 `> [!NOTE]-` 的那个 `+/-` 只做识别不做折叠：折叠是阅读态的交互，
 * 而这里的渲染结果要同时供文档站、分享页、MCP 使用，不能假设有 JS。
 */
const TYPES: Record<string, string> = {
  note: "笔记", tip: "提示", info: "说明", success: "完成", question: "疑问",
  warning: "注意", failure: "失败", danger: "危险", bug: "缺陷",
  example: "例子", quote: "引用", abstract: "摘要",
  // GitHub 的两个别名，落到语义最近的那一档
  important: "要点", caution: "警告",
};

const ALIAS: Record<string, string> = {
  hint: "tip", attention: "warning", error: "danger", fail: "failure",
  summary: "abstract", tldr: "abstract", cite: "quote", help: "question", faq: "question",
};

const MARKER = /^\[!([A-Za-z]+)\]([+-]?)[ \t]*(.*)$/;

/** 规范化类型名。不认识的一律落到 note——宁可显示成一个普通提示，也别整块散掉。 */
function normalize(raw: string): { type: string; known: boolean } {
  const lower = raw.toLowerCase();
  const mapped = ALIAS[lower] ?? lower;
  return { type: mapped in TYPES ? mapped : "note", known: mapped in TYPES };
}

export function calloutPlugin(md: MarkdownIt) {
  /**
   * 跑在 `inline` 之前：这时 inline token 的 `content` 还没解析成 children，
   * 直接改字符串是安全的；改完再交给 inline 规则去解析，标题里的行内标记照常生效。
   */
  md.core.ruler.before("inline", "callout", state => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== "blockquote_open") continue;
      // 引用块里的第一段：blockquote_open → paragraph_open → inline
      if (tokens[i + 1]?.type !== "paragraph_open" || tokens[i + 2]?.type !== "inline") continue;

      const inline = tokens[i + 2];
      const [first, ...rest] = inline.content.split("\n");
      const hit = MARKER.exec(first);
      if (!hit) continue;
      const { type, known } = normalize(hit[1]);
      if (!known) continue;                      // `[!随便写的]` 不是 callout，别抢普通引用

      const open = tokens[i];
      open.attrSet("class", `callout callout-${type}`);
      open.attrSet("data-callout", type);

      const title = hit[3].trim() || TYPES[type];
      const body = rest.join("\n");

      // 标题单独成一段。塞一个 type: "inline" 的 token 进去，后面的 inline 规则会顺手解析它，
      // 所以标题里可以写 `**粗体**`、`[[双链]]`。
      const titleOpen = new state.Token("callout_title_open", "div", 1);
      titleOpen.attrSet("class", "callout-title");
      titleOpen.block = true;
      const titleInline = new state.Token("inline", "", 0);
      titleInline.content = title;
      titleInline.children = [];
      titleInline.map = open.map;
      const titleClose = new state.Token("callout_title_close", "div", -1);
      titleClose.block = true;

      if (body.trim()) {
        inline.content = body;
        tokens.splice(i + 1, 0, titleOpen, titleInline, titleClose);
        i += 3;
      } else {
        // 只有标题没有正文：整段换成标题，别留一个空 <p>
        tokens.splice(i + 1, 3, titleOpen, titleInline, titleClose);
        i += 3;
      }
    }
    return true;
  });
}

export const CALLOUT_TYPES = TYPES;
