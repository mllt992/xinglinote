/**
 * KaTeX 按需加载。整包压缩后仍有几百 KB，而大多数笔记一条公式都没有，
 * 所以解析器只吐占位元素（见 `packages/shared/markdown/math.ts`），排版在这里补。
 */
let pending: Promise<typeof import("katex")> | null = null;

export function loadKatex() {
  // 样式和字体也一起按需拿：静态 import 的话 katex.min.css 会一直躺在主样式表里。
  // 失败要清掉 pending 再抛，否则一次网络抖动就把拒绝态缓存住，之后所有公式都排不出来。
  return (pending ??= import("katex/dist/katex.min.css")
    .then(() => import("katex"))
    .catch(err => { pending = null; throw err; }));
}

/** 把 `root` 里还没排版的公式占位元素渲染掉。可重复调用，已渲染过的会跳过。 */
export async function hydrateMath(root: HTMLElement | null) {
  if (!root) return;
  const targets = [...root.querySelectorAll<HTMLElement>("[data-math]:not([data-math-done])")];
  if (!targets.length) return;
  const katex = (await loadKatex()).default;
  for (const el of targets) {
    const source = el.dataset.math ?? "";
    const display = el.dataset.mathDisplay === "1";
    try {
      el.innerHTML = katex.renderToString(source, { displayMode: display, throwOnError: true, strict: false });
    } catch (err) {
      // 坏公式显示源码，不炸页面（设计 03 §4.6）。占位元素里本来就是源码，加个记号即可。
      el.classList.add("math-error");
      el.title = err instanceof Error ? err.message : "公式解析失败";
    }
    el.dataset.mathDone = "1";
  }
}
