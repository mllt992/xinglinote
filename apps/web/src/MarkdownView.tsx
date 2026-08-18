import { useEffect, useMemo, useRef } from "react";
import { toggleTaskAt, type RenderMode, type WikiResolver } from "@kb/shared/markdown";
import { toSafeHtml } from "./lib/render-html";
import { hydrateMath } from "./lib/katex-hydrate";
import { hydrateDiagrams } from "./lib/mermaid-hydrate";

export function MarkdownView({
  source,
  onWiki,
  onToggleTask,
  mode = "library",
  resolveWiki,
  sourceLines = false,
}: {
  source: string;
  /** 点双链。宿主负责消歧、跨区跳转、点未创建的就地新建（规格 §9.4）。 */
  onWiki?: (title: string, section?: string) => void;
  /** 勾选任务。回调拿到的是改完一个字符的新正文，直接当一次保存提交。 */
  onToggleTask?: (nextSource: string) => void;
  mode?: RenderMode;
  resolveWiki?: WikiResolver;
  /** 给块级元素打 `data-line`，供分栏视图和编辑器对齐滚动。 */
  sourceLines?: boolean;
}) {
  const html = useMemo(
    () => toSafeHtml(source || "_空白笔记_", { mode, resolveWiki, interactiveTasks: !!onToggleTask, sourceLines }),
    [source, mode, resolveWiki, onToggleTask, sourceLines],
  );

  const host = useRef<HTMLDivElement | null>(null);
  // 公式与图在这里补：KaTeX 和 mermaid 都按需加载，没用到的笔记根本不会去下它们。
  useEffect(() => { void hydrateMath(host.current); void hydrateDiagrams(host.current); }, [html]);

  function follow(target: HTMLElement) {
    const el = target.closest<HTMLElement>("[data-wiki]");
    if (!el || !onWiki || el.tagName === "A") return false;
    const section = el.dataset.wikiSection;
    onWiki(decodeURIComponent(el.dataset.wiki ?? ""), section ? decodeURIComponent(section) : undefined);
    return true;
  }

  return (
    <div
      ref={host}
      className="markdown"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={event => {
        const target = event.target as HTMLElement;
        const box = target.closest<HTMLInputElement>("input.task-checkbox");
        if (box && onToggleTask) {
          event.preventDefault();
          const line = Number(box.dataset.taskLine);
          if (Number.isInteger(line) && line >= 0) onToggleTask(toggleTaskAt(source, line));
          return;
        }
        follow(target);
      }}
      onKeyDown={event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (follow(event.target as HTMLElement)) event.preventDefault();
      }}
    />
  );
}
