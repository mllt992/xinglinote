import DOMPurify, { type Config as PurifyConfig } from "dompurify";
import { renderMarkdown, type MarkdownEnv } from "@kb/shared/markdown";

/** 双链与任务列表靠 data-* 传参，链接要留 target/rel，无障碍要留 role/tabindex。 */
const PURIFY: PurifyConfig = { ADD_ATTR: ["target", "rel", "tabindex", "role"] };

/**
 * 渲染并消毒。解析器只有一个（架构 05 §5），消毒也只有这一处，
 * 预览栏、编辑器里的表格小部件、公开页都走它。
 */
export function toSafeHtml(source: string, env: MarkdownEnv = {}): string {
  return DOMPurify.sanitize(renderMarkdown(source, env), PURIFY);
}
