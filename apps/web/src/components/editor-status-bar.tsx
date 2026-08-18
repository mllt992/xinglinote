import { useMemo } from "react";
import { AlertCircle, Lock } from "lucide-react";
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
  right,
}: {
  status: string;
  statusErr: boolean;
  bodyMd: string;
  cursor: CursorInfo | null;
  readOnly: boolean;
  right?: React.ReactNode;
}) {
  const stats = useMemo(() => ({ words: countWords(bodyMd), chars: bodyMd.length, lines: bodyMd ? bodyMd.split("\n").length : 0 }), [bodyMd]);

  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-muted/40 px-4 text-[11px] text-muted-foreground">
      <span className={cn("inline-flex items-center gap-1", statusErr ? "font-medium text-destructive" : status.startsWith("已保存") ? "" : "text-foreground")}>
        {statusErr && <AlertCircle className="size-3" />}
        {status}
      </span>
      {readOnly && <span className="inline-flex items-center gap-1"><Lock className="size-3" />只读</span>}
      <span className="ml-auto tabular-nums">{stats.words} 字</span>
      <span className="tabular-nums">{stats.chars} 字符</span>
      <span className="hidden tabular-nums sm:inline">{stats.lines} 行</span>
      {cursor && (
        <span className="hidden tabular-nums md:inline">
          第 {cursor.line} 行 第 {cursor.col} 列{cursor.selected > 0 ? ` · 选中 ${cursor.selected}` : ""}
        </span>
      )}
      {right}
    </div>
  );
}
