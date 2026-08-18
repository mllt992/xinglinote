import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** 上传一个文件，回来一段可以直接落进正文的 Markdown。返回 null = 失败，占位符会被撤掉。 */
export type FileUploader = (file: File) => Promise<string | null>;

let seq = 0;

/**
 * 粘贴或拖进来的文件直接存成当前笔记的附件，正文插链接（规格 §9.3、设计 06）。
 *
 * 上传是异步的，先落一个占位符，回来再按占位符原文替换——中间用户接着打字也不会插错位置，
 * 因为找的是文本本身而不是当初那个偏移量。
 */
export function fileDrop(upload?: FileUploader): Extension {
  if (!upload) return [];

  async function ingest(view: EditorView, files: File[], at: number) {
    for (const file of files) {
      const token = `⏳ 上传中 ${++seq}`;
      const placeholder = `[${token}]()`;
      const pos = Math.min(at, view.state.doc.length);
      view.dispatch({ changes: { from: pos, insert: placeholder }, userEvent: "input.attachment" });

      let markdown: string | null = null;
      try {
        markdown = await upload!(file);
      } catch {
        markdown = null;
      }
      const found = view.state.doc.toString().indexOf(placeholder);
      if (found < 0) continue;      // 用户自己把它删了，那就随他去
      view.dispatch({
        changes: { from: found, to: found + placeholder.length, insert: markdown ?? "" },
        userEvent: "input.attachment",
      });
      at = found + (markdown?.length ?? 0);
    }
  }

  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = [...(event.clipboardData?.files ?? [])];
      if (!files.length || view.state.readOnly) return false;
      event.preventDefault();
      void ingest(view, files, view.state.selection.main.from);
      return true;
    },
    drop(event, view) {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (!files.length || view.state.readOnly) return false;
      event.preventDefault();
      const at = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from;
      void ingest(view, files, at);
      return true;
    },
  });
}
