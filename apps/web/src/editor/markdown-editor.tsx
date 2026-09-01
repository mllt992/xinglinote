import { useEffect, useImperativeHandle, useRef } from "react";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { bracketMatching, foldAll, foldKeymap, indentOnInput, syntaxTree, unfoldAll } from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, Prec, type Extension } from "@codemirror/state";
import {
  EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine,
  keymap, placeholder as placeholderExt, rectangularSelection,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { fileDrop, type FileUploader } from "./attachments";
import { insertBlock, insertLink, insertTextAtSelection, insertWikiLink, setHeading, structuralTab, structuralShiftTab, toggleCodeBlock, toggleLinePrefix, toggleTask, toggleWrap, wrappedWith } from "./commands";
import { markdownFolding } from "./folding";
import { hangingIndent } from "./hanging-indent";
import { livePreview } from "./live-preview";
import { markdownSyntaxExtensions } from "./markdown-syntax";
import { smartPaste } from "./paste";
import { tableTextSelection } from "./table-edit";
import { insertSnippet, slashCompletion } from "./slash-menu";
import { typewriterScroll } from "./typewriter";
import { editorHighlighting, editorTheme } from "./theme";
import { createCollab, type CollabPeer, type CollabSession, type CollabStatus, type CollabUser } from "./collab";
import { cachedVim, loadVim, vimExtension, vimModeOf, type VimMode } from "./vim";
import { wikiCompletion, type WikiCompleteOptions } from "./wiki-complete";
import { wikiHover, type WikiPreviewLoader } from "./wiki-hover";
import type { RenderToggles } from "../lib/layout-prefs";
import { editorWysiwyg, type EditorPreviewMode } from "../lib/editor-mode";

const ALL_ON: RenderToggles = { image: true, math: true, table: true, diagram: true };

/**
 * 换篇再回来时的光标与滚动位置。**只活在这一次会话里**，不进 localStorage：
 * 位置是按字符偏移记的，而 MCP / AI / 恢复历史版本都会在别处改正文，
 * 存到下次打开就是一串错位的偏移；这一层缓存够用了，也不会无限长大。
 */
const spots = new Map<string, { anchor: number; head: number; top: number }>();
const SPOT_LIMIT = 60;

function rememberSpot(key: string, view: EditorView) {
  if (!key) return;
  const { anchor, head } = view.state.selection.main;
  spots.delete(key);                                  // 删了再塞，Map 的插入顺序就是最近使用顺序
  spots.set(key, { anchor, head, top: view.scrollDOM.scrollTop });
  while (spots.size > SPOT_LIMIT) spots.delete(spots.keys().next().value!);
}

const readOnlyCompartment = new Compartment();
// 即时渲染要换掉整个装饰插件，用隔间热替换，省得为一个开关重建编辑器。
const livePreviewCompartment = new Compartment();
// Vim 是按需加载的，加载完才往这个隔间里塞，所以它天生就得是隔间而不是初始扩展。
const vimCompartment = new Compartment();
// 协同也一样：连上之后才有 Y.Text 可绑，连不上就永远是空扩展（静默退回单机保存）。
const collabCompartment = new Compartment();
// 撤销：单机时是 CodeMirror 的 history，协同接管后必须整个换掉，见 §协同那段注释。
const historyCompartment = new Compartment();
// 拼写检查是本机偏好，改一下不该重建编辑器。
const spellcheckCompartment = new Compartment();

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
function previewExtensions(onWiki: () => ((title: string, section?: string) => void) | undefined, wysiwyg: boolean, noteId: string, render: RenderToggles): Extension {
  return [
    livePreview((title, section) => onWiki()?.(title, section), wysiwyg, noteId, render),
    wysiwyg ? [] : highlightActiveLine(),
  ];
}

/** 工具条动作 → 已有的那些命令。和快捷键走同一批实现，免得两处行为漂开。 */
const ACTIONS: Record<EditorAction, (view: EditorView) => void> = {
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

function activeActions(state: EditorState): EditorAction[] {
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
function contentAttrs(spellcheck: boolean): Extension {
  const coarse = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  return EditorView.contentAttributes.of({
    "aria-label": "笔记正文",
    spellcheck: spellcheck ? "true" : "false",
    ...(coarse ? { autocorrect: "on", autocapitalize: "sentences" } : {}),
  });
}

export type MarkdownEditorHandle = {
  /** 把某一源码行滚到视口顶部（0 基，和预览的 `data-line` 同一套编号）。 */
  scrollToLine: (line: number) => void;
  focus: () => void;
  /** 执行一个格式动作，并把焦点还给编辑器（手机上焦点一丢键盘就收）。 */
  run: (action: EditorAction) => void;
  /** 工具栏激活态与历史按钮可用性。 */
  activeActions: () => EditorAction[];
  historyState: () => { canUndo: boolean; canRedo: boolean };
  /** 当前选区，没选中就是 null。偏移量和正文字符串一致，可以直接拿去切片。 */
  getSelection: () => { text: string; from: number; to: number } | null;
  /** 选中一段并滚过去，用来把「这条纠错说的是哪句」指出来。 */
  selectRange: (from: number, to: number) => void;
  /** 光标位置（字符偏移，和正文字符串同一套坐标）。编辑器没挂载时是 null。 */
  getCursorPos: () => number | null;
  /** 就地替换一段，光标落在插入内容末尾。`from === to` 就是纯插入。 */
  replaceRange: (from: number, to: number, text: string) => void;
  /** 在当前选区插入文本，上传附件后用它落下 Markdown。 */
  insertText: (text: string) => void;
};

/**
 * 正文编辑器。内核 CodeMirror 6（Obsidian 用的也是它）。
 *
 * 铁律：文档内容永远是原始 Markdown，装饰与着色只影响显示，不碰一个字节。
 * 版本快照、行级 diff、`expected_version` 冲突、导出回 Obsidian 都指着这条（设计 03、17）。
 */
export function MarkdownEditor({
  value,
  onChange,
  onSave,
  onWiki,
  onUpload,
  onScrollLine,
  onCursor,
  completion,
  wikiPreview,
  typewriter = false,
  previewMode = "live",
  render = ALL_ON,
  vim = false,
  onVimMode,
  spellcheck = true,
  collab = null,
  onCollab,
  readOnly = false,
  placeholder = "",
  resetKey,
  className,
  autoFocus = false,
  ref,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Ctrl/⌘+S：不等 debounce，立刻存。 */
  onSave?: () => void;
  /** Ctrl/⌘ + 单击双链时跳转。 */
  onWiki?: (title: string, section?: string) => void;
  /** 粘贴 / 拖入文件时上传，回一段可直接落进正文的 Markdown。 */
  onUpload?: FileUploader;
  /** 视口顶部对应的源码行（0 基），用于和预览对齐滚动。 */
  onScrollLine?: (line: number) => void;
  /** 光标行列与选中字数，底部状态栏用。行列是 1 基，照编辑器的老习惯。 */
  onCursor?: (info: { line: number; col: number; selected: number }) => void;
  /** `[[` 补全的数据来源。每次触发都会重新读，所以传当前值即可。 */
  completion?: WikiCompleteOptions;
  /** 双链悬停卡片的数据来源。不给就没有卡片；回 null = 这篇还没创建。 */
  wikiPreview?: WikiPreviewLoader;
  /** 打字机滚动：光标行钉在视口中间。 */
  typewriter?: boolean;
  /** 显示口径：单栏编辑用 live；分栏左侧必须显式传 source。 */
  previewMode?: EditorPreviewMode;
  /** 就地渲染哪些东西。默认全开；关掉的那项退回源码。 */
  render?: RenderToggles;
  /** Vim keymap。按需加载，关着的时候一个字节都不下。 */
  vim?: boolean;
  /** Vim 模式变了：底栏拿它显示 NORMAL / INSERT / VISUAL；关着时给 null。 */
  onVimMode?: (mode: VimMode | null) => void;
  /** 拼写检查。默认**开**——这是散文编辑器，CodeMirror 那个关掉的默认是给代码用的。 */
  spellcheck?: boolean;
  /** 开协同。给了才连；连不上会自己退回单机保存，调用方不必处理。 */
  collab?: CollabUser | null;
  /** 协同状态与在场的人。宿主拿它显示头像组，以及决定还要不要自己 PATCH 正文。 */
  onCollab?: (info: { status: CollabStatus; peers: CollabPeer[] }) => void;
  readOnly?: boolean;
  placeholder?: string;
  /** 换一篇笔记时传新的 key。同一个 key 再回来时，上次的光标与滚动位置会还原。 */
  resetKey?: string;
  className?: string;
  autoFocus?: boolean;
  ref?: React.Ref<MarkdownEditorHandle>;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  // 这些回调每次渲染都是新函数，用 ref 兜住，免得为了它们重建整个编辑器。
  const latest = useRef({ onChange, onSave, onWiki, onUpload, onScrollLine, onCursor, onVimMode, completion, typewriter, wikiPreview });
  latest.current = { onChange, onSave, onWiki, onUpload, onScrollLine, onCursor, onVimMode, completion, typewriter, wikiPreview };
  const mine = useRef(value);
  const vimOn = useRef(vim);
  /** 协同接管期间，正文的事实源是 Y.Text，外面那个受控 value 不能再往回盖。 */
  const collabSession = useRef<CollabSession | null>(null);
  /** 侧栏「引用选区」会抢走焦点；CM 选区可能被清成光标。记住最近一次非空选区。 */
  const lastQuoteSel = useRef<{ text: string; from: number; to: number } | null>(null);
  const peers = useRef<CollabPeer[]>([]);
  const status = useRef<CollabStatus>("offline");
  // 不再根据滚动回调猜模式：调用方明确决定是即时渲染还是纯源码。
  const effectiveWysiwyg = editorWysiwyg(previewMode);

  useImperativeHandle(ref, () => ({
    scrollToLine: line => {
      const instance = view.current;
      if (!instance) return;
      const total = instance.state.doc.lines;
      const target = instance.state.doc.line(Math.min(Math.max(line + 1, 1), total));
      instance.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: "start" }) });
    },
    focus: () => view.current?.focus(),
    run: action => {
      const instance = view.current;
      if (!instance || instance.state.readOnly) return;
      if (action === "undo" && collabSession.current) collabSession.current.undo();
      else if (action === "redo" && collabSession.current) collabSession.current.redo();
      else ACTIONS[action](instance);
      instance.focus();
    },
    activeActions: () => view.current ? activeActions(view.current.state) : [],
    historyState: () => {
      const instance = view.current;
      const session = collabSession.current;
      if (session) return { canUndo: session.canUndo(), canRedo: session.canRedo() };
      return { canUndo: !!instance && undoDepth(instance.state) > 0, canRedo: !!instance && redoDepth(instance.state) > 0 };
    },
    selectRange: (from, to) => {
      const instance = view.current;
      if (!instance) return;
      const max = instance.state.doc.length;
      const anchor = Math.min(Math.max(from, 0), max);
      const head = Math.min(Math.max(to, 0), max);
      instance.dispatch({ selection: { anchor, head }, effects: EditorView.scrollIntoView(anchor, { y: "center" }) });
      instance.focus();
    },
    getSelection: () => {
      const instance = view.current;
      if (!instance) return lastQuoteSel.current;
      const tableSelection = tableTextSelection(instance);
      if (tableSelection) {
        lastQuoteSel.current = tableSelection;
        return tableSelection;
      }
      const { from, to } = instance.state.selection.main;
      if (from !== to) {
        const live = { text: instance.state.sliceDoc(from, to), from, to };
        lastQuoteSel.current = live;
        return live;
      }
      const remembered = lastQuoteSel.current;
      if (!remembered || remembered.to > instance.state.doc.length) return null;
      if (instance.state.sliceDoc(remembered.from, remembered.to) !== remembered.text) return null;
      return remembered;
    },
    getCursorPos: () => view.current?.state.selection.main.head ?? null,
    replaceRange: (from, to, text) => {
      const instance = view.current;
      if (!instance || instance.state.readOnly) return;
      const max = instance.state.doc.length;
      const start = Math.min(Math.max(from, 0), max);
      const end = Math.min(Math.max(to, start), max);
      instance.dispatch({
        changes: { from: start, to: end, insert: text },
        selection: EditorSelection.cursor(start + text.length),
        userEvent: "input.replace",
      });
      instance.focus();
    },
    insertText: text => {
      const instance = view.current;
      if (!instance || instance.state.readOnly) return;
      insertTextAtSelection(text, "input.upload")(instance);
      instance.focus();
    },
  }), []);

  useEffect(() => {
    if (!host.current) return;
    lastQuoteSel.current = null;
    // 上次离开这篇时停在哪儿。偏移量按当前正文夹一下——中间可能被 MCP / AI 改短了。
    const spot = spots.get(resetKey ?? "");
    const clamp = (n: number) => Math.min(Math.max(n, 0), value.length);
    const instance = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        selection: spot ? { anchor: clamp(spot.anchor), head: clamp(spot.head) } : undefined,
        extensions: [
          // Vim 的 keymap 是 Prec.highest，会盖住下面那套；把应用级快捷键也提到最高，
          // 让 Ctrl/⌘+S、Ctrl+B 这些照旧——它们是宿主的约定，换个编辑模式不该改变「保存」怎么按。
          Prec.highest(keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => { latest.current.onSave?.(); return true; } },
            { key: "Mod-b", run: toggleWrap("**") },
            { key: "Mod-i", run: toggleWrap("*") },
            { key: "Mod-e", run: toggleWrap("`") },
            { key: "Mod-Shift-x", run: toggleWrap("~~") },
            { key: "Mod-Shift-k", run: insertLink },
            { key: "Mod-Shift-l", run: insertWikiLink },
            { key: "Mod-Shift-o", run: toggleLinePrefix("> ", /^\s*>[ \t]?/) },
            { key: "Mod-Shift-u", run: toggleLinePrefix("- ", /^\s*(?:[-*+]|\d+[.)])[ \t]+/) },
            { key: "Mod-Shift-Enter", run: toggleTask },
          ])),
          vimCompartment.of(vim && cachedVim() ? vimExtension(cachedVim()!, () => latest.current.onSave?.()) : []),
          collabCompartment.of([]),
          historyCompartment.of(history()),
          drawSelection(),
          dropCursor(),
          rectangularSelection(),
          crosshairCursor(),
          highlightSelectionMatches(),
          bracketMatching(),
          closeBrackets(),
          indentOnInput(),
          autocompletion({
            activateOnTyping: true,
            icons: false,
            override: [wikiCompletion(() => latest.current.completion ?? {}), slashCompletion()],
          }),
          search({ top: true }),
          EditorView.lineWrapping,
          EditorState.allowMultipleSelections.of(true),
          markdown({ base: markdownLanguage, codeLanguages: languages, extensions: markdownSyntaxExtensions }),
          livePreviewCompartment.of(previewExtensions(() => latest.current.onWiki, effectiveWysiwyg, resetKey ?? "", render)),
          hangingIndent(),
          markdownFolding(resetKey ?? ""),
          typewriterScroll(() => latest.current.typewriter === true),
          fileDrop(file => latest.current.onUpload?.(file) ?? Promise.resolve(null)),
          smartPaste(),
          wikiHover(() => latest.current.wikiPreview),
          spellcheckCompartment.of(contentAttrs(spellcheck)),
          editorHighlighting,
          editorTheme,
          placeholderExt(placeholder),
          keymap.of([
            ...closeBracketsKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...completionKeymap,
            ...foldKeymap,
            ...defaultKeymap,
            // Tab 不再无条件吞掉：那是键盘无障碍里的经典陷阱（进得来出不去）。
            // 只有「在列表里 / 在代码块里 / 选中了多行」时才缩进，其余情况放行让 Tab 移焦。
            { key: "Tab", run: structuralTab, shift: structuralShiftTab },
          ]),
          readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
          EditorView.updateListener.of(update => {
            if (update.docChanged) {
              const next = update.state.doc.toString();
              mine.current = next;
              latest.current.onChange(next);
            }
            if (update.docChanged || update.selectionSet) {
              const { head, from, to } = update.state.selection.main;
              if (from !== to) lastQuoteSel.current = { text: update.state.sliceDoc(from, to), from, to };
              const report = latest.current.onCursor;
              if (report) {
                const line = update.state.doc.lineAt(head);
                report({ line: line.number, col: head - line.from + 1, selected: to - from });
              }
              // 模式切换本身不产生事务，但进出插入模式一定伴随选区或文档变化，
              // 蹭这一趟上报就够了，不必再往 view 上挂一个轮询。
              if (vimOn.current) latest.current.onVimMode?.(vimModeOf(update.view));
            }
          }),
        ],
      }),
    });
    view.current = instance;
    // 新建的 doc 就是当前 value，记上一笔，免得下面的同步 effect 又原样重写一遍：
    // 那会白白产生一次 docChanged，把刚打开的笔记标成「未保存」并触发一次空保存。
    mine.current = value;
    if (autoFocus) instance.focus();
    // 滚动位置要等 CodeMirror 量完行高才有意义，下一轮任务再放回去。
    // 用 setTimeout 不用 requestAnimationFrame：后者在不可见的标签页里根本不跑。
    if (spot) window.setTimeout(() => { if (instance.dom.isConnected) instance.scrollDOM.scrollTop = spot.top; }, 0);

    // scroll 不冒泡，CM 也不转发，只能自己在滚动容器上听。
    const report = () => {
      const notify = latest.current.onScrollLine;
      if (!notify) return;
      const box = instance.scrollDOM.getBoundingClientRect();
      const pos = instance.posAtCoords({ x: box.left + 12, y: box.top + 4 }, false);
      notify(instance.state.doc.lineAt(pos).number - 1);
    };
    instance.scrollDOM.addEventListener("scroll", report, { passive: true });

    return () => {
      instance.scrollDOM.removeEventListener("scroll", report);
      rememberSpot(resetKey ?? "", instance);
      instance.destroy();
      view.current = null;
    };
    // 只在换篇时重建。value / readOnly 的变化走下面两个 effect 增量同步，
    // 不然每敲一个字都会重建编辑器，光标、撤销栈、滚动位置全丢。
  }, [resetKey]);

  // 外部改了正文（冲突后加载对方版本、AI 写作、恢复历史版本、别处插入附件链接）。
  useEffect(() => {
    const instance = view.current;
    // 协同接管期间正文归 Y.Text 管：这里再盖一次会把别人正在敲的字冲掉
    if (collabSession.current) return;
    if (!instance || value === mine.current) return;
    mine.current = value;
    const selection = instance.state.selection.main;
    instance.dispatch({
      changes: { from: 0, to: instance.state.doc.length, insert: value },
      selection: { anchor: Math.min(selection.anchor, value.length), head: Math.min(selection.head, value.length) },
    });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly]);

  useEffect(() => {
    view.current?.dispatch({
      effects: livePreviewCompartment.reconfigure(previewExtensions(() => latest.current.onWiki, effectiveWysiwyg, resetKey ?? "", render)),
    });
  }, [effectiveWysiwyg, resetKey, render]);

  useEffect(() => {
    view.current?.dispatch({ effects: spellcheckCompartment.reconfigure(contentAttrs(spellcheck)) });
  }, [spellcheck]);

  /**
   * 协同。连上之前编辑器照常单机可用；连上那一刻 Y.Text 接管正文，
   * 所以要先把当前正文塞进空文档，否则第一个进房的人会把自己的正文清成空白。
   */
  useEffect(() => {
    if (!collab || readOnly) { onCollab?.({ status: "offline", peers: [] }); return; }
    let alive = true;
    const session = createCollab(resetKey ?? "", collab, {
      status: s => { if (!alive) return; status.current = s; onCollab?.({ status: s, peers: peers.current }); },
      peers: list => { if (!alive) return; peers.current = list; onCollab?.({ status: status.current, peers: list }); },
      synced: text => {
        if (!alive || !view.current) return;
        // 服务端总是拿 notes.body_md 初始化房间；房里居然是空的而本地有正文，说明快照坏了，补种一次
        if (!text.toString() && mine.current) text.insert(0, mine.current);
        collabSession.current = session;
        view.current.dispatch({
          effects: [
            collabCompartment.reconfigure(session!.extension),
            // **同时把 CodeMirror 的 history 摘掉**：yCollab 推远端改动进来时没标
            // `addToHistory: false`，留着它，本地撤销栈里就会混进同事敲的字，
            // 一按 Ctrl+Z 撤的是别人的句子，而且撤销结果还会经 CRDT 广播回去。
            // 撤销改由 collab.ts 里那份 Y.UndoManager 的 keymap 接管（只撤自己的）。
            historyCompartment.reconfigure([]),
          ],
        });
      },
    });
    if (!session) { onCollab?.({ status: "offline", peers: [] }); return; }
    return () => {
      alive = false;
      collabSession.current = null;
      view.current?.dispatch({ effects: [collabCompartment.reconfigure([]), historyCompartment.reconfigure(history())] });
      session.destroy();
    };
  }, [collab?.id, resetKey, readOnly, onCollab]);

  // Vim：开了才去下那两百 KB。加载失败就当没开，并把 null 报上去让外面提示。
  useEffect(() => {
    let alive = true;
    vimOn.current = vim;
    if (!vim) {
      view.current?.dispatch({ effects: vimCompartment.reconfigure([]) });
      onVimMode?.(null);
      return;
    }
    void loadVim().then(mod => {
      if (!alive || !view.current) return;
      if (!mod) { vimOn.current = false; onVimMode?.(null); return; }
      view.current.dispatch({ effects: vimCompartment.reconfigure(vimExtension(mod, () => latest.current.onSave?.())) });
      onVimMode?.(vimModeOf(view.current));
    });
    return () => { alive = false; };
  }, [vim, onVimMode, resetKey]);

  return <div ref={host} className={className} data-editor="markdown" data-wysiwyg={effectiveWysiwyg ? "1" : undefined} data-vim={vim ? "1" : undefined} />;
}
