import { useEffect, useImperativeHandle, useRef } from "react";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, Prec } from "@codemirror/state";
import {
  EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine,
  keymap, placeholder as placeholderExt, rectangularSelection,
} from "@codemirror/view";
import { fileDrop, type FileUploader } from "./attachments";
import { insertLink, insertWikiLink, toggleLinePrefix, toggleTask, toggleWrap } from "./commands";
import { livePreview } from "./live-preview";
import { markdownSyntaxExtensions } from "./markdown-syntax";
import { slashCompletion } from "./slash-menu";
import { typewriterScroll } from "./typewriter";
import { editorHighlighting, editorTheme } from "./theme";
import { cachedVim, loadVim, vimExtension, vimModeOf, type VimMode } from "./vim";
import { wikiCompletion, type WikiCompleteOptions } from "./wiki-complete";

const readOnlyCompartment = new Compartment();
// 即时渲染要换掉整个装饰插件，用隔间热替换，省得为一个开关重建编辑器。
const livePreviewCompartment = new Compartment();
// Vim 是按需加载的，加载完才往这个隔间里塞，所以它天生就得是隔间而不是初始扩展。
const vimCompartment = new Compartment();

export type MarkdownEditorHandle = {
  /** 把某一源码行滚到视口顶部（0 基，和预览的 `data-line` 同一套编号）。 */
  scrollToLine: (line: number) => void;
  focus: () => void;
  /** 当前选区，没选中就是 null。偏移量和正文字符串一致，可以直接拿去切片。 */
  getSelection: () => { text: string; from: number; to: number } | null;
  /** 选中一段并滚过去，用来把「这条纠错说的是哪句」指出来。 */
  selectRange: (from: number, to: number) => void;
  /** 光标位置（字符偏移，和正文字符串同一套坐标）。编辑器没挂载时是 null。 */
  getCursorPos: () => number | null;
  /** 就地替换一段，光标落在插入内容末尾。`from === to` 就是纯插入。 */
  replaceRange: (from: number, to: number, text: string) => void;
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
  typewriter = false,
  wysiwyg = false,
  vim = false,
  onVimMode,
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
  /** 打字机滚动：光标行钉在视口中间。 */
  typewriter?: boolean;
  /** 即时渲染（Typora 那套）：标记按元素显隐、表格就地渲染、正文比例字体。 */
  wysiwyg?: boolean;
  /** Vim keymap。按需加载，关着的时候一个字节都不下。 */
  vim?: boolean;
  /** Vim 模式变了：底栏拿它显示 NORMAL / INSERT / VISUAL；关着时给 null。 */
  onVimMode?: (mode: VimMode | null) => void;
  readOnly?: boolean;
  placeholder?: string;
  /** 换一篇笔记时传新的 key，光标与滚动位置会重置。 */
  resetKey?: string;
  className?: string;
  autoFocus?: boolean;
  ref?: React.Ref<MarkdownEditorHandle>;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  // 这些回调每次渲染都是新函数，用 ref 兜住，免得为了它们重建整个编辑器。
  const latest = useRef({ onChange, onSave, onWiki, onUpload, onScrollLine, onCursor, onVimMode, completion, typewriter });
  latest.current = { onChange, onSave, onWiki, onUpload, onScrollLine, onCursor, onVimMode, completion, typewriter };
  const mine = useRef(value);
  const vimOn = useRef(vim);

  useImperativeHandle(ref, () => ({
    scrollToLine: line => {
      const instance = view.current;
      if (!instance) return;
      const total = instance.state.doc.lines;
      const target = instance.state.doc.line(Math.min(Math.max(line + 1, 1), total));
      instance.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: "start" }) });
    },
    focus: () => view.current?.focus(),
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
      if (!instance) return null;
      const { from, to } = instance.state.selection.main;
      return from === to ? null : { text: instance.state.sliceDoc(from, to), from, to };
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
  }), []);

  useEffect(() => {
    if (!host.current) return;
    const instance = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
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
          history(),
          drawSelection(),
          dropCursor(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
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
          livePreviewCompartment.of(livePreview((title, section) => latest.current.onWiki?.(title, section), wysiwyg, resetKey ?? "")),
          typewriterScroll(() => latest.current.typewriter === true),
          fileDrop(file => latest.current.onUpload?.(file) ?? Promise.resolve(null)),
          editorHighlighting,
          editorTheme,
          placeholderExt(placeholder),
          keymap.of([
            ...closeBracketsKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...completionKeymap,
            ...defaultKeymap,
            indentWithTab,
          ]),
          readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
          EditorView.updateListener.of(update => {
            if (update.docChanged) {
              const next = update.state.doc.toString();
              mine.current = next;
              latest.current.onChange(next);
            }
            if (update.docChanged || update.selectionSet) {
              const report = latest.current.onCursor;
              if (report) {
                const { head, from, to } = update.state.selection.main;
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
      instance.destroy();
      view.current = null;
    };
    // 只在换篇时重建。value / readOnly 的变化走下面两个 effect 增量同步，
    // 不然每敲一个字都会重建编辑器，光标、撤销栈、滚动位置全丢。
  }, [resetKey]);

  // 外部改了正文（冲突后加载对方版本、AI 写作、恢复历史版本、别处插入附件链接）。
  useEffect(() => {
    const instance = view.current;
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
      effects: livePreviewCompartment.reconfigure(livePreview((title, section) => latest.current.onWiki?.(title, section), wysiwyg, resetKey ?? "")),
    });
  }, [wysiwyg, resetKey]);

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

  return <div ref={host} className={className} data-editor="markdown" data-wysiwyg={wysiwyg ? "1" : undefined} data-vim={vim ? "1" : undefined} />;
}
