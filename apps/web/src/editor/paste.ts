/**
 * 粘贴的三件事（设计 17 §3.6）：
 *
 * 1. 富文本 → 闭集内的 Markdown（从网页、飞书、Word 粘过来不再只剩纯文本）。
 * 2. `Ctrl/⌘+Shift+V` → 强制纯文本。
 * 3. 剪贴板是一条链接、手里又有选区 → 直接变成 `[选中](链接)`。
 *
 * 文件（图片、附件）不归这里，走 `attachments.ts`；那个扩展排在前面，先接走带文件的粘贴。
 */
import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { htmlToMarkdown, worthConverting } from "./paste-html";

/** 整段就是一条链接（前后可以有空白，中间不能有）。 */
const LONE_URL = /^\s*((?:https?|mailto|tel):\/*[^\s<>]+)\s*$/i;

/**
 * `Ctrl/⌘+Shift+V` 是浏览器自己的「粘贴为纯文本」手势，它不经过我们的 keymap，
 * 而 paste 事件上又读不到当时按了什么键。所以在 keydown 里记一笔，粘贴那一下现查。
 */
let plainUntil = 0;

function insert(view: EditorView, text: string, userEvent: string) {
  view.dispatch(view.state.replaceSelection(text), { userEvent, scrollIntoView: true });
}

export function smartPaste(): Extension {
  return EditorView.domEventHandlers({
    keydown(event) {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === "v" || event.key === "V")) {
        plainUntil = Date.now() + 500;
      }
      return false;
    },
    paste(event, view) {
      if (view.state.readOnly) return false;
      const data = event.clipboardData;
      if (!data || data.files.length) return false;      // 带文件的交给 attachments

      const plain = data.getData("text/plain");
      const forcePlain = Date.now() < plainUntil;
      plainUntil = 0;

      // 选中一段再粘一条链接 = 给它加链接。这是各家编辑器的通行手势，也最省事。
      const url = LONE_URL.exec(plain)?.[1];
      const range = view.state.selection.main;
      if (url && !range.empty && !forcePlain) {
        const text = view.state.sliceDoc(range.from, range.to);
        // 选中的本来就是个链接 / 已经在 `](…)` 里，就别再套一层
        if (!LONE_URL.test(text) && !text.includes("\n")) {
          event.preventDefault();
          const insertText = `[${text}](${/[()\s]/.test(url) ? `<${url}>` : url})`;
          view.dispatch({
            changes: { from: range.from, to: range.to, insert: insertText },
            selection: EditorSelection.cursor(range.from + insertText.length),
            userEvent: "input.paste.link",
          });
          return true;
        }
      }

      if (forcePlain) {
        if (!plain) return false;
        event.preventDefault();
        insert(view, plain, "input.paste.plain");
        return true;
      }

      const html = data.getData("text/html");
      if (!html || !worthConverting(html)) return false;
      let markdown: string | null = null;
      try {
        markdown = htmlToMarkdown(html);
      } catch {
        markdown = null;                                  // 转不动就当没这回事，退回浏览器的纯文本粘贴
      }
      // 转出来的东西还不如纯文本长，说明源里基本没有结构，别拿转换结果去换用户的原文
      if (!markdown || (plain.trim() && markdown.length < plain.trim().length * 0.5)) return false;

      event.preventDefault();
      insert(view, markdown, "input.paste.markdown");
      return true;
    },
  });
}
