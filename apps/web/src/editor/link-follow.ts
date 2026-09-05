import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export function wikiAt(state: EditorState, from: number) {
  const text = state.doc.sliceString(from, Math.min(from + 512, state.doc.length));
  const hit = /^!?\[\[([^\]\n]+)\]\]/.exec(text);
  if (!hit) return null;
  const [left, alias] = hit[1].split("|");
  const [title, section] = left.split("#");
  return { title: title.trim() || (alias ?? "").trim(), section: section?.trim() || undefined };
}

/** 最近一次指针按下的种类。触摸屏上没有 Ctrl/⌘ 可按，只能靠它区分。 */
let lastPointer: string = "mouse";

/**
 * 触摸设备：只有真正的 touch/pen 才走「点一下跟随链接」。
 * 不再用 `(pointer: coarse)` 兜底——二合一笔记本开着触控屏时媒体查询常年是 coarse，
 * 外接鼠标点双链 / 链接会被当成「跟随」并 preventDefault，光标根本放不进去（issue #40）。
 * pointerType 缺失时宁可保守（当作鼠标），让用户用 Ctrl/⌘+单击跟随。
 */
function coarsePointer(): boolean {
  return lastPointer === "touch" || lastPointer === "pen";
}

/**
 * 跟随链接：桌面是 `Ctrl/⌘ + 单击`——裸单击要留给「点一下改字」这个更常用的动作，
 * 想读的时候右边有预览栏。
 *
 * **触摸设备直接单击跟随**：手机上根本按不出 Ctrl/⌘，也没有并排的预览栏，
 * 不放开这一条，编辑态里的双链就等于死链。想改链接文字的，点它前后一格再拖光标进去。
 */
export function followHandler(onWiki?: (title: string, section?: string) => void): Extension {
  return EditorView.domEventHandlers({
    pointerdown(event) {
      lastPointer = event.pointerType || "mouse";
      return false;
    },
    mousedown(event, view) {
      if (event.button !== 0) return false;
      if (!(event.ctrlKey || event.metaKey) && !coarsePointer()) return false;
      const target = event.target as HTMLElement;

      const wiki = target.closest<HTMLElement>(".cm-md-wiki");
      if (wiki && onWiki) {
        const ref = wikiAt(view.state, Number(wiki.dataset.wikiFrom));
        if (!ref) return false;
        event.preventDefault();
        onWiki(ref.title, ref.section);
        return true;
      }

      const link = target.closest<HTMLElement>(".cm-md-link");
      if (!link) return false;
      let node = syntaxTree(view.state).resolveInner(view.posAtDOM(link), 1);
      while (node.parent && node.name !== "Link") node = node.parent;
      if (node.name !== "Link") return false;
      const href = /\]\(\s*<?([^)>\s]+)/.exec(view.state.doc.sliceString(node.from, node.to))?.[1];
      if (!href) return false;
      event.preventDefault();
      const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
      window.open(href, external ? "_blank" : "_self", external ? "noreferrer,noopener" : undefined);
      return true;
    },
  });
}
