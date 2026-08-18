import type { CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import { EditorSelection } from "@codemirror/state";

type Snippet = {
  label: string;
  detail: string;
  /** 要插入的文本。`^` 标记光标落点，只认第一个；不写就落在末尾。 */
  template: string;
};

const NL = "\n";
/** 光标落点的记号。不用 `|`：表格和 mermaid 的边标签里本来就有竖线，会被当成落点吃掉。 */
const CARET = "^";

/**
 * 斜杠菜单。**只在行首触发**（前面允许缩进）——这样「替换掉 /xxx」就等于「给这一行加标记」，
 * 不会出现在句子中间敲 `/` 冒出菜单、选完把半句话变成标题的怪事。
 */
const SNIPPETS: Snippet[] = [
  { label: "一级标题", detail: "# ", template: "# " + CARET },
  { label: "二级标题", detail: "## ", template: "## " + CARET },
  { label: "三级标题", detail: "### ", template: "### " + CARET },
  { label: "无序列表", detail: "- ", template: "- " + CARET },
  { label: "有序列表", detail: "1. ", template: "1. " + CARET },
  { label: "任务项", detail: "- [ ] ", template: "- [ ] " + CARET },
  { label: "引用", detail: "> ", template: "> " + CARET },
  { label: "分隔线", detail: "---", template: "---" + NL + CARET },
  { label: "代码块", detail: "```", template: "```" + CARET + NL + NL + "```" },
  { label: "表格", detail: "两列表格", template: "| 列一 | 列二 |" + NL + "| --- | --- |" + NL + "| " + CARET + " | |" },
  { label: "流程图", detail: "mermaid 流程图", template: "```mermaid" + NL + "flowchart TD" + NL + "  A[开始] --> B{判断}" + NL + "  B -->|是| C[继续]" + NL + "  B -->|否| D[结束]" + CARET + NL + "```" },
  { label: "时序图", detail: "mermaid 时序图", template: "```mermaid" + NL + "sequenceDiagram" + NL + "  甲->>乙: 请求" + NL + "  乙-->>甲: 响应" + CARET + NL + "```" },
  { label: "行内公式", detail: "$…$", template: "$" + CARET + "$" },
  { label: "块级公式", detail: "$$…$$", template: "$$" + NL + CARET + NL + "$$" },
  { label: "双链", detail: "[[…]]", template: "[[" + CARET + "]]" },
  { label: "折叠标记", detail: "分隔的段落", template: "" + NL + CARET },
];

/** 今天 / 现在：写日记和会议纪要时最常用的两条。 */
function dateSnippets(now: Date): Snippet[] {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return [
    { label: "今天日期", detail: date, template: `${date}${CARET}` },
    { label: "当前时间", detail: `${date} ${time}`, template: `${date} ${time}${CARET}` },
  ];
}

export function slashCompletion(): CompletionSource {
  return (context): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const typed = line.text.slice(0, context.pos - line.from);
    const hit = /^(\s*)\/([^\s/]*)$/.exec(typed);
    if (!hit) return null;
    const from = line.from + hit[1].length;

    const all = [...SNIPPETS, ...dateSnippets(new Date())];
    return {
      from,
      options: all.map(snippet => ({
        label: snippet.label,
        detail: snippet.detail,
        type: "keyword",
        apply: (view, _completion, at, to) => {
          const caret = snippet.template.indexOf(CARET);
          const insert = caret < 0 ? snippet.template : snippet.template.replace(CARET, "");
          view.dispatch({
            changes: { from: at, to, insert },
            selection: EditorSelection.cursor(at + (caret < 0 ? insert.length : caret)),
            userEvent: "input.complete",
          });
        },
      })),
      validFor: /^[^\s/]*$/,
    };
  };
}
