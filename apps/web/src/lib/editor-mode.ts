export type EditorPreviewMode = "live" | "source";
export type EditorSurface = "write" | "split";

/** 即时渲染开关只属于单栏编辑；分栏左侧无条件使用源码。 */
export function editorPreviewMode(surface: EditorSurface, liveEnabled: boolean): EditorPreviewMode {
  return surface === "write" && liveEnabled ? "live" : "source";
}

export function editorWysiwyg(mode: EditorPreviewMode) {
  return mode === "live";
}
