/**
 * 折叠（设计 17 §3.10）：按标题折一节，按围栏折一段代码。
 *
 * 长文没有折叠就只能一路滚。Obsidian / Typora / Zettlr 在同一个内核上都有这条。
 *
 * 折叠是**纯显示**：折起来的还是原来那些字节，保存、diff、导出都当它不存在。
 */
import { codeFolding, foldGutter, foldService, syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

/** `ATXHeading3` / `SetextHeading1` → 3 / 1；不是标题回 null。 */
function headingLevel(name: string): number | null {
  const hit = /^(?:ATX|Setext)Heading([1-6])$/.exec(name);
  return hit ? Number(hit[1]) : null;
}

/** 从某个位置向上爬到第一个满足条件的节点。爬不到回 null。 */
function climb(state: EditorState, pos: number, hit: (node: SyntaxNode) => boolean): SyntaxNode | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  for (; node; node = node.parent) if (hit(node)) return node;
  return null;
}

/**
 * 标题折叠：从标题行末折到**下一个同级或更高级标题之前**，中间的子标题一起收进去。
 *
 * 范围靠语法树的兄弟节点找，不是逐行扫全文——`foldGutter` 会对每一个可见行都问一次，
 * 逐行扫的话在长文里就是「可见行数 × 文档行数」。
 */
const headings = foldService.of((state, lineStart, lineEnd) => {
  const node = climb(state, lineStart, n => headingLevel(n.name) !== null);
  const level = node && headingLevel(node.name);
  // 只认「这一行正好是标题的开头」，免得点在标题后面的段落上也给折
  if (!node || level === null || node.from !== lineStart) return null;

  let end = node.to;
  for (let sibling = node.nextSibling; sibling; sibling = sibling.nextSibling) {
    const next = headingLevel(sibling.name);
    if (next !== null && next <= level) break;
    end = sibling.to;
  }
  end = Math.min(end, state.doc.length);
  return end > lineEnd ? { from: lineEnd, to: end } : null;
});

/** 围栏代码块：留下 ` ```lang ` 那一行，其余（含收尾围栏）折起来。 */
const fences = foldService.of((state, lineStart, lineEnd) => {
  const node = climb(state, lineStart, n => n.name === "FencedCode");
  if (!node || state.doc.lineAt(node.from).from !== lineStart) return null;
  const end = Math.min(node.to, state.doc.length);
  return end > lineEnd ? { from: lineEnd, to: end } : null;
});

/** 折叠把手。平时几乎看不见，鼠标进了编辑器才浮出来——它是辅助，不该跟正文抢注意力。 */
const gutter = foldGutter({
  markerDOM(open) {
    const span = document.createElement("span");
    span.className = open ? "cm-md-fold" : "cm-md-fold cm-md-fold-closed";
    span.textContent = open ? "⌄" : "›";
    span.title = open ? "折叠这一节" : "展开";
    span.setAttribute("aria-label", open ? "折叠这一节" : "展开");
    return span;
  },
});

export function markdownFolding(): Extension {
  return [codeFolding({ placeholderText: "⋯" }), headings, fences, gutter];
}
