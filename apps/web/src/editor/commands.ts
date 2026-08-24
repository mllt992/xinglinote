import { indentLess, indentMore } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type ChangeSpec, type EditorState } from "@codemirror/state";
import type { Command } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

/** 选区两侧是不是已经被 marker 包着。`*` 要额外躲开 `**`，否则给粗体加斜体会把粗体拆坏。 */
export function wrappedWith(state: EditorState, from: number, to: number, marker: string): boolean {
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

/** 所选行在「普通行 → 待办 → 已办 → 普通列表项」之间轮转。 */
export const toggleTask: Command = view => {
  if (view.state.readOnly) return false;
  const changes: ChangeSpec[] = [];
  for (const number of selectedLines(view.state)) {
    const line = view.state.doc.line(number);
    const bullet = BULLET.exec(line.text);
    const indent = /^\s*/.exec(line.text)?.[0].length ?? 0;
    if (!bullet) {
      changes.push({ from: line.from + indent, insert: "- [ ] " });
      continue;
    }
    const markerEnd = line.from + bullet[0].length;
    const box = CHECKBOX.exec(line.text.slice(bullet[0].length));
    if (!box) changes.push({ from: markerEnd, insert: "[ ] " });
    else if (box[0].startsWith("[ ]")) changes.push({ from: markerEnd + 1, to: markerEnd + 2, insert: "x" });
    else changes.push({ from: markerEnd, to: markerEnd + box[0].length });
  }
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: "input.task", scrollIntoView: true });
  return true;
};

/** 设置所选行的标题层级；0 表示恢复正文。 */
export function setHeading(level: 0 | 1 | 2 | 3 | 4 | 5 | 6): Command {
  return view => {
    if (view.state.readOnly) return false;
    const changes: ChangeSpec[] = [];
    for (const number of selectedLines(view.state)) {
      const line = view.state.doc.line(number);
      const indent = /^\s*/.exec(line.text)?.[0].length ?? 0;
      const heading = /^#{1,6}[ \t]+/.exec(line.text.slice(indent));
      const from = line.from + indent;
      const to = from + (heading?.[0].length ?? 0);
      const insert = level ? `${"#".repeat(level)} ` : "";
      if (view.state.sliceDoc(from, to) !== insert) changes.push({ from, to, insert });
    }
    if (!changes.length) return false;
    view.dispatch({ changes, userEvent: "input.heading", scrollIntoView: true });
    return true;
  };
}

/** 代码围栏可切换；有选区时包住选区，无选区时把光标放到空围栏里。 */
export const toggleCodeBlock: Command = view => {
  if (view.state.readOnly) return false;
  view.dispatch(
    view.state.changeByRange(range => {
      const startLine = view.state.doc.lineAt(range.from);
      const endLine = view.state.doc.lineAt(range.to);
      const before = startLine.number > 1 ? view.state.doc.line(startLine.number - 1) : null;
      const after = endLine.number < view.state.doc.lines ? view.state.doc.line(endLine.number + 1) : null;
      if (before && after && /^\s*```[^`]*$/.test(before.text) && /^\s*```\s*$/.test(after.text)) {
        return {
          changes: [
            { from: before.from, to: startLine.from },
            { from: endLine.to, to: after.to },
          ],
          range: EditorSelection.range(before.from, endLine.to - (startLine.from - before.from)),
        };
      }
      const text = view.state.sliceDoc(range.from, range.to);
      const beforeBreak = range.from === startLine.from ? "" : "\n";
      const afterBreak = range.to === endLine.to ? "" : "\n";
      const insert = `${beforeBreak}\`\`\`\n${text}\n\`\`\`${afterBreak}`;
      const contentFrom = range.from + beforeBreak.length + 4;
      const contentTo = contentFrom + text.length;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: text ? EditorSelection.range(contentFrom, contentTo) : EditorSelection.cursor(contentFrom),
      };
    }),
    { userEvent: "input.codeblock", scrollIntoView: true },
  );
  return true;
};

/** 插入一个独占行块，必要时自动补换行。 */
export function insertBlock(text: string, cursorOffset = text.length): Command {
  return view => {
    if (view.state.readOnly) return false;
    const range = view.state.selection.main;
    const line = view.state.doc.lineAt(range.from);
    const before = range.from === line.from ? "" : "\n";
    const after = range.to === view.state.doc.length || view.state.sliceDoc(range.to, range.to + 1) === "\n" ? "" : "\n";
    const insert = `${before}${text}${after}`;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: EditorSelection.cursor(range.from + before.length + cursorOffset),
      userEvent: "input.block",
      scrollIntoView: true,
    });
    return true;
  };
}

/** 上传等宿主异步操作完成后，把结果插回原编辑器选区并进入同一份历史。 */
export function insertTextAtSelection(text: string, userEvent = "input.insert"): Command {
  return view => {
    if (view.state.readOnly) return false;
    view.dispatch(
      view.state.changeByRange(range => ({
        changes: { from: range.from, to: range.to, insert: text },
        range: EditorSelection.cursor(range.from + text.length),
      })),
      { userEvent, scrollIntoView: true },
    );
    return true;
  };
}

/**
 * Tab 的归属。
 *
 * 老写法是无条件的 `indentWithTab`，那是键盘无障碍里的经典陷阱：Tab 键被编辑器吃掉，
 * 只用键盘的人进得来出不去（CodeMirror 官方文档专门提醒过）。
 *
 * 所以只在**确实有东西可缩进**时才接管：光标在列表项里、在代码块里、或者选中了多行。
 * 其余情况一律放行，Tab 照常把焦点移到下一个控件。
 */
function structural(state: EditorState): boolean {
  const { main } = state.selection;
  if (state.doc.lineAt(main.from).number !== state.doc.lineAt(main.to).number) return true;
  if (BULLET.test(state.doc.lineAt(main.head).text)) return true;
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(main.head, -1);
  for (; node; node = node.parent) {
    if (node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "CodeText") return true;
  }
  return false;
}

export const structuralTab: Command = view => (structural(view.state) ? indentMore(view) : false);
export const structuralShiftTab: Command = view => (structural(view.state) ? indentLess(view) : false);
