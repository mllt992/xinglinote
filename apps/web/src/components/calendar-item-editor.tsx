import { useEffect, useState } from "react";
import { ExternalLink, Link2Off } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { FormError } from "./ui/form-error";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { useConfirm } from "./ui/confirm";
import { useToast } from "./ui/toast";
import type { CalendarItem } from "./calendar";

export type EditorTarget =
  | { mode: "create"; date: string; startMin?: number; endMin?: number; kind?: "task" | "event" }
  | { mode: "edit"; item: CalendarItem };

const PRIORITIES: Array<[number, string]> = [[0, "无"], [1, "低"], [2, "中"], [3, "高"]];

function civil(iso: string, tz: string) {
  const d = new Date(iso);
  const p: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute));
}
const dayKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
const fmtHM = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
function wallToIso(civilDate: Date, tz: string) {
  const guess = Date.UTC(civilDate.getUTCFullYear(), civilDate.getUTCMonth(), civilDate.getUTCDate(), civilDate.getUTCHours(), civilDate.getUTCMinutes());
  let real = new Date(guess);
  for (let i = 0; i < 2; i++) real = new Date(guess - (civil(real.toISOString(), tz).getTime() - real.getTime()));
  return real.toISOString();
}
function fromWall(date: string, time: string) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = (time || "00:00").split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm));
}
const minToHM = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

type Form = { kind: "task" | "event"; title: string; bodyMd: string; date: string; start: string; end: string; allDay: boolean; priority: number };

function formFrom(target: EditorTarget, tz: string): Form {
  if (target.mode === "create") {
    return {
      kind: target.kind ?? "event",
      title: "",
      bodyMd: "",
      date: target.date,
      start: minToHM(target.startMin ?? 9 * 60),
      end: minToHM(target.endMin ?? 10 * 60),
      allDay: false,
      priority: 0,
    };
  }
  const item = target.item;
  const at = item.startsAt ?? item.dueAt;
  const local = at ? civil(at, tz) : null;
  const endLocal = item.endsAt ? civil(item.endsAt, tz) : null;
  return {
    kind: item.kind,
    title: item.title,
    bodyMd: item.bodyMd ?? "",
    date: local ? dayKey(local) : target.item.occurrenceStart ? dayKey(civil(target.item.occurrenceStart, tz)) : "",
    start: local ? fmtHM(local) : "09:00",
    end: endLocal ? fmtHM(endLocal) : local ? fmtHM(new Date(local.getTime() + 3600_000)) : "10:00",
    allDay: item.allDay,
    priority: item.priority,
  };
}

/**
 * 新建 / 编辑同一张弹窗。月视图格子太小，就地那张草稿卡一失焦就没了；
 * 事项点击以前只聚焦，等于点不开。弹窗把标题、时间、备注摊开，回车保存。
 */
