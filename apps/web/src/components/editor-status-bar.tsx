import { useMemo } from "react";
import { AlertCircle, LoaderCircle, Lock, Save } from "lucide-react";
import { countWords } from "@kb/shared/markdown";
import { cn } from "../lib/utils";

export type CursorInfo = { line: number; col: number; selected: number };

/**
 * 编辑器底栏。规范 05 §3.1 要求保存状态在底栏，不是顶栏——顶栏离正文太远，
 * 写字的时候眼睛不会往那儿瞟。
 */
export function EditorStatusBar({
  status,
  statusErr,
  bodyMd,
  cursor,
  readOnly,
  vimMode,
  lastSavedAt,
  saving,
  onSave,
  right,
}: {
  status: string;
  statusErr: boolean;
  bodyMd: string;
  cursor: CursorInfo | null;
  readOnly: boolean;
  /** Vim keymap 开着时的当前模式；关着就是 null（设计 17 §3.3）。 */
  vimMode?: string | null;
  lastSavedAt?: number | null;
  saving?: boolean;
  onSave?: () => void;
  right?: React.ReactNode;
}) {
  const stats = useMemo(() => ({ words: countWords(bodyMd), chars: bodyMd.length, lines: bodyMd ? bodyMd.split("\n").length : 0 }), [bodyMd]);

  return (
    <div className="flex h-7 shrink-0 items-center gap-1.5 border-t border-border bg-muted/40 px-2 text-[11px] text-muted-foreground sm:gap-3 sm:px-4">
      <span className={cn("inline-flex shrink-0 items-center gap-1", statusErr ? "font-medium text-destructive" : status.startsWith("已保存") ? "" : "text-foreground")}>
        {statusErr && <AlertCircle className="size-3" />}
        {status}
      </span>
      {onSave && (
        <button
          type="button"
          disabled={readOnly || saving}
          onClick={onSave}
          aria-label="立即保存笔记"
          aria-keyshortcuts="Control+S Meta+S"
          title="立即保存（Ctrl+S / Cmd+S）"
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-foreground outline-none hover:bg-muted-foreground/10 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {saving ? <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" /> : <Save className="size-3" />}
          保存
        </button>
      )}
      {lastSavedAt !== null && lastSavedAt !== undefined && (
        <time dateTime={new Date(lastSavedAt).toISOString()} className="shrink-0 tabular-nums" title={new Date(lastSavedAt).toLocaleString()}>
          最后保存 {new Date(lastSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </time>
      )}
      {readOnly && <span className="inline-flex items-center gap-1"><Lock className="size-3" />只读</span>}
      {vimMode && <span className="rounded bg-foreground px-1.5 font-medium tracking-wider text-background">{vimMode}</span>}
      <span className="ml-auto hidden shrink-0 tabular-nums sm:inline">{stats.words} 字</span>
      <span className="hidden shrink-0 tabular-nums md:inline">{stats.chars} 字符</span>
      <span className="hidden shrink-0 tabular-nums lg:inline">{stats.lines} 行</span>
      {cursor && (
        <span className="hidden tabular-nums md:inline">
          第 {cursor.line} 行 第 {cursor.col} 列{cursor.selected > 0 ? ` · 选中 ${cursor.selected}` : ""}
        </span>
      )}
      {right}
    </div>
  );
}
