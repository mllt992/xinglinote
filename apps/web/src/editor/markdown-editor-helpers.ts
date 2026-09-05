import { redo, undo } from "@codemirror/commands";
import { foldAll, syntaxTree, unfoldAll } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { openSearchPanel } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, highlightActiveLine } from "@codemirror/view";
import { insertBlock, insertLink, insertWikiLink, setHeading, toggleCodeBlock, toggleLinePrefix, toggleTask, toggleWrap, wrappedWith } from "./commands";
import { livePreview } from "./live-preview";
import { insertSnippet } from "./slash-menu";
import type { RenderToggles } from "../lib/layout-prefs";

export const ALL_ON: RenderToggles = { image: true, math: true, table: true, diagram: true };

export const readOnlyCompartment = new Compartment();
export const livePreviewCompartment = new Compartment();
export const vimCompartment = new Compartment();
export const collabCompartment = new Compartment();
export const historyCompartment = new Compartment();
export const spellcheckCompartment = new Compartment();

/** 桌面与移动工具栏共用的编辑动作；名字就是动作，不绑定某一种 UI。 */
export type EditorAction =
  | "undo" | "redo"
  | "paragraph" | "heading1" | "heading2" | "heading3" | "heading4" | "heading5" | "heading6"
  | "bold" | "italic" | "strike" | "code" | "highlight"
  | "link" | "wiki" | "quote" | "bullet" | "ordered" | "task" | "codeBlock"
  | "horizontalRule" | "table" | "inlineMath" | "blockMath" | "mermaid"
  | "search" | "fold" | "unfold";

/**
 * 即时渲染的那一套装饰。**当前行高亮跟着模式走**：Typora 那类即时渲染编辑器都不高亮当前行，
 * 一条横贯正文的底色会把连续的段落切成一格一格；源码模式下它仍然有用。
 */
export function previewExtensions(onWiki: () => ((title: string, section?: string) => void) | undefined, wysiwyg: boolean, noteId: string, render: RenderToggles): Extension {
  return [
    livePreview((title, section) => onWiki()?.(title, section), wysiwyg, noteId, render),
    wysiwyg ? [] : highlightActiveLine(),
  ];
}

/** 工具条动作 → 已有的那些命令。和快捷键走同一批实现，免得两处行为漂开。 */
export const ACTIONS: Record<EditorAction, (view: EditorView) => void> = {
  undo: v => { undo(v); },
  redo: v => { redo(v); },
  paragraph: v => { setHeading(0)(v); },
  heading1: v => { setHeading(1)(v); },
  heading2: v => { setHeading(2)(v); },
  heading3: v => { setHeading(3)(v); },
  heading4: v => { setHeading(4)(v); },
  heading5: v => { setHeading(5)(v); },
  heading6: v => { setHeading(6)(v); },
  bold: v => { toggleWrap("**")(v); },
  italic: v => { toggleWrap("*")(v); },
  strike: v => { toggleWrap("~~")(v); },
  code: v => { toggleWrap("`")(v); },
  highlight: v => { toggleWrap("==")(v); },
  link: v => { insertLink(v); },
  wiki: v => { insertWikiLink(v); },
  quote: v => { toggleLinePrefix("> ", /^\s*>[ \t]?/)(v); },
  bullet: v => { toggleLinePrefix("- ", /^\s*(?:[-*+]|\d+[.)])[ \t]+/)(v); },
  ordered: v => { toggleLinePrefix("1. ", /^\s*(?:[-*+]|\d+[.)])[ \t]+/)(v); },
  task: v => { toggleTask(v); },
  codeBlock: v => { toggleCodeBlock(v); },
  horizontalRule: v => { insertBlock("---")(v); },
  table: v => { insertSnippet("table")(v); },
  inlineMath: v => { insertSnippet("inlineMath")(v); },
  blockMath: v => { insertSnippet("blockMath")(v); },
  mermaid: v => { insertSnippet("mermaidFlow")(v); },
  search: v => { openSearchPanel(v); },
  fold: v => { foldAll(v); },
  unfold: v => { unfoldAll(v); },
};

function markerActive(state: EditorState, marker: string): boolean {
  const { from, to, head } = state.selection.main;
  if (from !== to) return wrappedWith(state, from, to, marker);
  const line = state.doc.lineAt(head);
  const before = state.sliceDoc(line.from, head);
  const after = state.sliceDoc(head, line.to);
  const open = before.lastIndexOf(marker);
  const close = after.indexOf(marker);
  if (open < 0 || close < 0) return false;
  if (marker === "*" && (before.slice(open - 1, open + 1) === "**" || after.slice(close, close + 2) === "**")) return false;
  return true;
}

export function activeActions(state: EditorState): EditorAction[] {
  const active: EditorAction[] = [];
  for (const [action, marker] of [["bold", "**"], ["italic", "*"], ["strike", "~~"], ["code", "`"], ["highlight", "=="]] as const) {
    if (markerActive(state, marker)) active.push(action);
  }
  const line = state.doc.lineAt(state.selection.main.head).text;
  const heading = /^\s*(#{1,6})[ \t]+/.exec(line);
  if (heading) active.push(`heading${heading[1].length}` as EditorAction);
  if (/^\s*>[ \t]?/.test(line)) active.push("quote");
  if (/^\s*(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\][ \t]?/.test(line)) active.push("task");
  else if (/^\s*\d+[.)][ \t]+/.test(line)) active.push("ordered");
  else if (/^\s*[-*+][ \t]+/.test(line)) active.push("bullet");
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(state.selection.main.head, -1);
  for (; node; node = node.parent) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") { active.push("codeBlock"); break; }
  }
  return active;
}

/**
 * 内容区的 DOM 属性。CodeMirror 默认按**代码编辑器**配：`spellcheck=false`、
 * `autocorrect=off`、`autocapitalize=off`，并且不给 `aria-label`。
 * 这里是散文编辑器，三条默认都得反过来；手机上尤其明显——关着自动大写与自动更正，
 * 用系统键盘写英文会难受到想换 App。
 */
export function contentAttrs(spellcheck: boolean): Extension {
  const coarse = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  return EditorView.contentAttributes.of({
    "aria-label": "笔记正文",
    spellcheck: spellcheck ? "true" : "false",
    ...(coarse ? { autocorrect: "on", autocapitalize: "sentences" } : {}),
  });
}
