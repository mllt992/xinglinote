import type { MarkdownIt } from "markdown-it";

/**
 * GFM 任务列表。给每个复选框标上它在源码里的行号，宿主据此就地改一个字符完成勾选，
 * 不必重排全文——勾选算一次保存（设计 03 §4.7）。
 */
export function taskListPlugin(md: MarkdownIt) {
  md.core.ruler.after("inline", "tasklist", state => {
    const tokens = state.tokens;
    const interactive = (state.env as { interactiveTasks?: boolean } | undefined)?.interactiveTasks === true;
    const listStack: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const type = tokens[i].type;
      if (type === "bullet_list_open" || type === "ordered_list_open") { listStack.push(i); continue; }
      if (type === "bullet_list_close" || type === "ordered_list_close") { listStack.pop(); continue; }
      if (type !== "inline" || i < 2) continue;
      if (tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open") continue;

      const inline = tokens[i];
      const marker = /^\[([ xX])\]([ \t]+|$)/.exec(inline.content);
      if (!marker) continue;
      const checked = marker[1] !== " ";
      const line = tokens[i - 2].map?.[0] ?? -1;

      inline.content = inline.content.slice(marker[0].length);
      const first = inline.children?.[0];
      if (first?.type === "text") first.content = first.content.slice(marker[0].length);

      const box = new state.Token("html_inline", "", 0);
      box.content = `<input class="task-checkbox" type="checkbox"${checked ? " checked" : ""}${interactive ? "" : " disabled"} data-task-line="${line}">`;
      inline.children?.unshift(box);

      tokens[i - 2].attrJoin("class", checked ? "task-item done" : "task-item");
      const list = listStack[listStack.length - 1];
      // 一个列表里可能有多个任务项，外层 ul/ol 的类名只加一次。
      if (list !== undefined && !/(^|\s)task-list(\s|$)/.test(String(tokens[list].attrGet("class") ?? ""))) {
        tokens[list].attrJoin("class", "task-list");
      }
    }
  });
}

/** 就地翻转第 line 行的 `[ ]` / `[x]`，其余字节不动。行号越界或不是任务行时返回原文。 */
export function toggleTaskAt(source: string, line: number): string {
  const lines = source.split("\n");
  const target = lines[line];
  if (target === undefined) return source;
  const next = target.replace(/^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/, (_all, head: string, mark: string, tail: string) =>
    `${head}${mark === " " ? "x" : " "}${tail}`);
  if (next === target) return source;
  lines[line] = next;
  return lines.join("\n");
}
