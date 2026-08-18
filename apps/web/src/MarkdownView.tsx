import { useMemo } from "react";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
const defaultText = md.renderer.rules.text ?? ((tokens, idx) => tokens[idx].content);
md.renderer.rules.text = (tokens, idx, options, env, self) => {
  const escaped = defaultText(tokens, idx, options, env, self);
  return escaped.replace(/(!?)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_all, embed, title, display) => {
    const label = display || title;
    return `<span class="wiki${embed ? " embed" : ""}" data-wiki="${encodeURIComponent(title.trim())}">${embed ? "↳ " : ""}${label}</span>`;
  });
};

export function MarkdownView({ source, onWiki }: { source: string; onWiki?: (title: string) => void }) {
  const html = useMemo(() => DOMPurify.sanitize(md.render(source || "_空白笔记_")), [source]);
  return (
    <div
      className="markdown"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(event) => {
        const el = (event.target as HTMLElement).closest<HTMLElement>("[data-wiki]");
        if (el && onWiki) onWiki(decodeURIComponent(el.dataset.wiki ?? ""));
      }}
    />
  );
}
