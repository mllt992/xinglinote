export type EditorTab = "write" | "preview" | "split";

/** 分栏右侧已经是完整预览；左侧保持纯 Markdown，避免同一屏出现两份实时预览。 */
export function editorWysiwyg(tab: EditorTab, enabled: boolean) {
  return tab === "write" && enabled;
}
