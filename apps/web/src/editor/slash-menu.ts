import type { CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import { EditorSelection } from "@codemirror/state";
import type { Command } from "@codemirror/view";

export type EditorSnippetId = "heading1" | "heading2" | "heading3" | "bullet" | "ordered" | "task" | "quote" | "horizontalRule" | "codeBlock" | "table" | "mermaidFlow" | "mermaidSequence" | "inlineMath" | "blockMath" | "wiki" | "date" | "time";

export type Snippet = {
  id: EditorSnippetId;
  label: string;
  detail: string;
  /**
   * 键盘别名：英文名、全拼、拼音首字母。
   *
   * 敲下 `/` 的那一刻输入法基本都在英文态，菜单名却是中文——不给别名，想插一张表格
   * 得先切输入法打「表格」，多数人到这一步就放弃这个功能了。
   */
  keys: string[];
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
export const EDITOR_SNIPPETS: Snippet[] = [
  { id: "heading1", label: "一级标题", detail: "# ", keys: ["h1", "heading1", "yijibiaoti", "yjbt", "biaoti", "bt"], template: "# " + CARET },
  { id: "heading2", label: "二级标题", detail: "## ", keys: ["h2", "heading2", "erjibiaoti", "ejbt", "biaoti", "bt"], template: "## " + CARET },
  { id: "heading3", label: "三级标题", detail: "### ", keys: ["h3", "heading3", "sanjibiaoti", "sjbt", "biaoti", "bt"], template: "### " + CARET },
  { id: "bullet", label: "无序列表", detail: "- ", keys: ["ul", "list", "bullet", "wuxuliebiao", "wxlb", "liebiao", "lb"], template: "- " + CARET },
  { id: "ordered", label: "有序列表", detail: "1. ", keys: ["ol", "number", "youxuliebiao", "yxlb", "liebiao", "lb"], template: "1. " + CARET },
  { id: "task", label: "任务项", detail: "- [ ] ", keys: ["todo", "task", "checkbox", "renwu", "rw", "rwx"], template: "- [ ] " + CARET },
  { id: "quote", label: "引用", detail: "> ", keys: ["quote", "blockquote", "yinyong", "yy"], template: "> " + CARET },
  { id: "horizontalRule", label: "分隔线", detail: "---", keys: ["hr", "rule", "divider", "fengexian", "fgx"], template: "---" + NL + CARET },
  { id: "codeBlock", label: "代码块", detail: "```", keys: ["code", "pre", "daimakuai", "dmk", "daima", "dm"], template: "```" + CARET + NL + NL + "```" },
  { id: "table", label: "表格", detail: "两列表格", keys: ["table", "biaoge", "bg"], template: "| 列一 | 列二 |" + NL + "| --- | --- |" + NL + "| " + CARET + " | |" },
  { id: "mermaidFlow", label: "流程图", detail: "mermaid 流程图", keys: ["flowchart", "mermaid", "diagram", "liuchengtu", "lct", "tu"], template: "```mermaid" + NL + "flowchart TD" + NL + "  A[开始] --> B{判断}" + NL + "  B -->|是| C[继续]" + NL + "  B -->|否| D[结束]" + CARET + NL + "```" },
  { id: "mermaidSequence", label: "时序图", detail: "mermaid 时序图", keys: ["sequence", "mermaid", "diagram", "shixutu", "sxt", "tu"], template: "```mermaid" + NL + "sequenceDiagram" + NL + "  甲->>乙: 请求" + NL + "  乙-->>甲: 响应" + CARET + NL + "```" },
  { id: "inlineMath", label: "行内公式", detail: "$…$", keys: ["math", "inlinemath", "latex", "hangneigongshi", "hngs", "gongshi", "gs"], template: "$" + CARET + "$" },
  { id: "blockMath", label: "块级公式", detail: "$$…$$", keys: ["blockmath", "math", "latex", "kuaijigongshi", "kjgs", "gongshi", "gs"], template: "$$" + NL + CARET + NL + "$$" },
  { id: "wiki", label: "双链", detail: "[[…]]", keys: ["link", "wiki", "wikilink", "shuanglian", "sl"], template: "[[" + CARET + "]]" },
];

/** 今天 / 现在：写日记和会议纪要时最常用的两条。 */
function dateSnippets(now: Date): Snippet[] {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return [
    { id: "date", label: "今天日期", detail: date, keys: ["today", "date", "jintian", "jt", "riqi", "rq"], template: `${date}${CARET}` },
    { id: "time", label: "当前时间", detail: `${date} ${time}`, keys: ["now", "time", "xianzai", "xz", "shijian", "sj"], template: `${date} ${time}${CARET}` },
  ];
}

/**
 * 自己过滤，不用 CodeMirror 那套。它只拿 `label` 去模糊匹配，而 `label` 是中文，
 * 结果就是必须切输入法才能用。这里把中文名、英文名、全拼、首字母一起纳入匹配。
 */
function matches(snippet: Snippet, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (snippet.label.includes(query)) return true;
  return snippet.keys.some(key => key.startsWith(q));
}

export function slashCompletion(): CompletionSource {
  return (context): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const typed = line.text.slice(0, context.pos - line.from);
    const hit = /^(\s*)\/([^\s/]*)$/.exec(typed);
    if (!hit) return null;
    const from = line.from + hit[1].length;

    const all = [...EDITOR_SNIPPETS, ...dateSnippets(new Date())].filter(snippet => matches(snippet, hit[2]));
    if (!all.length) return null;
    return {
      from,
      // 自己过滤过了，别让 CodeMirror 再拿中文 label 过一遍——那会把英文别名的命中全筛掉
      filter: false,
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
      // 不给 validFor：过滤是我们自己做的，让它每敲一个键重跑一次这个 source
      // （纯本地计算，十几条 snippet，比让 CodeMirror 拿中文 label 复筛便宜也正确）
    };
  };
}

/** 工具栏与斜杠菜单共用同一份模板，避免高级插入能力逐渐漂开。 */
export function insertSnippet(id: EditorSnippetId): Command {
  return view => {
    if (view.state.readOnly) return false;
    const snippet = id === "date" || id === "time"
      ? dateSnippets(new Date()).find(item => item.id === id)
      : EDITOR_SNIPPETS.find(item => item.id === id);
    if (!snippet) return false;
    const block = id === "table" || id === "blockMath" || id === "mermaidFlow" || id === "mermaidSequence";
    view.dispatch(
      view.state.changeByRange(range => {
        const selected = view.state.sliceDoc(range.from, range.to);
        const caret = snippet.template.indexOf(CARET);
        const startLine = view.state.doc.lineAt(range.from);
        const endLine = view.state.doc.lineAt(range.to);
        const before = block && range.from !== startLine.from ? NL : "";
        const after = block && range.to !== endLine.to ? NL : "";
        const content = caret < 0 ? snippet.template : snippet.template.replace(CARET, selected);
        const insert = `${before}${content}${after}`;
        const head = range.from + before.length + (caret < 0 ? content.length : caret + selected.length);
        return {
          changes: { from: range.from, to: range.to, insert },
          range: selected ? EditorSelection.range(range.from + before.length + caret, head) : EditorSelection.cursor(head),
        };
      }),
      { userEvent: "input.complete", scrollIntoView: true },
    );
    return true;
  };
}
