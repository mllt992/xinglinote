import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, RangeSet, StateField } from "@codemirror/state";
import type { SyntaxNodeRef } from "@lezer/common";
import {
  Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate,
} from "@codemirror/view";
import { diagramBlockAt, taskAnchorSuffixStart } from "@kb/shared/markdown";
import type { RenderToggles } from "../lib/layout-prefs";
import { followHandler } from "./link-follow";
import {
  ALL_ON,
  type BlockBuilt,
  type Built,
  CheckboxWidget,
  DiagramWidget,
  ImageWidget,
  MathWidget,
  RuleWidget,
  TableWidget,
  TextWidget,
  blockFirst,
  blockLast,
  calloutLine,
  calloutTypeOf,
  codeLine,
  hasUrl,
  headingLine,
  hide,
  isDestinationUrl,
  quoteLine,
  revealer,
  wholeLines,
} from "./live-preview-widgets";

function blockField(wysiwyg: boolean, noteId: string, render: RenderToggles) {
  const build = (state: EditorState): BlockBuilt => {
    const ranges: Range<Decoration>[] = [];
    const spans: Array<{ from: number; to: number }> = [];
    const revealed = revealer(state, wysiwyg);
    syntaxTree(state).iterate({
      enter: node => {
        if (node.name === "FencedCode") {
          if (!render.diagram || !wysiwyg || !wholeLines(state, node.from, node.to)) return false;
          const block = diagramBlockAt(state.doc.sliceString(node.from, node.to), 0);
          if (!block?.source.trim()) return false;
          spans.push({ from: node.from, to: node.to });
          if (!revealed(node.from, node.to)) {
            ranges.push(Decoration.replace({ widget: new DiagramWidget(block.source), block: true }).range(node.from, node.to));
          }
          return false;
        }
        if (node.name === "Paragraph" || node.name === "CodeBlock") return false;
        if (node.name === "BlockMath") {
          if (!render.math || !wholeLines(state, node.from, node.to)) return false;
          const raw = state.doc.sliceString(node.from, node.to).trim();
          if (!raw.endsWith("$$") || raw.length <= 4) return false;
          const body = raw.slice(2, -2).trim();
          if (!body) return false;
          spans.push({ from: node.from, to: node.to });
          if (!revealed(node.from, node.to)) {
            ranges.push(Decoration.replace({ widget: new MathWidget(body, true), block: true }).range(node.from, node.to));
          }
          return false;
        }
        if (node.name === "Table") {
          if (!render.table || !wysiwyg || !wholeLines(state, node.from, node.to)) return;
          spans.push({ from: node.from, to: node.to });
          if (revealed(node.from, node.to)) return;
          ranges.push(Decoration.replace({ widget: new TableWidget(state.doc.sliceString(node.from, node.to), noteId, !state.readOnly), block: true }).range(node.from, node.to));
          return false;
        }
        return;
      },
    });
    return { decorations: Decoration.set(ranges, true), spans };
  };
  return StateField.define<BlockBuilt>({
    create: build,
    update: (value, tr) => {
      if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return build(tr.state);
      if (!tr.selection) return value;
      const before = revealer(tr.startState, wysiwyg);
      const after = revealer(tr.state, wysiwyg);
      const flipped = value.spans.some(span => before(span.from, span.to) !== after(span.from, span.to));
      return flipped ? build(tr.state) : value;
    },
    provide: field => [
      EditorView.decorations.from(field, value => value.decorations),
      EditorView.atomicRanges.of(view => view.state.field(field, false)?.decorations ?? RangeSet.empty),
    ],
  });
}

