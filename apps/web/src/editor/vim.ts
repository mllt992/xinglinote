/**
 * Vim keymap（设计 17 §3.3）。默认关：这是少数人的强需求、多数人的灾难，
 * 手滑开了会发现打字全变成命令。
 *
 * 按需加载——`@replit/codemirror-vim` 有两百来 KB，关着的用户一个字节都不该下。
 * 和 KaTeX、mermaid 同一条路子。
 */
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export type VimMode = "normal" | "insert" | "visual" | "replace";
export const VIM_MODE_LABEL: Record<VimMode, string> = {
  normal: "NORMAL", insert: "INSERT", visual: "VISUAL", replace: "REPLACE",
};

type VimModule = typeof import("@replit/codemirror-vim");

let pending: Promise<VimModule | null> | null = null;
let loaded: VimModule | null = null;

/** 加载失败回 null，调用方退回普通模式并提示，别让编辑器卡在半吊子状态。 */
export function loadVim(): Promise<VimModule | null> {
  pending ??= import("@replit/codemirror-vim").then(m => (loaded = m)).catch(() => null);
  return pending;
}

/** 已经加载过就同步拿到：换一篇笔记重建编辑器时不该先闪一下普通模式。 */
export const cachedVim = () => loaded;

let exDefined = false;

/**
 * `:w` / `:wq` 映射到宿主的保存。Vim 用户按完 `:w` 会理所当然地以为存上了，
 * 而这里的保存本来就是自动的——不接上去，那一下就成了静默的无操作。
 */
export function vimExtension(mod: VimModule, onWrite: () => void): Extension {
  if (!exDefined) {
    exDefined = true;
    // defineEx 是模块级的全局注册，只做一次；回调里现读最新的保存函数
    for (const [name, short] of [["write", "w"], ["wq", "wq"], ["x", "x"]] as const) {
      try { mod.Vim.defineEx(name, short, () => latestWrite?.()); } catch { /* 名字被占了就算了 */ }
    }
  }
  latestWrite = onWrite;
  // status: false —— 底栏由我们自己画，不要它再塞一条它自己的
  return mod.vim({ status: false });
}

let latestWrite: (() => void) | null = null;

/**
 * 读当前模式。`@replit/codemirror-vim` 把状态挂在 view 上，没有公开类型，
 * 所以按结构取；取不到就当 normal——显示错模式也比崩掉强。
 */
export function vimModeOf(view: EditorView | null): VimMode {
  const vim = (view as unknown as { cm?: { state?: { vim?: { insertMode?: boolean; visualMode?: boolean; overwrite?: boolean } } } } | null)?.cm?.state?.vim;
  if (!vim) return "normal";
  if (vim.overwrite) return "replace";
  if (vim.insertMode) return "insert";
  if (vim.visualMode) return "visual";
  return "normal";
}
