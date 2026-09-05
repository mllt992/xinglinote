import type { MutableRefObject, Ref } from "react";
import { useImperativeHandle } from "react";
import { redoDepth, undoDepth } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { insertTextAtSelection } from "./commands";
import { tableCellAtSourceOffset, tableTextSelection } from "./table-edit";
import type { CollabSession } from "./collab";
import { pulseLocatedElement } from "../lib/locate-highlight";
import { ACTIONS, activeActions } from "./markdown-editor-helpers";
import type { MarkdownEditorHandle } from "./markdown-editor-types";

export type { MarkdownEditorHandle } from "./markdown-editor-types";

export function useMarkdownEditorHandle(
  ref: Ref<MarkdownEditorHandle> | undefined,
  view: MutableRefObject<EditorView | null>,
  collabSession: MutableRefObject<CollabSession | null>,
  lastQuoteSel: MutableRefObject<{ text: string; from: number; to: number } | null>,
) {
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
    locateRange: (from, to) => {
      const instance = view.current;
      if (!instance) return;
      const max = instance.state.doc.length;
      const start = Math.min(Math.max(from, 0), max);
      const end = Math.min(Math.max(to, start), max);
      let node: SyntaxNode | null = syntaxTree(instance.state).resolveInner(start, 1);
      while (node && node.name !== "Table") node = node.parent;
      if (node?.name === "Table" && end <= node.to) {
        const source = instance.state.sliceDoc(node.from, node.to);
        const cell = tableCellAtSourceOffset(source, start - node.from);
        for (const widget of Array.from(instance.dom.querySelectorAll<HTMLElement>(".cm-md-table"))) {
          let widgetFrom = -1;
          try { widgetFrom = instance.posAtDOM(widget); } catch { continue; }
          if (widgetFrom !== node.from) continue;
          const row = cell ? widget.querySelectorAll("tr")[cell.row] : null;
          const target = cell ? row?.querySelectorAll<HTMLElement>(":scope > th, :scope > td")[cell.col] : null;
          pulseLocatedElement(target ?? widget);
          return;
        }
      }
      instance.dispatch({ selection: { anchor: start, head: end }, effects: EditorView.scrollIntoView(start, { y: "center" }) });
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
}
