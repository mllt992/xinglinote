import { useEffect, useRef } from "react";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { bracketMatching, foldKeymap, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, Prec } from "@codemirror/state";
import {
  EditorView, crosshairCursor, drawSelection, dropCursor,
  keymap, placeholder as placeholderExt, rectangularSelection,
} from "@codemirror/view";
import { fileDrop, type FileUploader } from "./attachments";
import { insertLink, insertWikiLink, structuralTab, structuralShiftTab, toggleLinePrefix, toggleTask } from "./commands";
import { markdownFolding } from "./folding";
import { hangingIndent } from "./hanging-indent";
import { markdownSyntaxExtensions } from "./markdown-syntax";
import { smartPaste } from "./paste";
import { tableTextSelection } from "./table-edit";
import { slashCompletion } from "./slash-menu";
import { typewriterScroll } from "./typewriter";
import { editorHighlighting, editorTheme } from "./theme";
import { createCollab, type CollabPeer, type CollabSession, type CollabStatus, type CollabUser } from "./collab";
import { cachedVim, loadVim, vimExtension, vimModeOf, type VimMode } from "./vim";
import { wikiCompletion, type WikiCompleteOptions } from "./wiki-complete";
import { wikiHover, type WikiPreviewLoader } from "./wiki-hover";
import type { RenderToggles } from "../lib/layout-prefs";
import { editorWysiwyg, type EditorPreviewMode } from "../lib/editor-mode";
import { attachSpotPersistence, readSpot, rememberSpot, restoreSpot } from "./editor-spots";
import {
  collabCompartment,
  historyCompartment,
  livePreviewCompartment,
  previewExtensions,
  readOnlyCompartment,
  spellcheckCompartment,
  vimCompartment,
  wrapOrTable,
  ALL_ON,
  contentAttrs,
} from "./markdown-editor-helpers";
import { useMarkdownEditorHandle } from "./markdown-editor-handle";
import type { MarkdownEditorHandle } from "./markdown-editor-types";

export type { EditorAction } from "./markdown-editor-helpers";
export type { MarkdownEditorHandle } from "./markdown-editor-types";

export function MarkdownEditor({
  value,
  onChange,
  onSave,
  onSelection,
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
  onSave?: () => void;
  onSelection?: (selection: { text: string; from: number; to: number }) => void;
  onWiki?: (title: string, section?: string) => void;
  onUpload?: FileUploader;
  onScrollLine?: (line: number) => void;
  onCursor?: (info: { line: number; col: number; selected: number }) => void;
  completion?: WikiCompleteOptions;
  wikiPreview?: WikiPreviewLoader;
  typewriter?: boolean;
  previewMode?: EditorPreviewMode;
  render?: RenderToggles;
  vim?: boolean;
  onVimMode?: (mode: VimMode | null) => void;
  spellcheck?: boolean;
  collab?: CollabUser | null;
  onCollab?: (info: { status: CollabStatus; peers: CollabPeer[] }) => void;
  readOnly?: boolean;
  placeholder?: string;
  resetKey?: string;
  className?: string;
  autoFocus?: boolean;
  ref?: React.Ref<MarkdownEditorHandle>;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ onChange, onSave, onSelection, onWiki, onUpload, onScrollLine, onCursor, onVimMode, completion, typewriter, wikiPreview });
  latest.current = { onChange, onSave, onSelection, onWiki, onUpload, onScrollLine, onCursor, onVimMode, completion, typewriter, wikiPreview };
  const mine = useRef(value);
  const vimOn = useRef(vim);
  const collabSession = useRef<CollabSession | null>(null);
  const lastQuoteSel = useRef<{ text: string; from: number; to: number } | null>(null);
  const peers = useRef<CollabPeer[]>([]);
  const status = useRef<CollabStatus>("offline");
  const effectiveWysiwyg = editorWysiwyg(previewMode);

  useMarkdownEditorHandle(ref, view, collabSession, lastQuoteSel);

  useEffect(() => {
    if (!host.current) return;
    lastQuoteSel.current = null;
    const spot = readSpot(resetKey ?? "");
    const clamp = (n: number) => Math.min(Math.max(n, 0), value.length);
    const instance = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        selection: spot ? { anchor: clamp(spot.anchor), head: clamp(spot.head) } : undefined,
        extensions: [
          Prec.highest(keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => { latest.current.onSave?.(); return true; } },
            { key: "Mod-b", run: v => { wrapOrTable(v, "**"); return true; } },
            { key: "Mod-i", run: v => { wrapOrTable(v, "*"); return true; } },
            { key: "Mod-e", run: v => { wrapOrTable(v, "`"); return true; } },
            { key: "Mod-Shift-x", run: v => { wrapOrTable(v, "~~"); return true; } },
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
              if (from !== to) {
                const selection = { text: update.state.sliceDoc(from, to), from, to };
                lastQuoteSel.current = selection;
                latest.current.onSelection?.(selection);
              }
              const report = latest.current.onCursor;
              if (report) {
                const line = update.state.doc.lineAt(head);
                report({ line: line.number, col: head - line.from + 1, selected: to - from });
              }
              if (vimOn.current) latest.current.onVimMode?.(vimModeOf(update.view));
              if (update.selectionSet) rememberSpot(resetKey ?? "", update.view);
            }
          }),
        ],
      }),
    });
    view.current = instance;
    const rememberTableSelection = () => {
      const selection = tableTextSelection(instance);
      if (!selection) return;
      lastQuoteSel.current = selection;
      latest.current.onSelection?.(selection);
    };
    instance.dom.ownerDocument.addEventListener("selectionchange", rememberTableSelection);
    mine.current = value;
    if (autoFocus) instance.focus();
    if (spot) window.setTimeout(() => { if (instance.dom.isConnected) restoreSpot(resetKey ?? "", instance); }, 0);

    const report = () => {
      const notify = latest.current.onScrollLine;
      if (!notify) return;
      const box = instance.scrollDOM.getBoundingClientRect();
      const pos = instance.posAtCoords({ x: box.left + 12, y: box.top + 4 }, false);
      notify(instance.state.doc.lineAt(pos).number - 1);
    };
    instance.scrollDOM.addEventListener("scroll", report, { passive: true });
    const detachSpot = attachSpotPersistence(resetKey ?? "", instance);

    return () => {
      instance.dom.ownerDocument.removeEventListener("selectionchange", rememberTableSelection);
      instance.scrollDOM.removeEventListener("scroll", report);
      detachSpot();
      instance.destroy();
      view.current = null;
    };
  }, [resetKey]);

  useEffect(() => {
    const instance = view.current;
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

  useEffect(() => {
    if (!collab || readOnly) { onCollab?.({ status: "offline", peers: [] }); return; }
    let alive = true;
    const session = createCollab(resetKey ?? "", collab, {
      status: s => { if (!alive) return; status.current = s; onCollab?.({ status: s, peers: peers.current }); },
      peers: list => { if (!alive) return; peers.current = list; onCollab?.({ status: status.current, peers: list }); },
      synced: text => {
        if (!alive || !view.current) return;
        if (!text.toString() && mine.current) text.insert(0, mine.current);
        collabSession.current = session;
        view.current.dispatch({
          effects: [
            collabCompartment.reconfigure(session!.extension),
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
