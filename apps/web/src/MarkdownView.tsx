import { useMemo } from "react";
import DOMPurify, { type Config as PurifyConfig } from "dompurify";
import { renderMarkdown, toggleTaskAt, type RenderMode, type WikiResolver } from "@kb/shared/markdown";
import "katex/dist/katex.min.css";

/** KaTeX 会输出 MathML 与带 style 的 span，双链与任务列表靠 data-* 传参，这些都要留住。 */
const PURIFY: PurifyConfig = { ADD_ATTR: ["target", "rel", "tabindex", "role"] };

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
    () => DOMPurify.sanitize(
      renderMarkdown(source || "_空白笔记_", { mode, resolveWiki, interactiveTasks: !!onToggleTask, sourceLines }),
      PURIFY,
    ),
    [source, mode, resolveWiki, onToggleTask, sourceLines],
  );

  function follow(target: HTMLElement) {
    const el = target.closest<HTMLElement>("[data-wiki]");
    if (!el || !onWiki || el.tagName === "A") return false;
    const section = el.dataset.wikiSection;
    onWiki(decodeURIComponent(el.dataset.wiki ?? ""), section ? decodeURIComponent(section) : undefined);
    return true;
  }

  return (
    <div
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