function build(view: EditorView, wysiwyg: boolean, render: RenderToggles): Built {
  const marks: Range<Decoration>[] = [];
  const atoms: Range<Decoration>[] = [];
  const replace = (deco: Decoration, from: number, to: number) => {
    if (from >= to) return;
    marks.push(deco.range(from, to));
    atoms.push(deco.range(from, to));
  };

  const { state } = view;
  const tree = syntaxTree(state);
  const base = revealer(state, wysiwyg);

  const scopes: Array<{ from: number; to: number }> = [];
  const seen = new Set<string>();
  const revealed = (from: number, to: number) => {
    const key = `${from}:${to}`;
    if (!seen.has(key)) { seen.add(key); scopes.push({ from, to }); }
    return base(from, to);
  };

  const owner = (node: SyntaxNodeRef) => {
    const parent = node.node.parent;
    return parent ? { from: parent.from, to: parent.to } : { from: node.from, to: node.to };
  };

  const lineDecos = (from: number, to: number, deco: Decoration, limit: { from: number; to: number }) => {
    const first = state.doc.lineAt(from).from;
    const last = state.doc.lineAt(to).from;
    let pos = Math.max(from, limit.from);
    const end = Math.min(to, limit.to);
    while (pos <= end) {
      const line = state.doc.lineAt(pos);
      marks.push(deco.range(line.from));
      if (line.from === first) marks.push(blockFirst.range(line.from));
      if (line.from === last) marks.push(blockLast.range(line.from));
      if (line.to >= end) break;
      pos = line.to + 1;
    }
  };

  const anchoredLines = new Set<number>();
  for (const visible of view.visibleRanges) {
    let pos = state.doc.lineAt(visible.from).from;
    while (pos <= visible.to) {
      const line = state.doc.lineAt(pos);
      if (!anchoredLines.has(line.number) && /^\s*[-*+]\s+\[[ xX]\]/.test(line.text)) {
        const at = taskAnchorSuffixStart(line.text);
        if (at !== null) replace(hide, line.from + at, line.to);
        anchoredLines.add(line.number);
      }
      if (line.to >= visible.to || line.to === state.doc.length) break;
      pos = line.to + 1;
    }
    tree.iterate({
      from: visible.from,
      to: visible.to,
      enter: node => {
        const line = state.doc.lineAt(node.from);

        switch (node.name) {
          case "ATXHeading1": case "ATXHeading2": case "ATXHeading3":
          case "ATXHeading4": case "ATXHeading5": case "ATXHeading6":
          case "SetextHeading1": case "SetextHeading2":
            marks.push(headingLine.range(state.doc.lineAt(node.from).from));
            return;
          case "HeaderMark": {
            const scope = wysiwyg ? owner(node) : { from: line.from, to: line.to };
            if (revealed(scope.from, scope.to)) return;
            let to = node.to;
            while (to < line.to && state.doc.sliceString(to, to + 1) === " ") to++;
            replace(hide, node.from, to);
            return;
          }
          case "EmphasisMark":
          case "HighlightMark":
          case "StrikethroughMark": {
            const scope = wysiwyg ? owner(node) : { from: line.from, to: line.to };
            if (!revealed(scope.from, scope.to)) replace(hide, node.from, node.to);
            return;
          }
          case "CodeMark": {
            if (node.node.parent?.name !== "InlineCode") return;
            const scope = wysiwyg ? owner(node) : { from: line.from, to: line.to };
            if (!revealed(scope.from, scope.to)) replace(hide, node.from, node.to);
            return;
          }
          case "QuoteMark":
            if (!revealed(line.from, line.to)) replace(hide, node.from, node.to);
            return;
          case "Highlight":
            marks.push(Decoration.mark({ class: "cm-md-mark" }).range(node.from, node.to));
            return;
          case "FootnoteRef":
            marks.push(Decoration.mark({ class: "cm-md-footnote" }).range(node.from, node.to));
            return false;
          case "Blockquote": {
            const type = calloutTypeOf(state.doc.lineAt(node.from).text);
            lineDecos(node.from, node.to, type ? calloutLine(type) : quoteLine, visible);
            return;
          }
          case "FencedCode":
          case "CodeBlock":
            lineDecos(node.from, node.to, codeLine, visible);
            return;
          case "LinkMark":
          case "URL":
          case "LinkTitle": {
            const parent = node.node.parent;
            if (parent?.name !== "Link" || !hasUrl(parent)) return;
            if (node.name === "URL" && !isDestinationUrl(node.node)) return;
            const scope = wysiwyg ? owner(node) : { from: line.from, to: line.to };
            if (!revealed(scope.from, scope.to)) replace(hide, node.from, node.to);
            return;
          }
          case "Link": {
            if (!hasUrl(node.node)) return;
            const scope = wysiwyg ? { from: node.from, to: node.to } : { from: line.from, to: line.to };
            if (!revealed(scope.from, scope.to)) {
              marks.push(Decoration.mark({ class: "cm-md-link", attributes: { title: "Ctrl/⌘ + 单击打开" } }).range(node.from, node.to));
            }
            return;
          }
          case "Image": {
            if (!render.image || revealed(node.from, node.to)) return false;
            const parsed = /^!\[([^\]]*)\]\(([^)\s]+)/.exec(state.doc.sliceString(node.from, node.to));
            if (parsed) replace(Decoration.replace({ widget: new ImageWidget(parsed[2], parsed[1]) }), node.from, node.to);
            return false;
          }
          case "WikiLink": {
            if (revealed(node.from, node.to)) return false;
            const embed = state.doc.sliceString(node.from, node.from + 1) === "!";
            const innerFrom = node.from + (embed ? 3 : 2);
            const innerTo = node.to - 2;
            if (innerFrom >= innerTo) return false;
            replace(hide, node.from, innerFrom);
            replace(hide, innerTo, node.to);
            const pipe = state.doc.sliceString(innerFrom, innerTo).indexOf("|");
            if (pipe >= 0) replace(hide, innerFrom, innerFrom + pipe + 1);
            marks.push(Decoration.mark({
              class: embed ? "cm-md-wiki cm-md-wiki-embed" : "cm-md-wiki",
              attributes: { "data-wiki-from": String(node.from), title: "Ctrl/⌘ + 单击打开" },
            }).range(pipe >= 0 ? innerFrom + pipe + 1 : innerFrom, innerTo));
            return false;
          }
          case "InlineMath": {
            if (!render.math || revealed(node.from, node.to)) return false;
            replace(Decoration.replace({ widget: new MathWidget(state.doc.sliceString(node.from + 1, node.to - 1)) }), node.from, node.to);
            return false;
          }
          case "BlockMath":
            return false;
          case "Table":
            return render.table && wysiwyg && !revealed(node.from, node.to) ? false : undefined;
          case "TaskMarker": {
            const checked = state.doc.sliceString(node.from + 1, node.to - 1).trim().toLowerCase() === "x";
            replace(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }), node.from, node.to);
            return false;
          }
          case "ListMark": {
            const mark = state.doc.sliceString(node.from, node.to);
            if (mark !== "-" && mark !== "*" && mark !== "+") return;
            if (!wysiwyg && revealed(line.from, line.to)) return;
            replace(Decoration.replace({ widget: new TextWidget("•", "cm-md-bullet") }), node.from, node.to);
            return;
          }
          case "HorizontalRule":
            if (!revealed(line.from, line.to)) replace(Decoration.replace({ widget: new RuleWidget() }), node.from, node.to);
            return;
          default:
            return;
        }
      },
    });
  }
  return { decorations: Decoration.set(marks, true), atomic: Decoration.set(atoms, true), scopes };
}

function decorator(wysiwyg: boolean, render: RenderToggles) {
  return ViewPlugin.fromClass(
    class {
      built: Built;
      constructor(view: EditorView) { this.built = build(view, wysiwyg, render); }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged
          || syntaxTree(update.startState) !== syntaxTree(update.state)) {
          this.built = build(update.view, wysiwyg, render);
          return;
        }
        if (!update.selectionSet) return;
        const before = revealer(update.startState, wysiwyg);
        const after = revealer(update.state, wysiwyg);
        if (this.built.scopes.some(scope => before(scope.from, scope.to) !== after(scope.from, scope.to))) {
          this.built = build(update.view, wysiwyg, render);
        }
      }
    },
    {
      decorations: p => p.built.decorations,
      provide: p => EditorView.atomicRanges.of(view => view.plugin(p)?.built.atomic ?? RangeSet.empty),
    },
  );
}

export function livePreview(
  onWiki: ((title: string, section?: string) => void) | undefined,
  wysiwyg: boolean,
  noteId = "",
  render: RenderToggles = ALL_ON,
): Extension {
  return [blockField(wysiwyg, noteId, render), decorator(wysiwyg, render), followHandler(onWiki)];
}

export { wikiAt } from "./link-follow";
