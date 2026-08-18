import { EditorSelection, type ChangeSpec, type EditorState } from "@codemirror/state";
import type { Command } from "@codemirror/view";

/** 选区两侧是不是已经被 marker 包着。`*` 要额外躲开 `**`，否则给粗体加斜体会把粗体拆坏。 */
function wrappedWith(state: EditorState, from: number, to: number, marker: string): boolean {
  const len = marker.length;
  if (from - len < 0) return false;
  if (state.sliceDoc(from - len, from) !== marker || state.sliceDoc(to, to + len) !== marker) return false;
  if (marker === "*" && from - 2 >= 0 && state.sliceDoc(from - 2, from) === "**" && state.sliceDoc(to, to + 2) === "**") return false;
  return true;
}

/**
 * 包裹类标记（`**`、`*`、`` ` ``、`~~`）。已经包着就脱掉，选区为空就插一对把光标放中间。
 * 只动标记本身，不重排别的字节——版本 diff 得干净（设计 03 §3.6）。
 */
export function toggleWrap(marker: string): Command {
  return view => {
    if (view.state.readOnly) return false;
    const len = marker.length;
    view.dispatch(
      view.state.changeByRange(range => {
        if (wrappedWith(view.state, range.from, range.to, marker)) {
          return {
            changes: [
              { from: range.from - len, to: range.from },
              { from: range.to, to: range.to + len },
            ],
            range: EditorSelection.range(range.from - len, range.to - len),
          };
        }
        return {
          changes: [
            { from: range.from, insert: marker },
            { from: range.to, insert: marker },
          ],
          range: EditorSelection.range(range.from + len, range.to + len),
        };
      }),
      { userEvent: "input.wrap", scrollIntoView: true },
    );
    return true;
  };
}

/** 选中文字变成链接文本，光标停在括号里等着粘地址。 */
export const insertLink: Command = view => {
  if (view.state.readOnly) return false;
  view.dispatch(
    view.state.changeByRange(range => {
      const insert = `[${view.state.sliceDoc(range.from, range.to)}]()`;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + insert.length - 1),
      };
    }),
    { userEvent: "input.link", scrollIntoView: true },
  );
  return true;
};

/** `[[…]]`，光标落在里面，补全菜单随后接手。 */
export const insertWikiLink: Command = view => {
  if (view.state.readOnly) return false;
  view.dispatch(
    view.state.changeByRange(range => {
      const text = view.state.sliceDoc(range.from, range.to);
      return {
        changes: { from: range.from, to: range.to, insert: `[[${text}]]` },
        range: EditorSelection.cursor(range.from + 2 + text.length),
      };
    }),
    { userEvent: "input.wikilink", scrollIntoView: true },
  );
  return true;
};

/** 选区覆盖到的所有行号。 */
function selectedLines(state: EditorState): number[] {
  const numbers = new Set<number>();
  for (const range of state.selection.ranges) {
    let pos = range.from;
    for (;;) {
      const line = state.doc.lineAt(pos);
      numbers.add(line.number);
      if (line.to >= range.to) break;
      pos = line.to + 1;
    }
  }
  return [...numbers];
}

/**
 * 行首标记（`> `、`- `）：整段都已经有了就一起去掉，否则一起加上。
 * 标记插在缩进之后，不破坏列表层级。
 */
export function toggleLinePrefix(prefix: string, existing: RegExp): Command {
  return view => {
    if (view.state.readOnly) return false;
    const { state } = view;
    const lines = selectedLines(state).map(n => state.doc.line(n));
    if (!lines.length) return false;
    const hits = lines.map(line => existing.exec(line.text));
    const remove = hits.every(hit => hit !== null);
    const changes: ChangeSpec[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hit = hits[i];
      const indent = /^\s*/.exec(line.text)?.[0].length ?? 0;
      if (remove && hit) changes.push({ from: line.from + indent, to: line.from + hit[0].length });
      else if (!remove && hit) changes.push({ from: line.from + indent, to: line.from + hit[0].length, insert: prefix });
      else if (!remove) changes.push({ from: line.from + indent, insert: prefix });
    }
    if (!changes.length) return false;
    view.dispatch({ changes, userEvent: "input.prefix", scrollIntoView: true });
    return true;
  };
}

const BULLET = /^\s*(?:[-*+]|\d+[.)])[ \t]+/;
const CHECKBOX = /^\[[ xX]\][ \t]?/;

/** 光标所在行在「普通行 → 待办 → 已办 → 普通列表项」之间轮转。 */
export const toggleTask: Command = view => {
  if (view.state.readOnly) return false;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const bullet = BULLET.exec(line.text);
  const indent = /^\s*/.exec(line.text)?.[0].length ?? 0;

  if (!bullet) {
    view.dispatch({ changes: { from: line.from + indent, insert: "- [ ] " }, userEvent: "input.task", scrollIntoView: true });
    return true;
  }
  const markerEnd = line.from + bullet[0].length;
  const box = CHECKBOX.exec(line.text.slice(bullet[0].length));
  if (!box) {
    view.dispatch({ changes: { from: markerEnd, insert: "[ ] " }, userEvent: "input.task", scrollIntoView: true });
    return true;
  }
  if (box[0].startsWith("[ ]")) {
    // 只翻那一个字符，别的字节不动。
    view.dispatch({ changes: { from: markerEnd + 1, to: markerEnd + 2, insert: "x" }, userEvent: "input.task" });
    return true;
  }
  view.dispatch({ changes: { from: markerEnd, to: markerEnd + box[0].length }, userEvent: "input.task" });
  return true;
};
