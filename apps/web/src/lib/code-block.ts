/**
 * 代码块的语言标签与复制按钮。
 *
 * 渲染器只吐 `<pre><code class="language-xxx">`（架构 05 §5：解析器只有一个，
 * 不许为了这点装饰去改它的输出）。这两样是**宿主在客户端补的**，
 * 和公式、图表走同一条路子——公开页、分享页、文档站也就跟着一起有了。
 */

/** ` ```mermaid ` 已经被图块接走了，这里不必再管。 */
const SKIP = new Set(["mermaid"]);

function labelOf(code: Element): string {
  const cls = code.className || "";
  const hit = /(?:language|lang)-([\w+#.-]+)/.exec(cls);
  return hit ? hit[1] : "";
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 非安全上下文（http 的自托管实例）里没有 clipboard API，退回老办法
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.append(area);
      area.select();
      const done = document.execCommand("copy");
      area.remove();
      return done;
    } catch { return false; }
  }
}

/**
 * 给 `root` 里还没处理过的代码块补上标签与复制按钮。可重复调用，处理过的会跳过。
 */
export function hydrateCodeBlocks(root: HTMLElement | null) {
  if (!root) return;
  for (const pre of root.querySelectorAll<HTMLElement>("pre:not([data-code-tools])")) {
    const code = pre.querySelector("code");
    if (!code) continue;
    const lang = labelOf(code);
    if (SKIP.has(lang)) continue;
    pre.dataset.codeTools = "1";

    const bar = document.createElement("div");
    bar.className = "code-tools";

    if (lang) {
      const tag = document.createElement("span");
      tag.className = "code-lang";
      tag.textContent = lang;
      bar.append(tag);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.textContent = "复制";
    button.setAttribute("aria-label", "复制这段代码");
    button.addEventListener("click", async () => {
      const done = await copy(code.textContent ?? "");
      button.textContent = done ? "已复制" : "复制失败";
      button.classList.toggle("code-copy-done", done);
      window.setTimeout(() => {
        button.textContent = "复制";
        button.classList.remove("code-copy-done");
      }, 1600);
    });
    bar.append(button);

    // 按钮绝对定位在 pre 的右上角，所以 pre 自己得是定位上下文
    pre.style.position = "relative";
    pre.append(bar);
  }
}
