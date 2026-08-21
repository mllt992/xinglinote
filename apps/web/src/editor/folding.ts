/**
 * 折叠（设计 17 §3.10）：按标题折一节，按围栏折一段代码。
 *
 * 长文没有折叠就只能一路滚。Obsidian / Typora / Zettlr 在同一个内核上都有这条。
 *
 * 折叠是**纯显示**：折起来的还是原来那些字节，保存、diff、导出都当它不存在。
 */
import { codeFolding, ensureSyntaxTree, foldEffect, foldGutter, foldService, foldable, foldedRanges, syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, StateEffect } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { ViewPlugin, type EditorView } from "@codemirror/view";

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

/**
 * 折叠状态的记忆。
 *
 * **按「折的是哪一行的原文」记，不按行号记**：MCP、AI、恢复历史版本都会在别处改正文，
 * 行号存下来隔一会儿就指到别的地方去了，一打开就折错段落，比不记还糟。
 * 标题重名时两处都折上——这比猜一个更不容易出错。
 */
const KEY = "kb.fold";
const LIMIT = 200;

type FoldStore = Record<string, string[]>;

function readFolds(): FoldStore {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as FoldStore;
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}

function writeFolds(store: FoldStore) {
  // 只留最近 200 篇，不然一个用得久的库会把 localStorage 撑满
  const entries = Object.entries(store).slice(-LIMIT);
  try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries))); } catch { /* 隐私模式写不进就算了 */ }
}

function foldMemory(noteId: string): Extension {
  if (!noteId) return [];
  return ViewPlugin.define(view => {
    const wanted = new Set(readFolds()[noteId] ?? []);
    if (wanted.size) {
      /**
       * 建视图的这一刻语法树还没解析到，`foldable` 会一路回 null。
       * 先催一把解析（有时间预算，长文催不完就算了），折上一批就把它从待办里划掉，
       * 没折全再退避重试几次——只试一帧是不够的，实测会一条都折不上。
       */
      let tries = 0;
      const attempt = () => {
        if (!view.dom.isConnected || !wanted.size) return;
        ensureSyntaxTree(view.state, view.state.doc.length, 300);
        const effects: StateEffect<unknown>[] = [];
        for (let n = 1; n <= view.state.doc.lines; n++) {
          const line = view.state.doc.line(n);
          if (!wanted.has(line.text)) continue;
          const range = foldable(view.state, line.from, line.to);
          if (!range) continue;
          effects.push(foldEffect.of(range));
          wanted.delete(line.text);
        }
        if (effects.length) view.dispatch({ effects });
        // 找不着的（标题被改名或删了）重试几次就放弃，别一直空转
        if (wanted.size && ++tries < 5) window.setTimeout(attempt, 80 * tries);
      };
      // 用 setTimeout 而不是 requestAnimationFrame：后者在不可见的标签页里根本不跑，
      // 从「恢复上次会话」打开的一堆后台标签会全都折不上。
      window.setTimeout(attempt, 0);
    }
    return {
      destroy() {
        const texts: string[] = [];
        const state = view.state;
        // 折叠范围是从「标题行末」起算的，所以 from 落在哪一行，折起来的就是哪一条
        foldedRanges(state).between(0, state.doc.length, from => {
          const text = state.doc.lineAt(from).text;
          if (text.trim() && !texts.includes(text)) texts.push(text);
        });
        const store = readFolds();
        if (texts.length) store[noteId] = texts;
        else delete store[noteId];
        writeFolds(store);
      },
    };
  });
}

export function markdownFolding(noteId = ""): Extension {
  return [codeFolding({ placeholderText: "⋯" }), headings, fences, gutter, foldMemory(noteId)];
}
