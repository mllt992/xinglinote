import { useRef, useState } from "react";
import { CalendarClock, Check, CheckSquare, FileText, Link2Off, MoreHorizontal, Square } from "lucide-react";
import type { CalendarItem } from "./calendar";
import { captureCivil, isCompletionSwipe, type ReschedulePreset } from "../lib/mobile-capture";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";

/** 右滑完成只是捷径；同一操作始终有 44px 按钮和菜单的键盘等价路径。 */
export function MobileCalendarItem({ item, timezone, canEdit = true, onToggle, onOpen, onOpenNote, onReschedule }: {
  item: CalendarItem; timezone: string; canEdit?: boolean;
  onToggle: (item: CalendarItem, done: boolean) => Promise<void> | void;
  onOpen: (item: CalendarItem) => void;
  onOpenNote: (id: string) => void;
  onReschedule: (item: CalendarItem, preset: ReschedulePreset) => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const start = useRef<{ x: number; y: number; at: number } | null>(null);
  const suppressClick = useRef(false);
  const pending = useRef(false);
  const writable = canEdit && item.canEdit !== false && item.source !== "ics";
  const task = item.kind === "task";
  const done = item.status === "done";
  const at = item.startsAt ?? item.dueAt;
  const local = at ? captureCivil(at, timezone) : null;
  const time = item.allDay ? "全天" : local ? `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}` : "未设时间";
  async function toggle() {
    if (pending.current || !writable) return;
    pending.current = true;
    setBusy(true);
    try { await onToggle(item, !done); } finally { setBusy(false); pending.current = false; }
  }
  return <div className="relative overflow-hidden rounded-lg border border-border bg-background" data-mobile-calendar-item>
    {offset > 0 && <div className="absolute inset-0 flex items-center gap-2 bg-accent px-3 text-sm"><Check className="size-4" />{done ? "恢复" : "完成"}</div>}
    <div className="relative bg-background" style={{ transform: `translateX(${offset}px)`, touchAction: "pan-y" }}
      onTouchStart={event => {
        suppressClick.current = false;
        if (!task || !writable || busy || event.touches.length !== 1 || (event.target as HTMLElement).closest("button,input,a")) return;
        const touch = event.touches[0];
        start.current = { x: touch.clientX, y: touch.clientY, at: Date.now() };
      }}
      onTouchMove={event => {
        if (!start.current || event.touches.length !== 1) { start.current = null; setOffset(0); return; }
        const touch = event.touches[0];
        const dx = touch.clientX - start.current.x;
        const dy = touch.clientY - start.current.y;
        if (Math.abs(dy) > 32) { start.current = null; setOffset(0); return; }
        if (dx > 12 && dx > Math.abs(dy) * 2) setOffset(Math.min(100, dx));
      }}
      onTouchCancel={() => { start.current = null; setOffset(0); }}
      onTouchEnd={event => {
        const from = start.current;
        const touch = event.changedTouches[0];
        start.current = null;
        setOffset(0);
        if (from && touch && isCompletionSwipe(touch.clientX - from.x, touch.clientY - from.y, Date.now() - from.at)) {
          suppressClick.current = true;
          void toggle();
        }
      }} onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}>
      <div className="flex items-start gap-1 p-1">
        {task ? <Button variant="ghost" size="icon" className="size-11 shrink-0" aria-label={`${done ? "取消完成" : "完成"} ${item.title}`} aria-pressed={done} disabled={!writable || busy} onClick={() => void toggle()}>{done ? <CheckSquare /> : <Square />}</Button>
          : <span className="grid size-11 shrink-0 place-items-center text-muted-foreground"><CalendarClock className="size-4" /></span>}
        <div className="min-w-0 flex-1 py-1">
          {/* 正文区用独立键盘按钮语义；触摸滑动从这片区域开始。 */}
          <div role="button" tabIndex={0} className="min-h-11 cursor-pointer rounded-md px-1 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`打开 ${item.title}`} onClick={() => onOpen(item)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onOpen(item); } }}>
            <p className={cn("break-words text-sm", done && "text-muted-foreground line-through")}>{item.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{time}{done ? " · 已完成" : ""}{item.recurring ? " · 重复" : ""}{busy ? " · 正在保存" : ""}</p>
          </div>
          {item.sourceNoteId && <button className="flex min-h-11 max-w-full items-center gap-1 rounded-md px-1 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onOpenNote(item.sourceNoteId!)} aria-label={`打开来源笔记 ${item.sourceNoteTitle ?? "原文"}`}><FileText className="size-3 shrink-0" /><span className="truncate">{item.sourceNoteTitle ?? "打开原文"}</span></button>}
          {item.linkState === "detached" && <p className="flex items-center gap-1 px-1 text-xs text-destructive"><Link2Off className="size-3" />已脱离原文</p>}
        </div>
        {task && writable && <DropdownMenu><DropdownMenuTrigger asChild><Button className="size-11" variant="ghost" size="icon" aria-label={`改期 ${item.title}`} disabled={busy}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {([["today", "改到今天"], ["tomorrow", "改到明天"], ["weekend", "改到周末"]] as const).map(([preset, label]) => <DropdownMenuItem className="min-h-11" key={preset} onSelect={() => void onReschedule(item, preset)}>{label}</DropdownMenuItem>)}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="min-h-11" onSelect={() => void toggle()}>{done ? "恢复为未完成" : "完成任务"}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>}
      </div>
    </div>
  </div>;
}
