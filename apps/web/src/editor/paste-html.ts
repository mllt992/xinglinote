/**
 * 富文本粘贴转 Markdown（设计 17 §3.6）。
 *
 * 为什么自己写而不是引 turndown：turndown 会吐闭集之外的东西（脚注、原样 HTML、
 * 各种 `<div>` 兜底），而规格 §9.2 的闭集就那么几条。自己走一遍 DOM，**只允许生成闭集内语法**，
 * 闭集外的一律降级成纯文本——这比事后再拿正则去洗 turndown 的产物可靠得多。
 *
 * 铁律照旧：这里产出的是普通输入，进文档就是普通字节，不是装饰。
 */
import DOMPurify from "dompurify";

/** 行内文本里需要转义的字符。CJK 正文里过度转义很难看，所以只挑真会引起歧义的几个。 */
function escapeInline(text: string): string {
  return text.replace(/([\\`*_[\]])/g, "\\$1");
}

/** 行首才有歧义的标记：`#`、`>`、`-`、`1.`、`|`。只在一段的开头处理。 */
function escapeLineStart(text: string): string {
  return text
    .replace(/^(\s*)(#{1,6}\s)/, "$1\\$2")
    .replace(/^(\s*)([>|])/, "$1\\$2")
    .replace(/^(\s*)([-*+]\s)/, "$1\\$2")
    .replace(/^(\s*)(\d+[.)]\s)/, "$1\\$2");
}

/** 折叠 HTML 里的空白。`<pre>` 内部不走这里。 */
function collapse(text: string): string {
  return text.replace(/[\t\n\r ]+/g, " ");
}

const SKIP = new Set(["SCRIPT", "STYLE", "HEAD", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "OBJECT", "FORM", "BUTTON", "SELECT"]);
const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE", "NAV", "FIGURE", "FIGCAPTION", "DL", "DT", "DD", "ADDRESS"]);

/** 链接与图片只放行安全协议，`javascript:` 一类直接丢掉只留文字。 */
function safeUrl(raw: string | null): string | null {
  const url = (raw ?? "").trim();
  if (!url) return null;
  if (/^(https?|mailto|tel|data:image\/):/i.test(url)) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  return url;                                  // 相对路径、锚点，原样留着
}

/** 链接文本里出现 `()` 会把地址括号截断，用尖括号包起来。 */
function wrapUrl(url: string): string {
  return /[()\s]/.test(url) ? `<${url}>` : url;
}

type Ctx = {
  /** 当前所在列表的缩进前缀，嵌套列表靠它对齐。 */
  indent: string;
  /** 在 `<pre>` 里：空白原样保留、不转义。 */
  pre: boolean;
};

function inlineOf(node: Node, ctx: Ctx): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const raw = node.nodeValue ?? "";
    return ctx.pre ? raw : escapeInline(collapse(raw));
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  if (SKIP.has(el.tagName)) return "";

  const inner = () => [...el.childNodes].map(child => inlineOf(child, ctx)).join("");

  switch (el.tagName) {
    case "BR":
      // 渲染器开着 breaks: true，一个换行就是一次断行
      return "\n";
    case "STRONG": case "B": {
      // Google Docs 会用 <b style="font-weight:normal"> 包整篇，照抄会把全文加粗
      if (/font-weight:\s*(normal|400)/i.test(el.getAttribute("style") ?? "")) return inner();
      const body = inner().trim();
      return body ? `**${body}**` : "";
    }
    case "EM": case "I": case "CITE": {
      const body = inner().trim();
      return body ? `*${body}*` : "";
    }
    case "DEL": case "S": case "STRIKE": {
      const body = inner().trim();
      return body ? `~~${body}~~` : "";
    }
    case "CODE": case "KBD": case "SAMP": case "TT": {
      const body = (el.textContent ?? "").replace(/\n/g, " ").trim();
      if (!body) return "";
      // 内容里本来就有反引号时，用更长的一串围起来
      const longest = /`+/g.exec(body) ? Math.max(...(body.match(/`+/g) ?? [""]).map(s => s.length)) : 0;
      const fence = "`".repeat(longest + 1);
      return `${fence}${/^`|`$/.test(body) ? ` ${body} ` : body}${fence}`;
    }
    case "IMG": {
      const src = safeUrl(el.getAttribute("src"));
      if (!src) return "";
      return `![${escapeInline(collapse(el.getAttribute("alt") ?? ""))}](${wrapUrl(src)})`;
    }
    case "A": {
      const body = inner().trim();
      const href = safeUrl(el.getAttribute("href"));
      if (!href) return body;
      if (!body) return `<${href}>`;
      return `[${body}](${wrapUrl(href)})`;
    }
    default:
      return inner();
  }
}

/** 一个块的行内内容：两端留白收掉，中间的连续空格保留。 */
function inlineBlock(el: HTMLElement, ctx: Ctx): string {
  return inlineOf(el, ctx).replace(/^[ \t]+|[ \t]+$/g, "").replace(/\n{3,}/g, "\n\n");
}

function listOf(el: HTMLElement, ctx: Ctx): string[] {
  const ordered = el.tagName === "OL";
  const start = ordered ? Number(el.getAttribute("start") ?? 1) || 1 : 1;
  const out: string[] = [];
  let index = start;

  for (const item of [...el.children]) {
    if (item.tagName !== "LI") continue;
    const li = item as HTMLElement;
    const marker = ordered ? `${index++}. ` : "- ";
    const pad = " ".repeat(marker.length);

    // 任务列表：`<input type=checkbox>` 是复选框的通行写法（GitHub、飞书、Notion 都这样导出）
    const box = li.querySelector<HTMLInputElement>(":scope > input[type=checkbox], :scope > p > input[type=checkbox]");
    const task = box ? (box.checked || box.hasAttribute("checked") ? "[x] " : "[ ] ") : "";
    box?.remove();

    const nested: string[] = [];
    const own: Node[] = [];
    for (const child of [...li.childNodes]) {
      const tag = (child as HTMLElement).tagName;
      if (tag === "UL" || tag === "OL") nested.push(...listOf(child as HTMLElement, { ...ctx, indent: ctx.indent + pad }));
      else own.push(child);
    }
    const holder = document.createElement("div");
    holder.append(...own);
    const body = inlineBlock(holder, ctx).replace(/\n/g, `\n${ctx.indent}${pad}`);

    out.push(`${ctx.indent}${marker}${task}${body}`);
    out.push(...nested);
  }
  return out;
}

function tableOf(el: HTMLElement, ctx: Ctx): string | null {
  const rows = [...el.querySelectorAll("tr")].map(tr =>
    [...tr.children]
      .filter(cell => cell.tagName === "TD" || cell.tagName === "TH")
      // 单元格里不能有裸竖线或换行，否则表格结构会散
      .map(cell => inlineBlock(cell as HTMLElement, ctx).replace(/\n+/g, " ").replace(/\|/g, "\\|").trim()));
  if (!rows.length || !rows[0].length) return null;

  const width = Math.max(...rows.map(row => row.length));
  const align = [...(el.querySelector("tr")?.children ?? [])].map(cell => {
    const value = `${(cell as HTMLElement).style.textAlign} ${cell.getAttribute("align") ?? ""}`;
    if (value.includes("center")) return ":---:";
    if (value.includes("right")) return "---:";
    if (value.includes("left")) return ":---";
    return "---";
  });

  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  // Markdown 表格必须有表头。源表格没有 th 就把第一行当表头——总比整张表退化成文字强。
  const out = [line(rows[0]), line(Array.from({ length: width }, (_, i) => align[i] ?? "---"))];
  for (const row of rows.slice(1)) out.push(line(row));
  return out.join("\n");
}

function blocksOf(node: Node, ctx: Ctx): string[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = collapse(node.nodeValue ?? "").trim();
    return text ? [escapeLineStart(escapeInline(text))] : [];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const el = node as HTMLElement;
  if (SKIP.has(el.tagName)) return [];

  const children = () => [...el.childNodes].flatMap(child => blocksOf(child, ctx));

  switch (el.tagName) {
    case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": {
      const body = inlineBlock(el, ctx).replace(/\n+/g, " ").trim();
      return body ? [`${"#".repeat(Number(el.tagName[1]))} ${body}`] : [];
    }
    case "HR":
      return ["---"];
    case "PRE": {
      const code = el.querySelector("code");
      const body = (code ?? el).textContent ?? "";
      if (!body.trim()) return [];
      const lang = /(?:language|lang)-([\w+#-]+)/.exec(`${code?.className ?? ""} ${el.className}`)?.[1] ?? "";
      const fence = "`".repeat(Math.max(3, ...(body.match(/`{3,}/g) ?? []).map(s => s.length + 1)));
      return [`${fence}${lang}\n${body.replace(/\n+$/, "")}\n${fence}`];
    }
    case "BLOCKQUOTE": {
      const inner = children().join("\n\n");
      if (!inner.trim()) return [];
      return [inner.split("\n").map(line => (line ? `> ${line}` : ">")).join("\n")];
    }
    case "UL": case "OL": {
      const lines = listOf(el, ctx);
      return lines.length ? [lines.join("\n")] : [];
    }
    case "TABLE": {
      const table = tableOf(el, ctx);
      return table ? [table] : [];
    }
    case "LI":
      // 落单的 <li>（源里结构破了）当普通段落处理
      return [inlineBlock(el, ctx)].filter(Boolean);
    default: {
      if (BLOCK.has(el.tagName) || el.tagName === "BODY" || el.tagName === "HTML") {
        // 容器里如果混着行内内容与块级子元素，行内那部分不能丢：先看有没有块级子元素
        const hasBlock = [...el.children].some(c => BLOCK.has(c.tagName) || /^(H[1-6]|UL|OL|PRE|TABLE|BLOCKQUOTE|HR)$/.test(c.tagName));
        if (hasBlock) return children();
        const body = inlineBlock(el, ctx);
        return body.trim() ? [escapeLineStart(body)] : [];
      }
      const body = inlineBlock(el, ctx);
      return body.trim() ? [escapeLineStart(body)] : [];
    }
  }
}

/**
 * 把剪贴板里的 `text/html` 转成闭集内的 Markdown。转不出东西就回 null，调用方退回纯文本粘贴。
 *
 * 先过一遍 DOMPurify：剪贴板里的 HTML 可能带脚本与事件属性，而我们要把它挂进一个真的
 * DOM 节点里遍历，不消毒等于把别人页面上的脚本请进来。
 */
export function htmlToMarkdown(html: string): string | null {
  if (!html.trim()) return null;
  const root = DOMPurify.sanitize(html, { RETURN_DOM: true, FORBID_TAGS: [...SKIP].map(t => t.toLowerCase()) });
  const blocks = blocksOf(root, { indent: "", pre: false })
    .map(block => block.replace(/[ \t]+$/gm, ""))
    .filter(block => block.trim());
  const out = blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return out || null;
}

/** 剪贴板里那段 HTML 值不值得转：只有纯文本包装（`<meta>`、裸 `<div>`）就别折腾了。 */
export function worthConverting(html: string): boolean {
  return /<(h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|pre|code|blockquote|strong|b|em|i|del|s|a|img|hr|p|br)\b/i.test(html);
}