export function CalendarItemEditor({ target, wsId, tz, canEdit, onClose, onSaved, onDelete, onOpenNote }: {
  target: EditorTarget | null;
  wsId: string;
  tz: string;
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
  onDelete?: (item: CalendarItem) => void;
  onOpenNote?: (noteId: string) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState<Form>(() => (target ? formFrom(target, tz) : formFrom({ mode: "create", date: "" }, tz)));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (target) { setForm(formFrom(target, tz)); setErr(""); }
  }, [target, tz]);

  const item = target?.mode === "edit" ? target.item : null;
  const fromNote = item?.source === "note";
  const fromIcs = item?.source === "ics";
  const locked = fromNote || fromIcs || !canEdit;
  const readOnly = fromIcs || !canEdit;

  function patch<K extends keyof Form>(key: K, value: Form[K]) {
    setForm(f => ({ ...f, [key]: value }));
  }

  async function save() {
    const title = form.title.trim();
    if (!title) { setErr("先写个标题"); return; }
    if (!form.date) { setErr("先选一天"); return; }
    if (!form.allDay && form.kind === "event" && form.end <= form.start) { setErr("结束时间要晚于开始"); return; }
    setBusy(true);
    setErr("");
    try {
      const startIso = wallToIso(fromWall(form.date, form.allDay ? "00:00" : form.start), tz);
      const endIso = wallToIso(fromWall(form.date, form.allDay ? "23:59" : form.end), tz);
      if (target?.mode === "create") {
        await api(`/api/v1/workspaces/${wsId}/calendar/items`, {
          method: "POST",
          body: JSON.stringify({
            kind: form.kind,
            title,
            bodyMd: form.bodyMd,
            allDay: form.allDay,
            priority: form.priority,
            startsAt: form.kind === "event" ? startIso : null,
            endsAt: form.kind === "event" ? endIso : null,
            dueAt: startIso,
          }),
        });
        toast.success(`已新建「${title}」`);
      } else if (item) {
        const body: Record<string, unknown> = { bodyMd: form.bodyMd, priority: form.priority, ifUnmodifiedSince: item.updatedAt };
        if (!fromNote) {
          body.title = title;
          body.allDay = form.allDay;
          body.startsAt = form.kind === "event" ? startIso : null;
          body.endsAt = form.kind === "event" ? endIso : null;
          body.dueAt = startIso;
        }
        await api(`/api/v1/calendar/items/${item.id}`, { method: "PATCH", body: JSON.stringify(body) });
        toast.success("已保存");
      }
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function detach() {
    if (!item) return;
    setBusy(true);
    try {
      await api(`/api/v1/calendar/items/${item.id}/detach`, { method: "POST" });
      toast.success("已转为独立任务，可以自己改标题和时间了");
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!item || !onDelete) return;
    if (!await confirm({ title: `删除「${item.title}」？`, description: "会进回收站，可以撤销。", confirmText: "删除", destructive: true })) return;
    onDelete(item);
  }

  const title = target?.mode === "create" ? "新建" : "编辑";
  const dateLabel = form.date ? `${Number(form.date.slice(5, 7))}月${Number(form.date.slice(8, 10))}日` : "";

  return <Dialog open={!!target} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-w-lg" onOpenAutoFocus={e => {
      // 标题框该拿焦点；Radix 默认会先落到关闭按钮上。来自笔记时标题是锁的，别硬 focus。
      const input = (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>("input[name='title']");
      if (input && !input.disabled) { e.preventDefault(); input.focus(); input.select(); }
    }}>
      <DialogHeader>
        <DialogTitle>{title}{target?.mode === "create" ? (form.kind === "event" ? "日程" : "待办") : ""}{dateLabel ? ` · ${dateLabel}` : ""}</DialogTitle>
        <DialogDescription>
          {fromNote ? "这条来自笔记，标题和时间请到原文改。" : fromIcs ? "来自外部订阅，只读。" : "回车保存，Esc 关掉。"}
        </DialogDescription>
      </DialogHeader>

      {fromNote && item && <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {item.linkState === "detached" ? "已脱离原文" : `来自《${item.sourceNoteTitle ?? "笔记"}》`}
        </span>
        {item.sourceNoteId && item.linkState !== "detached" && <Button size="sm" variant="ghost" onClick={() => onOpenNote?.(item.sourceNoteId!)}><ExternalLink />打开原文</Button>}
        {item.linkState === "detached" && canEdit && <Button size="sm" variant="outline" disabled={busy} onClick={() => void detach()}><Link2Off />转为独立任务</Button>}
      </div>}

      <form className="grid gap-3" onSubmit={e => { e.preventDefault(); if (!readOnly) void save(); }}>
        {target?.mode === "create" && <div className="inline-flex w-fit rounded-lg bg-muted p-1">
          {([["event", "日程"], ["task", "待办"]] as const).map(([id, label]) =>
            <button key={id} type="button" onClick={() => patch("kind", id)} className={cn("rounded-md px-3 py-1 text-sm", form.kind === id ? "bg-background shadow-sm" : "text-muted-foreground")}>{label}</button>)}
        </div>}

        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">标题</span>
          <Input name="title" value={form.title} disabled={locked} onChange={e => patch("title", e.target.value)} placeholder={form.kind === "event" ? "比如：和销售对齐季度数据" : "比如：交房租"} />
        </label>

        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">备注</span>
          <Textarea value={form.bodyMd} disabled={readOnly} onChange={e => patch("bodyMd", e.target.value)} placeholder="可选，短备注就行" className="min-h-20" />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">日期</span>
            <Input type="date" value={form.date} disabled={locked} onChange={e => patch("date", e.target.value)} />
          </label>
          <div className="flex items-end gap-2 pb-1">
            <Switch checked={form.allDay} disabled={locked} onCheckedChange={v => patch("allDay", v)} label="全天" />
            <span className="text-xs text-muted-foreground">全天</span>
          </div>
        </div>

        {!form.allDay && <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{form.kind === "event" ? "开始" : "时间"}</span>
            <Input type="time" value={form.start} disabled={locked} onChange={e => patch("start", e.target.value)} />
          </label>
          {form.kind === "event" && <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">结束</span>
            <Input type="time" value={form.end} disabled={locked} onChange={e => patch("end", e.target.value)} />
          </label>}
        </div>}

        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">优先级</span>
          <div className="inline-flex w-fit rounded-lg bg-muted p-1">
            {PRIORITIES.map(([id, label]) =>
              <button key={id} type="button" disabled={readOnly} onClick={() => patch("priority", id)} className={cn("rounded-md px-3 py-1 text-sm disabled:opacity-50", form.priority === id ? "bg-background shadow-sm" : "text-muted-foreground")}>{label}</button>)}
          </div>
        </div>

        {item?.recurring && <p className="text-[11px] text-muted-foreground">这是重复条目，改标题 / 备注 / 时间会作用到整条序列。</p>}

        <FormError>{err}</FormError>

        <div className="flex items-center gap-2 pt-1">
          {item && canEdit && !fromIcs && onDelete && <Button type="button" variant="ghost" className="text-destructive" disabled={busy} onClick={() => void remove()}>删除</Button>}
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
            {!readOnly && <Button type="submit" disabled={busy}>{target?.mode === "create" ? "创建" : "保存"}</Button>}
          </div>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
