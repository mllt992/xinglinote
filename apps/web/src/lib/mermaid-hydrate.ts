/**
 * mermaid 按需加载。整包压缩后比 KaTeX 还大，而绝大多数笔记里一张图都没有，
 * 所以解析器只吐占位元素（见 `packages/shared/markdown/diagram.ts`），画图在这里补。
 */
let pending: Promise<typeof import("mermaid")> | null = null;
/** 已经按哪套配色初始化过。主题一换要重新 initialize，图才会跟着变深浅。 */
let configured = "";
let seq = 0;

/** 图的配色跟随主题：`ThemeRoot` 把解析后的模式写在 `documentElement.dataset.mode`。 */
function palette(): "dark" | "default" {
  return document.documentElement.dataset.mode === "dark" ? "dark" : "default";
}

async function ready() {
  const { default: mermaid } = await (pending ??= import("mermaid"));
  const theme = palette();
  if (configured !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      // strict：图里的 HTML 标签不解析、`click` 绑定不生效，输出的 SVG 由 mermaid 自己
      // 过一遍 DOMPurify。分享出去的笔记会在别人浏览器里渲染，这个档位不能降。
      securityLevel: "strict",
      // 出错时别往 body 里塞它那张「语法错误」大图，我们自己显示源码加提示。
      suppressErrorRendering: true,
      theme,
      fontFamily: "inherit",
    });
    configured = theme;
  }
  return mermaid;
}

/** 画一段源码，回一段 SVG。写错了就抛——调用方要么显示源码，要么把错误交给 AI 去修。 */
export async function renderDiagram(source: string): Promise<string> {
  const mermaid = await ready();
  const id = `kb-diagram-${++seq}`;
  try {
    await mermaid.parse(source);   // 先验语法：过不了就别进渲染，省得留下半截 DOM
    return (await mermaid.render(id, source)).svg;
  } finally {
    // 渲染失败时 mermaid 偶尔会漏掉那个临时容器，自己收一下尾。
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

/** 同一个占位元素同时只画一次：预览每敲一个字就重渲染，不拦住会堆起一串并发。 */
const busy = new WeakSet<HTMLElement>();

/** 把 `root` 里还没画的图补上。可重复调用，已经画好且配色没变的会跳过。 */
export async function hydrateDiagrams(root: HTMLElement | null) {
  if (!root) return;
  const theme = palette();
  const targets = [...root.querySelectorAll<HTMLElement>("[data-diagram]")]
    .filter(el => el.dataset.diagramTheme !== theme && !busy.has(el));
  if (!targets.length) return;
  for (const el of targets) {
    busy.add(el);
    try {
      el.innerHTML = await renderDiagram(el.dataset.diagramSrc ?? "");
      el.classList.remove("diagram-error");
      el.removeAttribute("title");
    } catch (err) {
      // 图写错了显示源码，不炸页面——和坏公式一个口径（设计 03 §4.6）。
      el.classList.add("diagram-error");
      el.title = err instanceof Error ? err.message : "图解析失败";
    }
    el.dataset.diagramTheme = theme;
    busy.delete(el);
  }
}
