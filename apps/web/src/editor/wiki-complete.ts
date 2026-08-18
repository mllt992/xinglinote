import type { Completion, CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import { api } from "../api";

type Brief = { id: string; title: string; workspaceId: string; notebookId: string };

export type WikiCompleteOptions = {
  /** 只补当前工作区的笔记；跨区双链靠手写全名，见规格 §9.5。 */
  workspaceId?: string;
  /** 笔记本 id → 名字，用来在候选右边标出处。 */
  notebookNames?: Record<string, string>;
  /** 当前这篇，别把自己列进去。 */
  excludeNoteId?: string;
};

/** `[[` 后面到光标为止的那一段。带 `#` 或 `|` 的说明用户在写节或别名，就不插手了。 */
const TRIGGER = /!?\[\[[^\]\n]*/;

function toOption(note: Brief, opts: WikiCompleteOptions): Completion {
  return {
    label: note.title || "无标题",
    detail: opts.notebookNames?.[note.notebookId],
    type: "text",
    apply: (view, _completion, from, to) => {
      const title = note.title || "无标题";
      // closeBrackets 通常已经把 `]]` 补好了，别再插一遍。
      const tail = view.state.doc.sliceString(to, to + 2) === "]]" ? 2 : 0;
      view.dispatch({
        changes: { from, to, insert: tail ? title : `${title}]]` },
        selection: { anchor: from + title.length + 2 },
        userEvent: "input.complete",
      });
    },
  };
}

/**
 * `[[` 触发的笔记标题补全。空查询给最近打开过的，省得每次都从头打字。
 * 源码里落下的始终是标题（规格 §9.4），库内绑 ID 是解析层的事，与这里无关。
 */
export function wikiCompletion(read: () => WikiCompleteOptions): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const opts = read();
    const before = context.matchBefore(TRIGGER);
    if (!before) return null;
    const raw = before.text.replace(/^!?\[\[/, "");
    if (raw.includes("|") || raw.includes("#")) return null;
    const query = raw.trim();
    if (!query && !context.explicit && before.to !== before.from + (before.text.startsWith("!") ? 3 : 2)) return null;

    let notes: Brief[] = [];
    try {
      if (!query) {
        notes = (await api<{ notes: Brief[] }>("/api/v1/me/recent")).notes;
      } else {
        const params = new URLSearchParams({ q: query, limit: "12", titleOnly: "1" });
        if (opts.workspaceId) params.set("workspaceId", opts.workspaceId);
        notes = (await api<{ hits: Brief[] }>(`/api/v1/search?${params}`)).hits;
      }
    } catch {
      return null;    // 搜不动就安静收场，别把补全菜单变成报错弹窗
    }
    if (context.aborted) return null;

    const options = notes
      .filter(note => note.id !== opts.excludeNoteId)
      .slice(0, 12)
      .map(note => toOption(note, opts));
    if (!options.length) return null;

    return {
      from: before.from + (before.text.startsWith("!") ? 3 : 2),
      options,
      // 继续打字仍在同一次补全里过滤，不必每个键都回服务端。
      validFor: /^[^\]\n|#]*$/,
    };
  };
}
