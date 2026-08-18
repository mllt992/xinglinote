import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

export type Command = {
  id: string;
  label: string;
  group: string;
  /** 右侧灰字，一般放快捷键。 */
  hint?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  run: () => void;
};

/** 子序列匹配：打 "xjbj" 也能命中「新建笔记」的拼音首字母之外的乱序输入，够用且不引依赖。 */
function matches(text: string, query: string): boolean {
  if (!query) return true;
  const haystack = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  if (haystack.includes(needle)) return true;
  let at = 0;
  for (const ch of needle) {
    at = haystack.indexOf(ch, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

/** 命令面板（Ctrl/⌘+Shift+P）。只放动作；找笔记是 Ctrl/⌘+K 的活。 */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: Command[];
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const hits = useMemo(
    () => commands.filter(c => !c.disabled && matches(`${c.group} ${c.label} ${c.hint ?? ""}`, query.trim())),
    [commands, query],
  );

  useEffect(() => { if (open) { setQuery(""); setActive(0); } }, [open]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function pick(index: number) {
    const hit = hits[index];
    if (!hit) return;
    onOpenChange(false);
    hit.run();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[12%] max-w-xl translate-y-0 gap-0 p-0">
        <DialogHeader className="sr-only">
          <DialogTitle>命令面板</DialogTitle>
          <DialogDescription>输入以筛选可执行的操作。</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="输入命令…"
          className="h-12 rounded-none border-0 border-b border-border text-sm shadow-none focus-visible:ring-0"
          onKeyDown={e => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive(v => Math.min(v + 1, hits.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive(v => Math.max(v - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); pick(active); }
          }}
        />
        <div ref={listRef} className="max-h-[min(60vh,26rem)] overflow-y-auto p-1.5">
          {hits.length === 0
            ? <p className="px-3 py-8 text-center text-xs text-muted-foreground">没有匹配的命令。</p>
            : hits.map((hit, index) => (
              <button
                key={hit.id}
                data-index={index}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(index)}
                className={cn("flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm", index === active ? "bg-muted" : "hover:bg-muted/60")}
              >
                {hit.icon && <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">{hit.icon}</span>}
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-[11px] text-muted-foreground">{hit.group} · </span>
                  {hit.label}
                </span>
                {hit.hint && <kbd className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{hit.hint}</kbd>}
              </button>
            ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
