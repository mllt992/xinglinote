import { useEffect, useMemo, useRef } from "react";
import { toggleTaskAt, type RenderMode, type WikiResolver } from "@kb/shared/markdown";
import { toSafeHtml } from "./lib/render-html";
import { hydrateMath } from "./lib/katex-hydrate";
import { hydrateDiagrams } from "./lib/mermaid-hydrate";
import { hydrateCodeBlocks } from "./lib/code-block";
import { openLightboxGallery } from "./lib/lightbox";
import { cn } from "./lib/utils";

export function MarkdownView({
  source,
  onWiki,
  onToggleTask,
  mode = "library",
  resolveWiki,
  sourceLines = false,
  className,
  mentionHandles,
  hashtags,
  onHashtag,
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
  className?: string;
  /** 动态里要高亮的智能体 handle。笔记正文不要传。 */
  mentionHandles?: Iterable<string>;
  /** 动态里把 #标签 标成可点。 */
  hashtags?: boolean;
  onHashtag?: (tag: string) => void;
}) {
  const mentionKey = mentionHandles ? [...mentionHandles].join("\0") : "";
  const html = useMemo(
    () => toSafeHtml(source || "_空白笔记_", { mode, resolveWiki, interactiveTasks: !!onToggleTask, sourceLines, mentionHandles, hashtags }),
    [source, mode, resolveWiki, onToggleTask, sourceLines, mentionKey, hashtags],
  );

  const host = useRef<HTMLDivElement | null>(null);
  // 公式与图在这里补：KaTeX 和 mermaid 都按需加载，没用到的笔记根本不会去下它们。
  useEffect(() => {
    void hydrateMath(host.current);
    void hydrateDiagrams(host.current);
    hydrateCodeBlocks(host.current);
    // Markdown 生成的图片不是原生控件，补上键盘入口也让 Dialog 关闭后能回到触发图。
    host.current?.querySelectorAll("img").forEach(image => {
      if (image.closest("a")) return;
      image.tabIndex = 0;
      image.setAttribute("role", "button");
      image.setAttribute("aria-label", `查看大图：${image.alt || "图片"}`);
    });
  }, [html]);

  function follow(target: HTMLElement) {
    const el = target.closest<HTMLElement>("[data-wiki]");
    if (!el || !onWiki || el.tagName === "A") return false;
    const section = el.dataset.wikiSection;
    onWiki(decodeURIComponent(el.dataset.wiki ?? ""), section ? decodeURIComponent(section) : undefined);
    return true;
  }

  function openPreviewImage(target: HTMLImageElement) {
    const images = [...(host.current?.querySelectorAll("img") ?? [])].filter(image => !image.closest("a"));
    target.focus({ preventScroll: true });
    openLightboxGallery(
      images.map(image => ({ src: image.currentSrc || image.src, alt: image.alt })),
      images.indexOf(target),
    );
  }

  return (
    <div
      ref={host}
      className={cn("markdown", className)}
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
        // 预览里点图就放大：这一侧没有「点一下改字」要护着，不必再多一个按钮
        if (target instanceof HTMLImageElement && !target.closest("a")) {
          event.preventDefault();
          openPreviewImage(target);
          return;
        }
        const tagEl = target.closest<HTMLElement>("[data-hashtag]");
        if (tagEl && onHashtag) {
          event.preventDefault();
          onHashtag(tagEl.dataset.hashtag ?? "");
          return;
        }
        follow(target);
      }}
      onKeyDown={event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (event.target instanceof HTMLImageElement && !event.target.closest("a")) {
          event.preventDefault();
          openPreviewImage(event.target);
          return;
        }
        if (follow(event.target as HTMLElement)) event.preventDefault();
      }}
    />
  );
}
