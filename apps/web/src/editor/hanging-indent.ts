/**
 * 列表的悬挂缩进（设计 17 §3.7）。
 *
 * 软换行默认把折下来的那一行顶回第 0 列，于是一条三行长的列表项看起来像三条并列的段落，
 * 中文长句尤其乱。这里给列表行加 `padding-left` 再用等量的负 `text-indent` 把首行拉回去：
 * 首行原地不动，折行对齐到正文起点。
 *
 * **只做列表**，不做引用：引用行已经由 `.cm-md-quote-line` 整行加了 padding，
 * 首行与折行本来就对齐；再叠一层负缩进反而会把首行拽到左边条上去。
 *
 * 纯显示，不动一个字节。
 */
import { syntaxTree } from "@codemirror/language";
import type { Extension, Range } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/** 缩进 + 列表标记 + 空格（+ 可选的任务复选框）。捕获到的整段长度就是要悬挂的宽度。 */
const LIST_PREFIX = /^(\s*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX ]\][ \t]+)?)/;

/** 缓存行装饰，宽度相同的行共用一个，省得每行造一个新对象。 */
const cache = new Map<number, Decoration>();
function hang(width: number): Decoration {
  let deco = cache.get(width);
  if (!deco) {
    deco = Decoration.line({
      class: "cm-md-hang",
      // text-indent 作用在首行盒上，被替换成小部件的标记也一起跟着左移，所以首行仍在原位
      attributes: { style: `padding-left:${width}ch;text-indent:-${width}ch` },
    });
    cache.set(width, deco);
  }
  return deco;
}

/** 代码块里的 `- ` 是代码不是列表，别给它加缩进。 */
function inCode(view: EditorView, pos: number): boolean {
  let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1);
  for (; node; node = node.parent) {
    if (node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "CodeText") return true;
  }
  return false;
}

function build(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const visible of view.visibleRanges) {
    let pos = visible.from;
    for (;;) {
      const line = view.state.doc.lineAt(pos);
      const hit = LIST_PREFIX.exec(line.text);
      // 制表符按 4 列算，和 CodeMirror 默认的 tabSize 对上
      if (hit && !inCode(view, line.from)) {
        const width = hit[1].replace(/\t/g, "    ").length;
        if (width > 0 && width <= 40) ranges.push(hang(width).range(line.from));
      }
      if (line.to >= visible.to) break;
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

export function hangingIndent(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) { this.decorations = build(view); }
      update(update: ViewUpdate) {
        // 选区变化不影响缩进宽度，别跟着重建
        if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
          this.decorations = build(update.view);
        }
      }
    },
    { decorations: p => p.decorations },
  );
}
