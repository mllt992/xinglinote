import type { MarkdownIt } from "markdown-it";

const TASK_ANCHOR_SUFFIX = /[ \t]+\^tk-[0-9a-f]{8}[ \t]*$/;

/** 系统写在任务行末尾的稳定块锚。显示层隐藏它，源码与导出仍原样保留。 */
export function taskAnchorSuffixStart(source: string): number | null {
  const hit = TASK_ANCHOR_SUFFIX.exec(source);
  return hit?.index ?? null;
}

export function stripTaskAnchorSuffix(source: string): string {
  const at = taskAnchorSuffixStart(source);
  return at === null ? source : source.slice(0, at);
}

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

      inline.content = stripTaskAnchorSuffix(inline.content.slice(marker[0].length));
      const first = inline.children?.[0];
      if (first?.type === "text") first.content = first.content.slice(marker[0].length);
      // 块锚通常落在最后一个 text token；只在已经确认是任务项后处理，普通正文里的
      // `^tk-xxxxxxxx` 仍照常显示。Markdown 源码没有改，这里只是渲染层不把内部 ID 给人看。
      for (let child = (inline.children?.length ?? 0) - 1; child >= 0; child--) {
        const token = inline.children?.[child];
        if (!token || token.type !== "text") continue;
        const stripped = stripTaskAnchorSuffix(token.content);
        if (stripped !== token.content) token.content = stripped;
        break;
      }

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
