/**
 * 双链悬停卡片（设计 17 §3.11）。
 *
 * 双链以前只能「点开」，而点开就意味着离开当前上下文——写着写着为了确认一句话，
 * 得跳走再跳回来。悬停给一段摘要，多数时候就不用跳了。
 *
 * 卡片先摆出来再填内容：等数据到齐了才返回 tooltip 的话，鼠标早移开了。
 */
import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { hoverTooltip } from "@codemirror/view";
import { wikiAt } from "./live-preview";

/** 一条双链指向的东西。`null` = 这篇还没创建。 */
export type WikiPreview = { title: string; excerpt: string; notebook?: string } | null;

export type WikiPreviewLoader = (title: string, section?: string) => Promise<WikiPreview>;

function card(text: string, cls = ""): HTMLElement {
  const p = document.createElement("p");
  p.className = cls;
  p.textContent = text;
  return p;
}

export function wikiHover(read: () => WikiPreviewLoader | undefined): Extension {
  return hoverTooltip((view, pos, side) => {
    if (!read()) return null;
    let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, side);
    for (; node && node.name !== "WikiLink"; node = node.parent);
    if (!node) return null;
    const ref = wikiAt(view.state, node.from);
    if (!ref) return null;
    const { from, to } = node;

    return {
      pos: from,
      end: to,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-md-wiki-card";
        dom.append(card("载入中…", "cm-md-wiki-card-body"));
        // 现读：鼠标停下来的这一刻宿主可能已经换了工作区
        const load = read();
        void load?.(ref.title, ref.section)
          .then(data => {
            dom.textContent = "";
            if (!data) {
              dom.classList.add("cm-md-wiki-card-missing");
              dom.append(card(ref.title, "cm-md-wiki-card-title"), card("这篇还没创建", "cm-md-wiki-card-body"));
              return;
            }
            dom.append(card(data.title, "cm-md-wiki-card-title"));
            if (data.notebook) dom.append(card(data.notebook, "cm-md-wiki-card-meta"));
            dom.append(card(data.excerpt || "（空白笔记）", "cm-md-wiki-card-body"));
          })
          .catch(() => {
            dom.textContent = "";
            dom.append(card("读不到这篇的内容", "cm-md-wiki-card-body"));
          });
        return { dom };
      },
    };
  }, { hoverTime: 350 });
}
