export type EditorPreviewMode = "live" | "source";

/** 单栏编辑固定即时渲染；分栏左侧固定源码，右侧负责完整预览。 */
export function editorWysiwyg(mode: EditorPreviewMode) {
  return mode === "live";
}
