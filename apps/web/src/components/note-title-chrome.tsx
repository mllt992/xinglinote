import { Copy } from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

/**
 * 笔记顶栏里的紧凑标题：过长省略、悬停看全文、一键复制。
 * 可编辑时直接内联改（保留 placeholder="无标题"，给 App 的输入法 composition 钩子认）。
 */
export function NoteTitleChrome({
  title,
  canEdit,
  onChange,
  onCopy,
  className,
}: {
  title: string;
  canEdit: boolean;
  onChange: (value: string) => void;
  onCopy: () => void;
  className?: string;
}) {
  const full = title.trim() ? title : "无标题";
  return (
    <div className={cn("flex min-w-0 flex-1 items-center gap-0.5", className)}>
      {canEdit ? (
        <input
          className="min-w-0 flex-1 truncate border-0 bg-transparent py-1 text-sm font-semibold tracking-[-.02em] text-foreground outline-none placeholder:text-muted-foreground/50 focus:overflow-auto"
          value={title}
          onChange={event => onChange(event.target.value)}
          placeholder="无标题"
          title={title || undefined}
          aria-label="笔记标题"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate py-1 text-sm font-semibold text-foreground" title={full}>
          {full}
        </span>
      )}
      <Tooltip content="复制标题">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="复制标题"
          onClick={() => onCopy()}
        >
          <Copy className="size-3.5" />
        </Button>
      </Tooltip>
    </div>
  );
}
