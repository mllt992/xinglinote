export type MarkdownEditorHandle = {
  scrollToLine: (line: number) => void;
  focus: () => void;
  run: (action: import("./markdown-editor-helpers").EditorAction) => void;
  activeActions: () => import("./markdown-editor-helpers").EditorAction[];
  historyState: () => { canUndo: boolean; canRedo: boolean };
  getSelection: () => { text: string; from: number; to: number } | null;
  selectRange: (from: number, to: number) => void;
  locateRange: (from: number, to: number) => void;
  getCursorPos: () => number | null;
  replaceRange: (from: number, to: number, text: string) => void;
  insertText: (text: string) => void;
};
