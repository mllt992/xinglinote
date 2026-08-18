import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/**
 * 编辑器外观。一条硬规则：这里不许出现写死的颜色，全部走 CSS 变量，
 * 否则主题包（设计 15）换肤时编辑器会掉队。
 */
export const editorTheme = EditorView.theme({
  "&": { color: "var(--foreground)", backgroundColor: "transparent", height: "100%" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", fontSize: "14px", lineHeight: "1.8", overflow: "auto" },
  ".cm-content": { padding: "0 0 45vh", caretColor: "var(--primary)" },
  ".cm-line": { padding: "0 2px 0 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftWidth: "2px", borderLeftColor: "var(--primary)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--primary) 16%, transparent)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--muted) 60%, transparent)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--primary) 12%, transparent)" },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  ".cm-gutters": { border: "0", backgroundColor: "transparent", color: "var(--muted-foreground)" },
  ".cm-foldPlaceholder": {
    border: "1px solid var(--border-ui)", borderRadius: "5px",
    backgroundColor: "var(--muted)", color: "var(--muted-foreground)", padding: "0 .4em",
  },

  /* 查找替换面板：套用弹层的观感，别让它看着像浏览器原生控件 */
  ".cm-panels": { backgroundColor: "var(--popover)", color: "var(--foreground)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border-ui)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border-ui)" },
  ".cm-panel.cm-search": { padding: ".5rem .65rem", display: "flex", flexWrap: "wrap", alignItems: "center", gap: ".35rem" },
  ".cm-panel.cm-search label": { display: "inline-flex", alignItems: "center", gap: ".25rem", fontSize: "12px", color: "var(--muted-foreground)" },
  ".cm-textfield": {
    border: "1px solid var(--border-ui)", borderRadius: "calc(var(--radius-ui) - 4px)",
    backgroundColor: "var(--background)", color: "var(--foreground)", padding: ".3rem .5rem", fontSize: "13px",
  },
  ".cm-textfield:focus": { outline: "2px solid var(--primary)", outlineOffset: "-1px" },
  ".cm-button": {
    border: "1px solid var(--border-ui)", borderRadius: "calc(var(--radius-ui) - 4px)",
    backgroundImage: "none", backgroundColor: "var(--muted)", color: "var(--foreground)",
    padding: ".3rem .6rem", fontSize: "12px", cursor: "pointer",
  },
  ".cm-button:hover": { backgroundColor: "var(--accent-ui)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warning) 32%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--warning) 60%, transparent)" },

  /* 自动补全：`[[` 双链、斜杠命令都用它 */
  ".cm-tooltip": {
    border: "1px solid var(--border-ui)", borderRadius: "var(--radius-ui)",
    backgroundColor: "var(--popover)", color: "var(--foreground)",
    boxShadow: "0 12px 32px rgb(0 0 0 / .12)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-ui)", fontSize: "13px", maxHeight: "16rem" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: ".3rem .6rem", borderRadius: "calc(var(--radius-ui) - 4px)" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent-ui)", color: "var(--foreground)" },
  ".cm-completionIcon": { display: "none" },
  ".cm-completionDetail": { marginLeft: ".5rem", color: "var(--muted-foreground)", fontStyle: "normal" },
});

/**
 * 语法着色。Markdown 的结构标记（`#`、`**`、`-`）压暗，正文内容加粗放大——
 * 这是「源码模式也不难看」的关键；完整的 Live Preview 隐藏标记在 P1 做。
 */
export const editorHighlight = HighlightStyle.define([
  { tag: t.processingInstruction, color: "var(--muted-foreground)", opacity: 0.5 },
  { tag: t.heading1, fontSize: "1.55em", fontWeight: "700", lineHeight: 1.35, fontFamily: "var(--font-title)" },
  { tag: t.heading2, fontSize: "1.32em", fontWeight: "700", lineHeight: 1.35, fontFamily: "var(--font-title)" },
  { tag: t.heading3, fontSize: "1.16em", fontWeight: "700", fontFamily: "var(--font-title)" },
  { tag: [t.heading4, t.heading5, t.heading6], fontSize: "1.04em", fontWeight: "700", fontFamily: "var(--font-title)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--muted-foreground)" },
  { tag: t.quote, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: t.list, color: "var(--primary)" },
  { tag: [t.link, t.url], color: "var(--primary)", textDecoration: "underline", textUnderlineOffset: "3px" },
  { tag: t.monospace, color: "var(--code-string)" },
  { tag: t.contentSeparator, color: "var(--muted-foreground)" },
  { tag: t.invalid, color: "var(--destructive)" },

  /* 代码块里嵌套语言的着色，靠 @codemirror/language-data 按需加载 */
  { tag: t.comment, color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword], color: "var(--code-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--code-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--code-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: "var(--code-function)" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: "var(--code-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--code-property)" },
  { tag: [t.operator, t.punctuation, t.bracket, t.angleBracket, t.separator], color: "var(--code-punctuation)" },
  { tag: [t.definition(t.variableName), t.self], color: "var(--code-variable)" },
  { tag: t.escape, color: "var(--code-number)" },
]);

export const editorHighlighting = syntaxHighlighting(editorHighlight);
