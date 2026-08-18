import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * 打字机滚动：光标所在行始终停在视口中间，眼睛不用一路往下追。
 *
 * 不在 updateListener 里同步 dispatch——CodeMirror 明令禁止，会把这次更新搅乱；
 * 改成下一帧再滚，顺带把一次输入里的多个更新合并成一次滚动。
 */
export function typewriterScroll(enabled: () => boolean): Extension {
  let frame = 0;
  return EditorView.updateListener.of(update => {
    if (!enabled()) return;
    if (!update.docChanged && !update.selectionSet) return;
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      const view = update.view;
      if (!view.dom.isConnected) return;
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }) });
    });
  });
}
