import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { BellRing, CalendarDays, ChevronRight, FileText, Inbox, Link2Off, PenLine, Plus, RotateCcw, Star, UserPlus } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { useToast } from "./ui/toast";

export type CalendarItem = {
  id: string;
  occurrenceStart: string | null;
  kind: "task" | "event";
  title: string;
  allDay: boolean;
  startsAt: string | null;
  endsAt: string | null;
  dueAt: string | null;
  timezone: string;
  status: "open" | "done" | "cancelled";
  priority: number;
  recurring: boolean;
  source: string;
  sourceNoteId: string | null;
  sourceNoteTitle: string | null;
  linkState: "linked" | "detached";
  assigneeUserId: string | null;
  createdBy: string;
};
type Footprint = { id: string; title: string; notebookId: string; updatedAt: string };
type InboxData = { inbox: CalendarItem[]; groups: Array<{ noteId: string; noteTitle: string; items: CalendarItem[] }>; overdue: number; me: string; workspaceKind: string; canEdit: boolean };
type Member = { userId: string; displayName: string; handle: string };
type QuickPreview = { title: string; startsAt: string | null; endsAt: string | null; dueAt: string | null; allDay: boolean; priority: number; rrule: string | null; chips: Array<{ kind: string; text: string }> };

type View = "day" | "week" | "month" | "agenda";
const VIEWS: Array<{ id: View; label: string; key: string }> = [
  { id: "day", label: "日", key: "d" },
  { id: "week", label: "周", key: "w" },
  { id: "month", label: "月", key: "m" },
  { id: "agenda", label: "议程", key: "a" },
];
const WEEK_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const HOUR_PX = 48;

// 视图里一律用「当地民用日」运算：把渲染时区的墙钟塞进 UTC 字段，避免浏览器本地时区插一脚。
function civil(iso: string | Date, tz: string) {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const p: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute));
}
const dayKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
const atMidnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);
const mondayOf = (d: Date) => addDays(atMidnight(d), -((d.getUTCDay() + 6) % 7));
const minutesOf = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();
const fmtHM = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

/** 把当地墙钟发回服务端时必须带上真实偏移，否则 GMT+8 的 15:00 会被当成 15:00Z。 */
function wallToIso(civilDate: Date, tz: string) {
  const guess = Date.UTC(civilDate.getUTCFullYear(), civilDate.getUTCMonth(), civilDate.getUTCDate(), civilDate.getUTCHours(), civilDate.getUTCMinutes());
  let real = new Date(guess);
  for (let i = 0; i < 2; i++) real = new Date(guess - (civil(real, tz).getTime() - real.getTime()));
  return real.toISOString();
}

function rangeOf(view: View, cursor: Date) {
  if (view === "month") {
    const first = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1));
    const start = mondayOf(first);
    return { start, end: addDays(start, 42), days: 42 };
  }
  if (view === "week") return { start: mondayOf(cursor), end: addDays(mondayOf(cursor), 7), days: 7 };
  if (view === "day") return { start: atMidnight(cursor), end: addDays(atMidnight(cursor), 1), days: 1 };
  return { start: atMidnight(cursor), end: addDays(atMidnight(cursor), 14), days: 14 };
}

export function CalendarPage() {
  const { wsId = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const narrow = useNarrow();
  // URL 上没写 view 时，窄屏默认议程——月网格在手机上一格塞不下一条
  const view = (VIEWS.find(v => v.id === params.get("view"))?.id ?? (narrow ? "agenda" : "month")) as View;
  const [tz, setTz] = useState("Asia/Shanghai");
  const cursor = useMemo(() => {
    const raw = params.get("date");
    const parsed = raw ? new Date(`${raw}T00:00:00Z`) : null;
    // 越界日期夹回今天而不是白屏
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() < 1970 || parsed.getUTCFullYear() > 2100) return atMidnight(civil(new Date(), tz));
    return parsed;
  }, [params, tz]);
  const layers = useMemo(() => new Set((params.get("layers") ?? "task,event,note").split(",")), [params]);

  const [items, setItems] = useState<CalendarItem[]>([]);
  const [footprints, setFootprints] = useState<Footprint[]>([]);
  const [panel, setPanel] = useState<InboxData>({ inbox: [], groups: [], overdue: 0, me: "", workspaceKind: "personal", canEdit: true });
  const [showPanel, setShowPanel] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [quick, setQuick] = useState<{ open: boolean; text: string; preview: QuickPreview | null }>({ open: false, text: "", preview: null });
  const [syncOpen, setSyncOpen] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    // 指派只在团队工作区有意义，但成员列表本身对谁都无害，失败也不该打断日历
    api<{ members: Member[] }>(`/api/v1/workspaces/${wsId}/members`).then(r => setMembers(r.members)).catch(() => {});
  }, [wsId]);
  const quickRef = useRef<HTMLInputElement>(null);
  const today = dayKey(civil(new Date(), tz));

  const setView = (v: View) => setParams(p => { p.set("view", v); return p; }, { replace: true });
  const setCursor = (d: Date) => setParams(p => { p.set("date", dayKey(d)); return p; }, { replace: true });
  const toggleLayer = (name: string) => setParams(p => {
    const next = new Set(layers);
    if (next.has(name)) next.delete(name); else next.add(name);
    p.set("layers", [...next].join(","));
    return p;
  }, { replace: true });

  const { start, end } = rangeOf(view, cursor);
  const load = useCallback(async () => {
    setLoadError("");
    try {
      const [grid, inbox] = await Promise.all([
        api<{ items: CalendarItem[]; notes: Footprint[]; timezone: string }>(`/api/v1/workspaces/${wsId}/calendar?from=${wallToIso(start, tz)}&to=${wallToIso(end, tz)}&layers=${[...layers].join(",")}`),
        api<InboxData>(`/api/v1/workspaces/${wsId}/calendar/inbox`),
      ]);
      setItems(grid.items);
      setFootprints(grid.notes);
      setTz(grid.timezone);
      setPanel(inbox);
    } catch (e) {
      // 加载失败不清空已渲染内容，只挂一条可重试的错误
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [wsId, start.getTime(), end.getTime(), [...layers].join(","), tz]);
  useEffect(() => { void load(); }, [load]);

  /**
   * 撤销栈只保留当前会话最近 20 步（设计 16 §3.7）。服务端不做反向日志，
   * 但每步都写了 audit_logs，所以「谁把它挪到哪儿」永远查得到。
   */
  const undoStack = useRef<Array<{ id: number; run: () => Promise<void> }>>([]);
  const undoSeq = useRef(0);
  function pushUndo(run: () => Promise<void>) {
    const id = ++undoSeq.current;
    undoStack.current = [...undoStack.current, { id, run }].slice(-20);
    return id;
  }
  const dropUndo = (id: number) => { undoStack.current = undoStack.current.filter(e => e.id !== id); };

  /** 乐观更新 + 失败回滚 + 撤销。改期、勾选、删除都走这里，保证反馈一致。 */
  async function act(label: string, apply: () => void, commit: () => Promise<unknown>, undo: () => Promise<unknown>, extra?: React.ReactNode) {
    const snapshot = items;
    apply();
    try {
      await commit();
      const id = pushUndo(async () => { await undo(); await load(); });
      toast.toast({
        title: label,
        description: <span className="flex items-center gap-3">{extra}<button className="underline underline-offset-2" onClick={async () => {
          // toast 上撤销过的，就不该再被 Ctrl+Z 撤第二遍
          dropUndo(id);
          try { await undo(); await load(); toast.success("已撤销"); } catch (e) { toast.error("撤销失败", (e as Error).message); }
        }}>撤销</button></span>,
        duration: 8000,
      });
      await load();
    } catch (e) {
      setItems(snapshot);
      toast.error("操作失败", (e as Error).message);
      await load();
    }
  }

  async function toggleDone(item: CalendarItem, done: boolean) {
    const before = item.status;
    await act(
      done ? "已完成" : "已恢复为未完成",
      () => setItems(v => v.map(x => (x.id === item.id && x.occurrenceStart === item.occurrenceStart ? { ...x, status: done ? "done" : "open" } : x))),
      async () => {
        const r = await api<{ noteWritten: boolean; detached: boolean }>(`/api/v1/calendar/items/${item.id}/complete`, { method: "POST", body: JSON.stringify({ done, occurrenceStart: item.recurring ? item.occurrenceStart : undefined }) });
        if (r.detached) toast.error("已脱离原文", "笔记里找不到这一行了，条目状态照记，但不再同步。");
        else if (r.noteWritten && item.sourceNoteTitle) toast.success(`已同步到《${item.sourceNoteTitle}》`);
      },
      () => api(`/api/v1/calendar/items/${item.id}/complete`, { method: "POST", body: JSON.stringify({ done: before === "done", occurrenceStart: item.recurring ? item.occurrenceStart : undefined }) }),
    );
  }

  // 重复条目改期一律先问「仅此一次 / 此后全部」，不替用户默认
  const [scopeAsk, setScopeAsk] = useState<{ item: CalendarItem; target: Date } | null>(null);
  function reschedule(item: CalendarItem, target: Date, copy = false) {
    if (copy) return duplicateTo(item, target);
    if (item.recurring) { setScopeAsk({ item, target }); return Promise.resolve(); }
    return doReschedule(item, target, "one");
  }

  /** 按住 Alt 拖拽 = 复制一份。撤销就是把新建的那条删掉，不动原件。 */
  async function duplicateTo(item: CalendarItem, target: Date) {
    const span = item.startsAt && item.endsAt ? new Date(item.endsAt).getTime() - new Date(item.startsAt).getTime() : 0;
    const startIso = wallToIso(target, tz);
    let createdId = "";
    await act(
      `已复制「${item.title}」`,
      () => {},
      async () => {
        const created = await api<{ id: string }>(`/api/v1/workspaces/${wsId}/calendar/items`, {
          method: "POST",
          body: JSON.stringify({
            kind: item.kind, title: item.title, allDay: item.allDay, priority: item.priority,
            startsAt: item.kind === "event" ? startIso : null,
            endsAt: item.kind === "event" && span ? new Date(new Date(startIso).getTime() + span).toISOString() : null,
            dueAt: startIso,
          }),
        });
        createdId = created.id;
      },
      () => api(`/api/v1/calendar/items/${createdId}`, { method: "DELETE" }),
    );
  }

  /** 拉伸改时长。重复条目走 scope=one，只给这一次留例外，不动整条序列。 */
  async function resizeItem(item: CalendarItem, endCivil: Date) {
    const startIso = item.startsAt ?? item.dueAt;
    if (!startIso) return;
    const beforeEnd = item.endsAt;
    const endIso = wallToIso(endCivil, tz);
    await act(
      `已改为 ${fmtHM(civil(startIso, tz))}–${fmtHM(endCivil)}`,
      () => setItems(v => v.map(x => (x.id === item.id && x.occurrenceStart === item.occurrenceStart ? { ...x, endsAt: endIso } : x))),
      () => api(`/api/v1/calendar/items/${item.id}/reschedule`, { method: "POST", body: JSON.stringify({ startsAt: startIso, endsAt: endIso, occurrenceStart: item.recurring ? item.occurrenceStart : undefined, scope: "one" }) }),
      () => api(`/api/v1/calendar/items/${item.id}/reschedule`, { method: "POST", body: JSON.stringify({ startsAt: startIso, endsAt: beforeEnd, occurrenceStart: item.recurring ? item.occurrenceStart : undefined, scope: "one" }) }),
    );
  }

  /** 在空白处划出的时段：就地起一条日程，回车即存。 */
  async function createEvent(startCivil: Date, endCivil: Date, title: string) {
    let createdId = "";
    await act(
      `已新建「${title}」`,
      () => {},
      async () => {
        const created = await api<{ id: string }>(`/api/v1/workspaces/${wsId}/calendar/items`, {
          method: "POST",
          body: JSON.stringify({ kind: "event", title, startsAt: wallToIso(startCivil, tz), endsAt: wallToIso(endCivil, tz) }),
        });
        createdId = created.id;
      },
      () => api(`/api/v1/calendar/items/${createdId}`, { method: "DELETE" }),
    );
  }

  /** 收件箱随手记：不走自然语言解析（§3.4 明说只在快速添加框做），标题即内容。 */
  async function captureToInbox(title: string) {
    try {
      await api(`/api/v1/workspaces/${wsId}/calendar/items`, { method: "POST", body: JSON.stringify({ kind: "task", title }) });
      await load();
    } catch (e) { toast.error("记不下来", (e as Error).message); }
  }

  /** 从日历拖回收件箱：清掉期限，条目落回「还没排期」。 */
  async function dropBackToInbox(p: DropPayload) {
    const item = items.find(i => i.id === p.id && i.occurrenceStart === p.occurrenceStart);
    if (!item || (!item.dueAt && !item.startsAt)) return;
    const before = { dueAt: item.dueAt, startsAt: item.startsAt, endsAt: item.endsAt };
    await act(
      `「${item.title}」已放回收件箱`,
      () => setItems(v => v.filter(x => !(x.id === item.id && x.occurrenceStart === item.occurrenceStart))),
      () => api(`/api/v1/calendar/items/${item.id}`, { method: "PATCH", body: JSON.stringify({ dueAt: null, startsAt: null, endsAt: null }) }),
      () => api(`/api/v1/calendar/items/${item.id}`, { method: "PATCH", body: JSON.stringify(before) }),
    );
  }

  async function setReminder(item: CalendarItem, offsetMin: number | null) {
    try {
      await api(`/api/v1/calendar/items/${item.id}/reminders`, {
        method: "PUT",
        body: JSON.stringify({ reminders: offsetMin === null ? [] : [{ kind: "relative", offsetMin, channel: "inapp" }] }),
      });
      toast.success(offsetMin === null ? "已取消提醒" : `已设提醒：提前 ${Math.abs(offsetMin) >= 1440 ? `${Math.abs(offsetMin) / 1440} 天` : Math.abs(offsetMin) >= 60 ? `${Math.abs(offsetMin) / 60} 小时` : `${Math.abs(offsetMin)} 分钟`}`);
    } catch (e) { toast.error("设提醒失败", (e as Error).message); }
  }

  async function assignTo(item: CalendarItem, userId: string | null) {
    const before = item.assigneeUserId;
    await act(
      userId ? `已指派给 ${members.find(m => m.userId === userId)?.displayName ?? "成员"}` : "已取消指派",
      () => setItems(v => v.map(x => (x.id === item.id ? { ...x, assigneeUserId: userId } : x))),
      () => api(`/api/v1/calendar/items/${item.id}`, { method: "PATCH", body: JSON.stringify({ assigneeUserId: userId }) }),
      () => api(`/api/v1/calendar/items/${item.id}`, { method: "PATCH", body: JSON.stringify({ assigneeUserId: before }) }),
    );
  }

  /** 写这天的日记：同一天只有一篇，第二次点是打开而不是再建一篇。 */
  async function openDiary(day?: Date) {
    try {
      const r = await api<{ noteId: string; created: boolean }>(`/api/v1/workspaces/${wsId}/calendar/diary`, {
        method: "POST",
        body: JSON.stringify(day ? { date: dayKey(day) } : {}),
      });
      nav(`/w/${wsId}/n/${r.noteId}`);
    } catch (e) { toast.error("打不开日记", (e as Error).message); }
  }

  async function doReschedule(item: CalendarItem, target: Date, scope: "one" | "following") {
    const source = item.startsAt ?? item.dueAt;
    if (!source) return;
    const before = civil(source, tz);
    await act(
      `已改到 ${target.getUTCMonth() + 1}月${target.getUTCDate()}日${target.getUTCHours() || target.getUTCMinutes() ? ` ${fmtHM(target)}` : ""}`,
      () => setItems(v => v.map(x => (x.id === item.id && x.occurrenceStart === item.occurrenceStart ? { ...x, startsAt: x.startsAt ? wallToIso(target, tz) : null, dueAt: wallToIso(target, tz) } : x))),
      () => api(`/api/v1/calendar/items/${item.id}/reschedule`, { method: "POST", body: JSON.stringify({ startsAt: wallToIso(target, tz), occurrenceStart: item.recurring ? item.occurrenceStart : undefined, scope }) }),
      () => api(`/api/v1/calendar/items/${item.id}/reschedule`, { method: "POST", body: JSON.stringify({ startsAt: wallToIso(before, tz), scope: "one" }) }),
    );
  }

  async function removeItem(item: CalendarItem) {
    await act(
      `已删除「${item.title}」`,
      () => setItems(v => v.filter(x => x.id !== item.id)),
      () => api(`/api/v1/calendar/items/${item.id}`, { method: "DELETE" }),
      () => api(`/api/v1/calendar/items/${item.id}/restore`, { method: "POST" }),
    );
  }

  // ── 键盘：全路径可达，且不和 Ctrl+K / Ctrl+S 打架 ──
  const focused = useMemo(() => items.find(i => `${i.id}:${i.occurrenceStart}` === focusKey) ?? null, [items, focusKey]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey) {
        if (e.key.toLowerCase() === "z" && undoStack.current.length) {
          e.preventDefault();
          const last = undoStack.current[undoStack.current.length - 1];
          undoStack.current = undoStack.current.slice(0, -1);
          void last.run().then(() => toast.success("已撤销")).catch(err => toast.error("撤销失败", (err as Error).message));
        }
        return;
      }
      const step = view === "month" ? 30 : view === "week" ? 7 : view === "agenda" ? 14 : 1;
      const key = e.key.toLowerCase();
      const jump = (n: number) => { e.preventDefault(); setCursor(addDays(cursor, n)); };
      if (VIEWS.some(v => v.key === key)) { e.preventDefault(); setView(VIEWS.find(v => v.key === key)!.id); }
      else if (key === "t") { e.preventDefault(); setCursor(atMidnight(civil(new Date(), tz))); }
      else if (key === "arrowleft" || key === "k") jump(-step);
      else if (key === "arrowright" || key === "j") jump(step);
      else if (key === "n") { e.preventDefault(); setQuick(q => ({ ...q, open: true })); setTimeout(() => quickRef.current?.focus(), 0); }
      else if (key === "escape") { setQuick({ open: false, text: "", preview: null }); setFocusKey(null); }
      else if (key === "arrowup" || key === "arrowdown") {
        // ←→ 管时间，↑↓ 管条目：两个方向各司其职，不互相抢
        e.preventDefault();
        if (!items.length) return;
        const at = items.findIndex(i => `${i.id}:${i.occurrenceStart}` === focusKey);
        const next = at < 0 ? (key === "arrowdown" ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, at + (key === "arrowdown" ? 1 : -1)));
        setFocusKey(`${items[next].id}:${items[next].occurrenceStart}`);
      }
      else if (key === "enter" && focused) {
        e.preventDefault();
        // 「打开条目」= 回到它的出处；凭空存在的条目没有出处，那就去建下一条
        if (focused.sourceNoteId) nav(`/w/${wsId}/n/${focused.sourceNoteId}`);
        else { setQuick(q => ({ ...q, open: true })); setTimeout(() => quickRef.current?.focus(), 0); }
      }
      else if (focused) {
        if (key === " ") { e.preventDefault(); if (focused.kind === "task") void toggleDone(focused, focused.status !== "done"); }
        else if (key === "backspace") { e.preventDefault(); void removeItem(focused); }
        else if (key === "[" || key === "]") {
          e.preventDefault();
          const base = focused.startsAt ?? focused.dueAt;
          if (base) void reschedule(focused, addDays(civil(base, tz), key === "[" ? -1 : 1));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cursor, view, focused, tz, items]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    for (const it of items) {
      const at = it.startsAt ?? it.dueAt;
      if (!at) continue;
      const k = dayKey(civil(at, tz));
      map.set(k, [...(map.get(k) ?? []), it]);
    }
    for (const list of map.values()) list.sort((a, b) => Number(new Date(a.startsAt ?? a.dueAt ?? 0)) - Number(new Date(b.startsAt ?? b.dueAt ?? 0)));
    return map;
  }, [items, tz]);

  const notesByDay = useMemo(() => {
    const map = new Map<string, Footprint[]>();
    for (const n of footprints) {
      const k = dayKey(civil(n.updatedAt, tz));
      map.set(k, [...(map.get(k) ?? []), n]);
    }
    return map;
  }, [footprints, tz]);

  const title = view === "month" || view === "agenda"
    ? `${cursor.getUTCFullYear()}年${cursor.getUTCMonth() + 1}月`
    : `${cursor.getUTCFullYear()}年${cursor.getUTCMonth() + 1}月${cursor.getUTCDate()}日`;

  return <div className="flex h-full min-h-0 flex-col bg-background">
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
      <Button variant="ghost" size="sm" onClick={() => nav(`/w/${wsId}`)}><ChevronRight className="rotate-180" />笔记</Button>
      <MiniMonthJump title={title} cursor={cursor} today={today} onPick={d => setCursor(d)} />
      <div className="ml-4 inline-flex rounded-lg bg-muted p-1">
        {VIEWS.map(v => <button key={v.id} onClick={() => setView(v.id)} title={`快捷键 ${v.key.toUpperCase()}`} className={cn("rounded-md px-3 py-1 text-sm transition", view === v.id ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}>{v.label}</button>)}
      </div>
      <div className="ml-auto flex items-center gap-1">
        {(["task", "event", "note"] as const).map(l => <button key={l} onClick={() => toggleLayer(l)} className={cn("rounded-md px-2 py-1 text-xs transition", layers.has(l) ? "bg-muted font-medium" : "text-muted-foreground/60")}>{{ task: "待办", event: "日程", note: "笔记" }[l]}</button>)}
        <span className="mx-2 text-xs text-muted-foreground">{tz}</span>
        <Button variant="ghost" size="sm" onClick={() => setCursor(addDays(cursor, view === "month" ? -30 : view === "week" ? -7 : view === "agenda" ? -14 : -1))} aria-label="上一段">‹</Button>
        <Button variant="outline" size="sm" onClick={() => setCursor(atMidnight(civil(new Date(), tz)))}>今天</Button>
        <Button variant="ghost" size="sm" onClick={() => setCursor(addDays(cursor, view === "month" ? 30 : view === "week" ? 7 : view === "agenda" ? 14 : 1))} aria-label="下一段">›</Button>
        <Button variant="ghost" size="sm" onClick={() => nav(`/w/${wsId}/today`)}>今天页</Button>
        <Button variant="ghost" size="sm" onClick={() => setSyncOpen(true)}>订阅</Button>
        <Button size="sm" onClick={() => { setQuick(q => ({ ...q, open: true })); setTimeout(() => quickRef.current?.focus(), 0); }}><Plus />新建</Button>
        <Button variant={showPanel ? "secondary" : "ghost"} size="sm" onClick={() => setShowPanel(v => !v)}><Inbox />待办{panel.overdue > 0 && <span className="ml-1 rounded-full bg-destructive px-1.5 text-[10px] text-destructive-foreground">{panel.overdue}</span>}</Button>
      </div>
    </header>

    {quick.open && <QuickAddBar wsId={wsId} state={quick} setState={setQuick} inputRef={quickRef} onCreated={() => { void load(); setQuick({ open: false, text: "", preview: null }); }} />}
    {loadError && <div className="flex items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm"><span className="flex-1">日历加载失败：{loadError}</span><Button size="sm" variant="outline" onClick={() => void load()}><RotateCcw />重试</Button></div>}
    {!loading && !loadError && view === "month" && items.length === 0 && <div className="flex items-center gap-3 border-b border-border bg-muted/30 px-4 py-2 text-sm">
      <span className="flex-1 text-muted-foreground">这个月还什么都没有。</span>
      <Button size="sm" variant="outline" onClick={() => void openDiary()}><PenLine />写今天的日记</Button>
      <Button size="sm" variant="outline" onClick={() => { setQuick(q => ({ ...q, open: true })); setTimeout(() => quickRef.current?.focus(), 0); }}><Plus />新建日程</Button>
    </div>}

    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-auto">
        {loading ? <GridSkeleton view={view} />
          : view === "month" && narrow ? <MonthCompact cursor={cursor} today={today} byDay={byDay} notesByDay={notesByDay} onToggle={toggleDone} onPick={setCursor} onDiary={openDiary} tz={tz} />
          : view === "month" ? <MonthGrid start={start} cursor={cursor} today={today} byDay={byDay} notesByDay={notesByDay} onDrop={reschedule} onToggle={toggleDone} onDiary={openDiary} focusKey={focusKey} setFocusKey={setFocusKey} tz={tz} />
          : view === "agenda" ? <AgendaList start={start} days={14} today={today} byDay={byDay} notesByDay={notesByDay} onToggle={toggleDone} onDiary={() => void openDiary()} focusKey={focusKey} setFocusKey={setFocusKey} tz={tz} />
          : <TimeGrid start={start} days={view === "week" ? 7 : 1} today={today} byDay={byDay} notesByDay={notesByDay} onDrop={reschedule} onToggle={toggleDone} onResize={resizeItem} onCreate={createEvent} focusKey={focusKey} setFocusKey={setFocusKey} tz={tz} />}
      </div>
      {showPanel && <TaskPanel narrow={narrow} data={panel} members={members} onToggle={toggleDone} onOpenNote={id => nav(`/w/${wsId}/n/${id}`)} onCapture={captureToInbox} onDropBack={dropBackToInbox} onReschedule={(i, t) => void reschedule(i, t)} onRemind={setReminder} onAssign={assignTo} tz={tz} />}
    </div>

    <CalendarSyncDialog wsId={wsId} open={syncOpen} onOpenChange={setSyncOpen} onChanged={() => void load()} />

    <Dialog open={!!scopeAsk} onOpenChange={open => { if (!open) setScopeAsk(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>这是重复条目</DialogTitle>
          <DialogDescription>「{scopeAsk?.item.title}」会重复出现。改期要作用到哪些？</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setScopeAsk(null)}>取消</Button>
          <Button variant="outline" onClick={() => { const ask = scopeAsk; setScopeAsk(null); if (ask) void doReschedule(ask.item, ask.target, "following"); }}>此后全部</Button>
          <Button onClick={() => { const ask = scopeAsk; setScopeAsk(null); if (ask) void doReschedule(ask.item, ask.target, "one"); }}>仅此一次</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}

/** 顶栏的迷你月历：点标题就能跳到任意一天，不必一路 ‹ › 翻过去（设计 16 §3.2）。 */
function MiniMonthJump({ title, cursor, today, onPick }: { title: string; cursor: Date; today: string; onPick: (d: Date) => void }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1)));
  useEffect(() => { if (open) setMonth(new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1))); }, [open, cursor]);
  useEffect(() => {
    if (!open) return;
    // 点外面就收起来：一个浮层赖在屏幕上比没有浮层更烦
    const away = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest("[data-kb-mini]")) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", esc); };
  }, [open]);

  const gridStart = mondayOf(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1)));
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const shift = (n: number) => setMonth(m => new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + n, 1)));

  return <div data-kb-mini className="relative ml-1">
    <button onClick={() => setOpen(v => !v)} aria-expanded={open} aria-haspopup="dialog" className="rounded-md px-1.5 py-0.5 text-base font-semibold tracking-[-.02em] hover:bg-muted">
      {title}<span className="ml-1 text-xs text-muted-foreground">▾</span>
    </button>
    {open && <div role="dialog" aria-label="跳到某一天" className="absolute left-0 top-full z-50 mt-1 w-64 rounded-xl border border-border bg-popover p-2 shadow-lg">
      <div className="flex items-center px-1 pb-1">
        <button onClick={() => shift(-1)} aria-label="上个月" className="rounded px-1.5 text-muted-foreground hover:bg-muted">‹</button>
        <span className="flex-1 text-center text-xs font-medium">{month.getUTCFullYear()}年{month.getUTCMonth() + 1}月</span>
        <button onClick={() => shift(1)} aria-label="下个月" className="rounded px-1.5 text-muted-foreground hover:bg-muted">›</button>
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {["一", "二", "三", "四", "五", "六", "日"].map(l => <div key={l} className="text-center text-[10px] text-muted-foreground">{l}</div>)}
        {cells.map(d => {
          const key = dayKey(d);
          return <button
            key={key}
            onClick={() => { onPick(d); setOpen(false); }}
            className={cn(
              "aspect-square rounded text-[11px] tabular-nums hover:bg-muted",
              d.getUTCMonth() !== month.getUTCMonth() && "text-muted-foreground/40",
              key === today && "bg-destructive font-semibold text-destructive-foreground hover:bg-destructive",
              key === dayKey(cursor) && key !== today && "bg-foreground text-background hover:bg-foreground",
            )}
          >{d.getUTCDate()}</button>;
        })}
      </div>
    </div>}
  </div>;
}

// ── 条目 ────────────────────────────────────────────────────────────────

function priorityDot(p: number) {
  return p >= 3 ? "bg-destructive" : p === 2 ? "bg-[var(--good)]" : p === 1 ? "bg-muted-foreground" : "";
}

function ItemChip({ item, tz, onToggle, compact, focused, onFocus }: { item: CalendarItem; tz: string; onToggle: (i: CalendarItem, done: boolean) => void; compact?: boolean; focused?: boolean; onFocus?: () => void }) {
  const at = item.startsAt ?? item.dueAt;
  const overdue = item.status === "open" && at && new Date(at).getTime() < Date.now();
  return <div
    draggable
    onDragStart={e => e.dataTransfer.setData("text/kb-item", JSON.stringify({ id: item.id, occurrenceStart: item.occurrenceStart }))}
    onClick={onFocus}
    tabIndex={0}
    onFocus={onFocus}
    aria-label={`${item.title}${item.status === "done" ? "，已完成" : ""}${overdue ? "，已逾期" : ""}`}
    className={cn(
      "group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs transition",
      "cursor-grab active:cursor-grabbing hover:bg-muted",
      focused && "ring-2 ring-ring",
      // 状态不只靠颜色：完成加删除线，逾期加图标
      item.status === "done" && "text-muted-foreground line-through",
      overdue && "text-destructive",
    )}
  >
    {item.kind === "task" && <input
      type="checkbox"
      className="size-3.5 shrink-0 accent-[var(--foreground)]"
      checked={item.status === "done"}
      onClick={e => e.stopPropagation()}
      onChange={e => onToggle(item, e.target.checked)}
      aria-label={`完成 ${item.title}`}
    />}
    {item.priority > 0 && <span className={cn("size-1.5 shrink-0 rounded-full", priorityDot(item.priority))} />}
    {!item.allDay && at && !compact && <span className="shrink-0 tabular-nums text-muted-foreground">{fmtHM(civil(at, tz))}</span>}
    <span className="truncate">{item.title}</span>
    {item.linkState === "detached" && <Link2Off className="size-3 shrink-0 text-destructive" aria-label="已脱离原文" />}
    {item.recurring && <RotateCcw className="size-3 shrink-0 text-muted-foreground/60" aria-label="重复" />}
  </div>;
}

type DropPayload = { id: string; occurrenceStart: string | null; copy: boolean };

function useDropTarget(onDrop: (payload: DropPayload) => void) {
  const [over, setOver] = useState<false | "move" | "copy">(false);
  return {
    over,
    handlers: {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes("text/kb-item")) return;
        e.preventDefault();
        // 按住 Alt 才是复制：落点的提示也要跟着变，否则松手才知道复制了一份
        e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
        setOver(e.altKey ? "copy" : "move");
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setOver(false);
        const raw = e.dataTransfer.getData("text/kb-item");
        if (raw) onDrop({ ...JSON.parse(raw), copy: e.altKey });
      },
    },
  };
}

// ── 月 ──────────────────────────────────────────────────────────────────

function MonthGrid(props: { start: Date; cursor: Date; today: string; byDay: Map<string, CalendarItem[]>; notesByDay: Map<string, Footprint[]>; onDrop: (i: CalendarItem, d: Date, copy: boolean) => void; onToggle: (i: CalendarItem, done: boolean) => void; onDiary: (d: Date) => void; focusKey: string | null; setFocusKey: (k: string | null) => void; tz: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(props.start, i));
  const all = [...props.byDay.values()].flat();
  return <div role="grid" aria-label="月视图" className="flex min-h-full flex-col">
    <div className="grid shrink-0 grid-cols-7 border-b border-border">
      {WEEK_LABELS.map(l => <div key={l} className="px-2 py-1.5 text-center text-xs text-muted-foreground">{l}</div>)}
    </div>
    <div className="grid flex-1 grid-cols-7 grid-rows-6">
      {cells.map(day => {
        const key = dayKey(day);
        const list = props.byDay.get(key) ?? [];
        const notes = props.notesByDay.get(key) ?? [];
        const outside = day.getUTCMonth() !== props.cursor.getUTCMonth();
        const isToday = key === props.today;
        const open = expanded === key;
        const shown = open ? list : list.slice(0, 3);
        return <MonthCell key={key} dayKeyStr={key} day={day} outside={outside} isToday={isToday} notes={notes} onDiary={() => props.onDiary(day)} onDrop={p => { const item = all.find(i => i.id === p.id && i.occurrenceStart === p.occurrenceStart); if (item) props.onDrop(item, day, p.copy); }}>
          {shown.map(it => <ItemChip key={`${it.id}:${it.occurrenceStart}`} item={it} tz={props.tz} onToggle={props.onToggle} compact focused={props.focusKey === `${it.id}:${it.occurrenceStart}`} onFocus={() => props.setFocusKey(`${it.id}:${it.occurrenceStart}`)} />)}
          {list.length > 3 && <div className="group/more relative">
            <button onClick={() => setExpanded(open ? null : key)} className="w-full rounded px-1.5 py-0.5 text-left text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
              {open ? "收起" : `还有 ${list.length - 3} 项`}
            </button>
            {/* 溢出不是死的「还有 N 项」：悬停就能看全，点击才原地展开（设计 16 §3.2） */}
            {!open && <div className="pointer-events-none absolute left-0 top-full z-40 hidden w-56 rounded-lg border border-border bg-popover p-1.5 shadow-lg group-hover/more:block">
              <p className="px-1.5 pb-1 text-[10px] text-muted-foreground">{day.getUTCMonth() + 1}月{day.getUTCDate()}日 · {list.length} 项</p>
              {list.map(it => <div key={`${it.id}:${it.occurrenceStart}`} className="truncate px-1.5 py-0.5 text-[11px]">
                {!it.allDay && (it.startsAt ?? it.dueAt) ? `${fmtHM(civil((it.startsAt ?? it.dueAt)!, props.tz))} ` : ""}{it.title}
              </div>)}
            </div>}
          </div>}
        </MonthCell>;
      })}
    </div>
  </div>;
}

function MonthCell({ day, dayKeyStr, outside, isToday, notes, onDrop, onDiary, children }: { day: Date; dayKeyStr: string; outside: boolean; isToday: boolean; notes: Footprint[]; onDrop: (p: DropPayload) => void; onDiary: () => void; children: React.ReactNode }) {
  const [showNotes, setShowNotes] = useState(false);
  const drop = useDropTarget(onDrop);
  return <div
    role="gridcell"
    aria-label={`${day.getUTCFullYear()}年${day.getUTCMonth() + 1}月${day.getUTCDate()}日，${notes.length} 篇笔记`}
    {...drop.handlers}
    className={cn("group/cell flex min-h-24 flex-col gap-0.5 border-b border-r border-border p-1 transition", outside && "bg-muted/20", drop.over && "bg-accent/40 ring-1 ring-inset ring-ring", drop.over === "copy" && "ring-2")}
  >
    <div className="flex items-center gap-1 px-1">
      <button onClick={onDiary} title="写这天的日记" aria-label={`写 ${day.getUTCMonth() + 1}月${day.getUTCDate()}日 的日记`} className="rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/cell:opacity-100"><PenLine className="size-3" /></button>
      <span className={cn("ml-auto grid size-5 place-items-center rounded-full text-[11px] tabular-nums", isToday ? "bg-destructive font-semibold text-destructive-foreground" : outside ? "text-muted-foreground/50" : "text-muted-foreground")}>{day.getUTCDate()}</span>
    </div>
    {children}
    {showNotes && notes.map(n => <span key={n.id} className="truncate px-1.5 text-[11px] text-muted-foreground">· {n.title}</span>)}
    {/* 笔记数角标在左下角，点开就是当天的足迹层（设计 16 §3.2） */}
    {notes.length > 0 && <button onClick={() => setShowNotes(v => !v)} className="mt-auto flex w-fit items-center gap-0.5 rounded px-1 text-[10px] text-muted-foreground hover:bg-muted" aria-label={`当天 ${notes.length} 篇笔记`}><FileText className="size-3" />{notes.length}</button>}
    <span className="sr-only">{dayKeyStr}</span>
  </div>;
}

/** 窄屏的月视图：上面一张迷你月历，下面当天列表。七列网格在手机上一格塞不下一条。 */
function MonthCompact(props: { cursor: Date; today: string; byDay: Map<string, CalendarItem[]>; notesByDay: Map<string, Footprint[]>; onToggle: (i: CalendarItem, done: boolean) => void; onPick: (d: Date) => void; onDiary: (d: Date) => void; tz: string }) {
  const first = new Date(Date.UTC(props.cursor.getUTCFullYear(), props.cursor.getUTCMonth(), 1));
  const cells = Array.from({ length: 42 }, (_, i) => addDays(mondayOf(first), i));
  const key = dayKey(props.cursor);
  const list = props.byDay.get(key) ?? [];
  const notes = props.notesByDay.get(key) ?? [];
  return <div className="flex min-h-full flex-col">
    <div className="grid grid-cols-7 gap-0.5 border-b border-border p-2">
      {WEEK_LABELS.map(l => <div key={l} className="text-center text-[10px] text-muted-foreground">{l.slice(1)}</div>)}
      {cells.map(d => {
        const k = dayKey(d);
        const count = props.byDay.get(k)?.length ?? 0;
        return <button
          key={k}
          onClick={() => props.onPick(d)}
          aria-label={`${d.getUTCMonth() + 1}月${d.getUTCDate()}日，${count} 项`}
          className={cn(
            "flex aspect-square flex-col items-center justify-center rounded-lg text-xs tabular-nums",
            d.getUTCMonth() !== props.cursor.getUTCMonth() && "text-muted-foreground/40",
            k === props.today && "bg-destructive font-semibold text-destructive-foreground",
            k === key && k !== props.today && "bg-foreground text-background",
          )}
        >
          {d.getUTCDate()}
          {/* 条目多少只用一个点表示：格子太小，塞标题只会糊成一团 */}
          <span className={cn("mt-0.5 size-1 rounded-full", count ? "bg-current opacity-70" : "opacity-0")} />
        </button>;
      })}
    </div>
    <div className="flex-1 space-y-1 p-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{props.cursor.getUTCMonth() + 1}月{props.cursor.getUTCDate()}日</h2>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => props.onDiary(props.cursor)}><PenLine />写日记</Button>
      </div>
      {list.map(it => <ItemChip key={`${it.id}:${it.occurrenceStart}`} item={it} tz={props.tz} onToggle={props.onToggle} />)}
      {notes.map(n => <div key={n.id} className="flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground"><FileText className="size-3" />{n.title}</div>)}
      {!list.length && !notes.length && <p className="py-6 text-center text-xs text-muted-foreground">这天没有安排。</p>}
    </div>
  </div>;
}

// ── 周 / 日 ──────────────────────────────────────────────────────────────

/** 15 分钟吸附；按住 Shift 关掉吸附（设计 16 §3.5）。 */
const SNAP_MIN = 15;
function snapMinutes(raw: number, noSnap: boolean) {
  const clamped = Math.max(0, Math.min(24 * 60, raw));
  return noSnap ? Math.round(clamped) : Math.round(clamped / SNAP_MIN) * SNAP_MIN;
}
const fmtMin = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

type Draft = { day: Date; from: number; to: number; editing: boolean };

/** 窄屏走另一套布局（设计 16 §3.9）：不做独立移动 App，但也不能让人在手机上看七列网格。 */
function useNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

function TimeGrid(props: { start: Date; days: number; today: string; byDay: Map<string, CalendarItem[]>; notesByDay: Map<string, Footprint[]>; onDrop: (i: CalendarItem, d: Date, copy: boolean) => void; onToggle: (i: CalendarItem, done: boolean) => void; onResize: (i: CalendarItem, end: Date) => void; onCreate: (start: Date, end: Date, title: string) => void; focusKey: string | null; setFocusKey: (k: string | null) => void; tz: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => civil(new Date(), props.tz));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [resizing, setResizing] = useState<{ key: string; to: number } | null>(null);
  useEffect(() => { const t = setInterval(() => setNow(civil(new Date(), props.tz)), 60_000); return () => clearInterval(t); }, [props.tz]);
  // 首次进入滚到「当前时间 − 2 小时」，而不是从 00:00 开始让人自己找
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = Math.max(0, (now.getUTCHours() - 2) * HOUR_PX); }, []);
  const days = Array.from({ length: props.days }, (_, i) => addDays(props.start, i));
  const all = [...props.byDay.values()].flat();

  /**
   * 全天区：全天条目和跨天条目都归这里，跨天的按覆盖列贯通成一根横条，
   * 而不是在每一列各画一段——切成好几段的横条读起来根本不像同一件事。
   */
  const bands = useMemo(() => {
    const spanOf = (it: CalendarItem) => {
      const at = it.startsAt ?? it.dueAt;
      if (!at) return null;
      const startLocal = civil(at, props.tz);
      // 结束时刻退 1 毫秒：正好停在午夜的事件属于前一天，不该多占一列
      const endLocal = it.endsAt ? civil(new Date(new Date(it.endsAt).getTime() - 1), props.tz) : startLocal;
      if (!it.allDay && dayKey(startLocal) === dayKey(endLocal)) return null;
      const idx = (d: Date) => days.findIndex(x => dayKey(x) === dayKey(d));
      const rawFrom = idx(startLocal), rawTo = idx(endLocal);
      const from = rawFrom >= 0 ? rawFrom : startLocal < days[0] ? 0 : -1;
      const to = rawTo >= 0 ? rawTo : endLocal > days[days.length - 1] ? days.length - 1 : -1;
      if (from < 0 || to < 0 || to < from) return null;
      return { item: it, from, to };
    };
    const seen = new Set<string>();
    return all.map(spanOf).filter((b): b is { item: CalendarItem; from: number; to: number } => {
      if (!b) return false;
      // 跨天条目在 byDay 里每天各挂一份，横条只画一次
      const key = `${b.item.id}:${b.item.occurrenceStart}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [all, days.map(dayKey).join(","), props.tz]);
  const inBand = new Set(bands.map(b => `${b.item.id}:${b.item.occurrenceStart}`));

  const drop = (day: Date, hour: number) => (p: DropPayload) => {
    const item = all.find(i => i.id === p.id && i.occurrenceStart === p.occurrenceStart);
    if (item) props.onDrop(item, new Date(day.getTime() + hour * 3600_000), p.copy);
  };

  /** 空白处按住拖拽 = 划时段建日程。点在条目上不算，否则拖条目会变成建日程。 */
  function beginDraft(day: Date, e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || (e.target as HTMLElement).closest("[data-kb-item]")) return;
    const box = e.currentTarget.getBoundingClientRect();
    const anchor = snapMinutes(((e.clientY - box.top) / HOUR_PX) * 60, e.shiftKey);
    setDraft({ day, from: anchor, to: anchor + SNAP_MIN, editing: false });
    const move = (ev: PointerEvent) => {
      const cur = snapMinutes(((ev.clientY - box.top) / HOUR_PX) * 60, ev.shiftKey);
      setDraft(d => (d ? { ...d, to: Math.max(cur, d.from + SNAP_MIN) } : d));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDraft(d => (d ? { ...d, editing: true } : d));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** 拖下边缘 = 改时长。落点在 pointerup 时才提交，中途只改本地高度。 */
  function beginResize(e: React.PointerEvent, item: CalendarItem, startLocal: Date) {
    e.preventDefault();
    e.stopPropagation();
    const column = (e.currentTarget as HTMLElement).closest("[data-kb-col]");
    if (!column) return;
    const box = column.getBoundingClientRect();
    const key = `${item.id}:${item.occurrenceStart}`;
    const floor = minutesOf(startLocal) + SNAP_MIN;
    const at = (ev: PointerEvent) => Math.max(floor, snapMinutes(((ev.clientY - box.top) / HOUR_PX) * 60, ev.shiftKey));
    const move = (ev: PointerEvent) => setResizing({ key, to: at(ev) });
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const end = at(ev);
      setResizing(null);
      // 没真的动就别写库：一次误点不该在版本与 toast 里留痕
      const before = item.endsAt ? minutesOf(civil(item.endsAt, props.tz)) : null;
      if (end !== before) props.onResize(item, new Date(atMidnight(startLocal).getTime() + end * 60_000));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return <div className="flex h-full flex-col">
    <div className="grid shrink-0 border-b border-border" style={{ gridTemplateColumns: `56px repeat(${props.days}, minmax(0,1fr))` }}>
      <div className="px-1 py-2 text-center text-[10px] text-muted-foreground">{props.tz.includes("Shanghai") ? "GMT+8" : ""}</div>
      {days.map(d => {
        const key = dayKey(d);
        const notes = props.notesByDay.get(key)?.length ?? 0;
        return <div key={key} className={cn("border-l border-border px-2 py-1.5 text-center", key === props.today && "bg-accent/30")}>
          <div className="text-xs text-muted-foreground">{WEEK_LABELS[(d.getUTCDay() + 6) % 7]}</div>
          <div className={cn("text-lg font-semibold tabular-nums", key === props.today && "text-destructive")}>{d.getUTCDate()}</div>
          {notes > 0 && <div className="flex items-center justify-center gap-0.5 text-[10px] text-muted-foreground"><FileText className="size-3" />{notes}</div>}
        </div>;
      })}
    </div>
    {/* 全天区固定在顶部，不跟着时间轴滚走（设计 16 §3.2） */}
    {bands.length > 0 && <div className="shrink-0 border-b border-border bg-muted/20">
      <div className="grid gap-y-0.5 py-1" style={{ gridTemplateColumns: `56px repeat(${props.days}, minmax(0,1fr))` }}>
        <div className="px-1 text-right text-[10px] leading-6 text-muted-foreground">全天</div>
        {bands.map((b, row) => <div
          key={`${b.item.id}:${b.item.occurrenceStart}`}
          className="min-w-0 px-1"
          style={{ gridColumn: `${2 + b.from} / span ${b.to - b.from + 1}`, gridRow: row + 1 }}
        >
          <div className="overflow-hidden rounded-md border border-border bg-background/95">
            <ItemChip item={b.item} tz={props.tz} onToggle={props.onToggle} compact focused={props.focusKey === `${b.item.id}:${b.item.occurrenceStart}`} onFocus={() => props.setFocusKey(`${b.item.id}:${b.item.occurrenceStart}`)} />
          </div>
        </div>)}
      </div>
    </div>}
    <div ref={scroller} className="relative min-h-0 flex-1 overflow-auto">
      <div className="grid" style={{ gridTemplateColumns: `56px repeat(${props.days}, minmax(0,1fr))` }}>
        <div>
          {Array.from({ length: 24 }, (_, h) => <div key={h} className="relative text-right text-[10px] text-muted-foreground" style={{ height: HOUR_PX }}><span className="absolute -top-1.5 right-1.5">{String(h).padStart(2, "0")}:00</span></div>)}
        </div>
        {days.map(day => {
          const key = dayKey(day);
          const list = props.byDay.get(key) ?? [];
          const mine = draft && dayKey(draft.day) === key ? draft : null;
          return <div key={key} data-kb-col className="relative border-l border-border" onPointerDown={e => beginDraft(day, e)}>
            {Array.from({ length: 24 }, (_, h) => <HourSlot key={h} onDrop={drop(day, h)} />)}
            {key === props.today && <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-destructive" style={{ top: (minutesOf(now) / 60) * HOUR_PX }}><span className="absolute -left-0.5 -top-1 size-2 rounded-full bg-destructive" /></div>}
            {list.map(it => {
              const at = it.startsAt ?? it.dueAt;
              if (!at) return null;
              const itemKey = `${it.id}:${it.occurrenceStart}`;
              if (inBand.has(itemKey)) return null;   // 已经在上面的全天区画过了
              const local = civil(at, props.tz);
              const endLocal = it.endsAt ? civil(it.endsAt, props.tz) : null;
              const top = (minutesOf(local) / 60) * HOUR_PX;
              const live = resizing?.key === itemKey ? ((resizing.to - minutesOf(local)) / 60) * HOUR_PX : null;
              const height = Math.max(20, live ?? (endLocal ? ((endLocal.getTime() - local.getTime()) / 3600_000) * HOUR_PX : 22));
              return <div key={itemKey} data-kb-item className={cn("group/item absolute inset-x-1 z-20 overflow-hidden rounded-md border border-border bg-background/95 shadow-sm", live !== null && "ring-2 ring-ring")} style={{ top, height }}>
                <ItemChip item={it} tz={props.tz} onToggle={props.onToggle} focused={props.focusKey === itemKey} onFocus={() => props.setFocusKey(itemKey)} />
                <div
                  role="separator"
                  aria-label={`拉伸改时长：${it.title}`}
                  draggable={false}
                  onDragStart={e => e.preventDefault()}
                  onPointerDown={e => beginResize(e, it, local)}
                  className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize bg-ring/50 opacity-0 transition group-hover/item:opacity-100"
                />
              </div>;
            })}
            {mine && <div className="absolute inset-x-1 z-30 rounded-md border-2 border-dashed border-ring bg-accent/50 p-1" style={{ top: (mine.from / 60) * HOUR_PX, height: Math.max(22, ((mine.to - mine.from) / 60) * HOUR_PX) }}>
              <div className="text-[10px] tabular-nums text-muted-foreground">{fmtMin(mine.from)}–{fmtMin(mine.to)}</div>
              {mine.editing && <input
                autoFocus
                placeholder="日程标题，回车即存"
                className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
                onPointerDown={e => e.stopPropagation()}
                onBlur={() => setDraft(null)}
                onKeyDown={e => {
                  if (e.key === "Escape") { setDraft(null); return; }
                  if (e.key !== "Enter") return;
                  const title = e.currentTarget.value.trim();
                  if (!title) { setDraft(null); return; }
                  setDraft(null);
                  props.onCreate(new Date(mine.day.getTime() + mine.from * 60_000), new Date(mine.day.getTime() + mine.to * 60_000), title);
                }}
              />}
            </div>}
          </div>;
        })}
      </div>
    </div>
  </div>;
}

function HourSlot({ onDrop }: { onDrop: (p: DropPayload) => void }) {
  const drop = useDropTarget(onDrop);
  return <div {...drop.handlers} className={cn("border-b border-border/60", drop.over === "move" && "bg-accent/50", drop.over === "copy" && "bg-accent/50 ring-1 ring-inset ring-ring")} style={{ height: HOUR_PX }} />;
}

// ── 议程 ────────────────────────────────────────────────────────────────

function AgendaList(props: { start: Date; days: number; today: string; byDay: Map<string, CalendarItem[]>; notesByDay: Map<string, Footprint[]>; onToggle: (i: CalendarItem, done: boolean) => void; onDiary: () => void; focusKey: string | null; setFocusKey: (k: string | null) => void; tz: string }) {
  const days = Array.from({ length: props.days }, (_, i) => addDays(props.start, i)).filter(d => (props.byDay.get(dayKey(d))?.length ?? 0) > 0 || (props.notesByDay.get(dayKey(d))?.length ?? 0) > 0);
  if (!days.length) return <Empty title="这两周没有安排" text="按 N 快速添加，或者从右侧待办里拖一条过来。" action={<Button size="sm" variant="outline" onClick={props.onDiary}><PenLine />写今天的日记</Button>} />;
  return <div className="divide-y divide-border">
    {days.map(d => {
      const key = dayKey(d);
      return <section key={key} className="flex gap-4 px-5 py-3">
        <div className="w-20 shrink-0">
          <div className={cn("text-2xl font-semibold tabular-nums", key === props.today && "text-destructive")}>{d.getUTCDate()}</div>
          <div className="text-xs text-muted-foreground">{WEEK_LABELS[(d.getUTCDay() + 6) % 7]}</div>
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          {(props.byDay.get(key) ?? []).map(it => <ItemChip key={`${it.id}:${it.occurrenceStart}`} item={it} tz={props.tz} onToggle={props.onToggle} focused={props.focusKey === `${it.id}:${it.occurrenceStart}`} onFocus={() => props.setFocusKey(`${it.id}:${it.occurrenceStart}`)} />)}
          {(props.notesByDay.get(key) ?? []).map(n => <div key={n.id} className="flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground"><FileText className="size-3" />{n.title}</div>)}
        </div>
      </section>;
    })}
  </div>;
}

// ── 右侧待办面板 ─────────────────────────────────────────────────────────

function TaskPanel({ narrow, data, members, onToggle, onOpenNote, onCapture, onDropBack, onReschedule, onRemind, onAssign, tz }: {
  narrow: boolean; data: InboxData; members: Member[];
  onToggle: (i: CalendarItem, done: boolean) => void;
  onOpenNote: (id: string) => void;
  onCapture: (title: string) => Promise<void>;
  onDropBack: (p: DropPayload) => void;
  onReschedule: (i: CalendarItem, target: Date) => void;
  onRemind: (i: CalendarItem, offsetMin: number | null) => void;
  onAssign: (i: CalendarItem, userId: string | null) => void;
  tz: string;
}) {
  const [filter, setFilter] = useState<"mine" | "all" | "overdue" | "week">("all");
  const [capture, setCapture] = useState("");
  const drop = useDropTarget(onDropBack);
  const now = Date.now();
  // 「本周」按当地民用周算（周一起），不是「往后七天」——用户问的是这一周还剩什么
  const weekStart = mondayOf(civil(new Date(), tz));
  const weekEnd = addDays(weekStart, 7);
  const keep = (i: CalendarItem) => {
    if (filter === "overdue") return i.status === "open" && !!i.dueAt && new Date(i.dueAt).getTime() < now;
    if (filter === "mine") return i.assigneeUserId ? i.assigneeUserId === data.me : i.createdBy === data.me;
    if (filter === "week") {
      if (!i.dueAt) return false;
      const local = civil(i.dueAt, tz);
      return local >= weekStart && local < weekEnd;
    }
    return true;
  };
  const inbox = data.inbox.filter(keep);

  return <aside
    {...drop.handlers}
    className={cn(
      "flex flex-col bg-muted/25 transition",
      narrow
        ? "fixed inset-x-0 bottom-0 z-40 h-[48vh] rounded-t-2xl border-t border-border shadow-[0_-8px_24px_rgba(0,0,0,.12)]"
        : "w-80 shrink-0 border-l border-border",
      drop.over && "bg-accent/30 ring-1 ring-inset ring-ring",
    )}
  >
    {narrow && <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />}
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-3">
      <span className="text-sm font-semibold">待办</span>
      <div className="ml-auto inline-flex rounded-md bg-muted p-0.5 text-xs">
        {([["all", "全部"], ["mine", "我的"], ["week", "本周"], ["overdue", "逾期"]] as const).map(([id, label]) =>
          <button key={id} onClick={() => setFilter(id)} className={cn("rounded px-2 py-0.5", filter === id ? "bg-background shadow-sm" : "text-muted-foreground")}>
            {label}{id === "overdue" && data.overdue > 0 && <span className="ml-1 text-destructive">{data.overdue}</span>}
          </button>)}
      </div>
    </div>
    {drop.over && <div className="border-b border-border bg-accent/40 px-3 py-1.5 text-xs text-muted-foreground">松手 = 清掉期限，放回收件箱</div>}
    <ScrollArea className="flex-1">
      <div className="space-y-4 p-3">
        <section>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground"><Inbox className="size-3.5" />收件箱</h3>
          {/* 收件箱是唯一允许「和笔记无关」的地方，所以录入必须一行一条、零摩擦 */}
          {data.canEdit && <Input
            value={capture}
            onChange={e => setCapture(e.target.value)}
            onKeyDown={async e => {
              if (e.key !== "Enter" || !capture.trim()) return;
              const title = capture.trim();
              setCapture("");
              await onCapture(title);
            }}
            placeholder="随手记一条，回车即存"
            className="mb-1.5 h-8 text-xs"
          />}
          <div className="space-y-0.5 rounded-lg border border-border bg-background p-1.5">
            {inbox.map(i => <PanelRow key={i.id} item={i} tz={tz} data={data} members={members} onToggle={onToggle} onReschedule={onReschedule} onRemind={onRemind} onAssign={onAssign} />)}
            {!inbox.length && <p className="px-1.5 py-2 text-xs text-muted-foreground">这里接住随手记。也可以在笔记里写 <code className="rounded bg-muted px-1">- [ ] 事情</code>，它会自动出现在下面。</p>}
          </div>
        </section>
        {data.groups.map(g => {
          const rows = g.items.filter(keep);
          if (!rows.length) return null;
          return <section key={g.noteId}>
            <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <Star className="size-3.5" /><span className="truncate">{g.noteTitle}</span>
              <button className="ml-auto rounded p-0.5 hover:bg-muted" onClick={() => onOpenNote(g.noteId)} aria-label="跳到原文"><ChevronRight className="size-3.5" /></button>
            </h3>
            <div className="space-y-0.5 rounded-lg border border-border bg-background p-1.5">
              {rows.map(i => <PanelRow key={`${i.id}:${i.occurrenceStart}`} item={i} tz={tz} data={data} members={members} onToggle={onToggle} onReschedule={onReschedule} onRemind={onRemind} onAssign={onAssign} />)}
            </div>
          </section>;
        })}
      </div>
    </ScrollArea>
  </aside>;
}

/** 面板里的一行：hover 才露出「改期 / 设提醒 / 指派」，平时不抢注意力。 */
function PanelRow({ item, tz, data, members, onToggle, onReschedule, onRemind, onAssign }: {
  item: CalendarItem; tz: string; data: InboxData; members: Member[];
  onToggle: (i: CalendarItem, done: boolean) => void;
  onReschedule: (i: CalendarItem, target: Date) => void;
  onRemind: (i: CalendarItem, offsetMin: number | null) => void;
  onAssign: (i: CalendarItem, userId: string | null) => void;
}) {
  const [open, setOpen] = useState<"" | "date" | "remind" | "assign">("");
  const due = item.dueAt ? civil(item.dueAt, tz) : null;
  const assignee = members.find(m => m.userId === item.assigneeUserId);
  // 来自笔记的条目改期要回原文改，这里不给假入口
  const editable = data.canEdit && item.source !== "note";

  return <div className="group/row rounded-md">
    <div className="flex items-start">
      <div className="min-w-0 flex-1"><ItemChip item={item} tz={tz} onToggle={onToggle} compact /></div>
      {data.canEdit && <div className="flex shrink-0 items-center gap-0.5 pt-1 opacity-0 transition group-hover/row:opacity-100 focus-within:opacity-100">
        <button aria-label="改期" title={editable ? "改期" : "这条来自笔记，请到原文改"} disabled={!editable} onClick={() => setOpen(o => (o === "date" ? "" : "date"))} className="rounded p-0.5 hover:bg-muted disabled:opacity-30"><CalendarDays className="size-3" /></button>
        <button aria-label="设提醒" title="设提醒" onClick={() => setOpen(o => (o === "remind" ? "" : "remind"))} className="rounded p-0.5 hover:bg-muted"><BellRing className="size-3" /></button>
        {data.workspaceKind !== "personal" && <button aria-label="指派" title="指派" onClick={() => setOpen(o => (o === "assign" ? "" : "assign"))} className="rounded p-0.5 hover:bg-muted"><UserPlus className="size-3" /></button>}
      </div>}
    </div>
    {due && <span className="block px-7 text-[10px] text-muted-foreground">
      {due.getUTCMonth() + 1}月{due.getUTCDate()}日{!item.allDay && ` ${fmtHM(due)}`}
      {assignee && ` · @${assignee.handle}`}
    </span>}

    {open === "date" && <div className="mt-1 px-7">
      <input
        type="date"
        autoFocus
        defaultValue={due ? dayKey(due) : ""}
        className="h-7 w-full rounded border border-border bg-background px-1.5 text-xs"
        onChange={e => {
          if (!e.target.value) return;
          const [y, m, d] = e.target.value.split("-").map(Number);
          // 保留原来的时刻，只换日期：改期不该顺手把 15:00 抹成 00:00
          const at = new Date(Date.UTC(y, m - 1, d, due?.getUTCHours() ?? 0, due?.getUTCMinutes() ?? 0));
          setOpen("");
          onReschedule(item, at);
        }}
      />
    </div>}

    {open === "remind" && <div className="mt-1 flex flex-wrap gap-1 px-7">
      {([["提前 10 分钟", -10], ["提前 1 小时", -60], ["提前 1 天", -1440], ["不提醒", null]] as const).map(([label, offset]) =>
        <button key={label} onClick={() => { setOpen(""); onRemind(item, offset); }} className="rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-muted">{label}</button>)}
    </div>}

    {open === "assign" && <div className="mt-1 px-7">
      <select
        autoFocus
        defaultValue={item.assigneeUserId ?? ""}
        className="h-7 w-full rounded border border-border bg-background px-1 text-xs"
        onChange={e => { setOpen(""); onAssign(item, e.target.value || null); }}
      >
        <option value="">不指派</option>
        {members.map(m => <option key={m.userId} value={m.userId}>{m.displayName}（@{m.handle}）</option>)}
      </select>
    </div>}
  </div>;
}

// ── 快速添加 ─────────────────────────────────────────────────────────────

function QuickAddBar({ wsId, state, setState, inputRef, onCreated }: { wsId: string; state: { open: boolean; text: string; preview: QuickPreview | null }; setState: (fn: (s: { open: boolean; text: string; preview: QuickPreview | null }) => { open: boolean; text: string; preview: QuickPreview | null }) => void; inputRef: React.RefObject<HTMLInputElement | null>; onCreated: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // 解析只做预览，让人先看芯片确认；绝不静默猜错时间就写库
  useEffect(() => {
    if (!state.text.trim()) { setState(s => ({ ...s, preview: null })); return; }
    const t = setTimeout(async () => {
      try {
        const r = await api<{ preview: QuickPreview }>(`/api/v1/workspaces/${wsId}/calendar/quick-add`, { method: "POST", body: JSON.stringify({ text: state.text }) });
        setState(s => ({ ...s, preview: r.preview }));
      } catch { /* 预览失败不打断输入 */ }
    }, 250);
    return () => clearTimeout(t);
  }, [state.text, wsId]);

  async function commit() {
    if (!state.text.trim() || busy) return;
    setBusy(true);
    try {
      await api(`/api/v1/workspaces/${wsId}/calendar/quick-add`, { method: "POST", body: JSON.stringify({ text: state.text, commit: true }) });
      onCreated();
    } catch (e) { toast.error("创建失败", (e as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="border-b border-border bg-muted/30 px-4 py-2.5">
    <div className="flex items-center gap-2">
      <Input ref={inputRef} value={state.text} onChange={e => setState(s => ({ ...s, text: e.target.value }))} onKeyDown={e => { if (e.key === "Enter") void commit(); if (e.key === "Escape") setState(() => ({ open: false, text: "", preview: null })); }} placeholder="明天下午3点 和销售团队对齐季度数据 !高 30分钟" className="flex-1" />
      <Button size="sm" disabled={busy || !state.text.trim()} onClick={() => void commit()}>添加</Button>
    </div>
    {state.preview && <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">将创建：</span>
      <span className="font-medium">{state.preview.title || "（无标题）"}</span>
      {state.preview.chips.map((chip, i) => <Badge key={i} className="font-normal">{chip.text}</Badge>)}
      {!state.preview.chips.length && <span className="text-muted-foreground">没认出时间，会放进收件箱</span>}
    </div>}
  </div>;
}

// ── 骨架与空态 ───────────────────────────────────────────────────────────

function GridSkeleton({ view }: { view: View }) {
  // 骨架保持行列结构，不用转圈：切换视图时布局不跳
  const cells = view === "month" ? 42 : view === "week" ? 7 : view === "agenda" ? 6 : 1;
  return <div className={cn("grid gap-px p-px", view === "month" ? "grid-cols-7" : view === "agenda" ? "grid-cols-1" : `grid-cols-${cells}`)}>
    {Array.from({ length: cells }, (_, i) => <div key={i} className="h-24 animate-pulse rounded bg-muted/60" />)}
  </div>;
}

function Empty({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) {
  return <div className="py-24 text-center">
    <span className="mx-auto grid size-12 place-items-center rounded-xl bg-muted text-muted-foreground"><CalendarDays /></span>
    <p className="mt-4 text-sm font-medium">{title}</p>
    <p className="mt-1 text-xs text-muted-foreground">{text}</p>
    {action && <div className="mt-4 flex justify-center">{action}</div>}
  </div>;
}

// ── ICS：订阅进来 / 导出出去 ───────────────────────────────────────────────

type Subscription = { id: string; name: string; url: string; enabled: boolean; lastSyncAt: string | null; lastError: string | null; failCount: number };
type Feed = { id: string; scope: "mine" | "workspace"; url: string; lastUsedAt: string | null };

function CalendarSyncDialog({ wsId, open, onOpenChange, onChanged }: { wsId: string; open: boolean; onOpenChange: (v: boolean) => void; onChanged: () => void }) {
  const toast = useToast();
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [form, setForm] = useState({ name: "", url: "" });
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([
        api<{ subscriptions: Subscription[] }>(`/api/v1/workspaces/${wsId}/calendar/subscriptions`),
        api<{ feeds: Feed[] }>(`/api/v1/workspaces/${wsId}/calendar/feed-tokens`),
      ]);
      setSubs(a.subscriptions);
      setFeeds(b.feeds);
    } catch (e) { toast.error("读取订阅失败", (e as Error).message); }
  }, [wsId]);
  useEffect(() => { if (open) void load(); }, [open, load]);

  async function run(key: string, fn: () => Promise<unknown>, okText?: string) {
    setBusy(key);
    try { await fn(); await load(); onChanged(); if (okText) toast.success(okText); }
    catch (e) { toast.error("操作失败", (e as Error).message); }
    finally { setBusy(""); }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>日历同步</DialogTitle>
        <DialogDescription>订阅外部日历（只读），或者把自己的日程导出成一个订阅地址。</DialogDescription>
      </DialogHeader>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">订阅外部日历</h3>
        <div className="flex gap-2">
          <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="名称" className="w-40" />
          <Input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://example.com/calendar.ics" className="flex-1" />
          <Button size="sm" disabled={!!busy || !form.name.trim() || !form.url.trim()} onClick={() => void run("add", async () => {
            await api(`/api/v1/workspaces/${wsId}/calendar/subscriptions`, { method: "POST", body: JSON.stringify({ name: form.name.trim(), url: form.url.trim() }) });
            setForm({ name: "", url: "" });
          }, "已添加，正在拉取")}>添加</Button>
        </div>
        {subs.map(s => <div key={s.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{s.name}</span>
              {!s.enabled && <Badge className="bg-destructive/15 font-normal text-destructive">已停用</Badge>}
            </div>
            <div className="truncate text-xs text-muted-foreground">{s.url}</div>
            {s.lastError
              ? <div className="text-xs text-destructive">同步失败（{s.failCount} 次）：{s.lastError}</div>
              : <div className="text-xs text-muted-foreground">{s.lastSyncAt ? `上次同步 ${new Date(s.lastSyncAt).toLocaleString("zh-CN")}` : "还没同步过"}</div>}
          </div>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run(s.id, () => api(`/api/v1/calendar/subscriptions/${s.id}/sync`, { method: "POST" }), "已同步")}>立即同步</Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run(s.id, () => api(`/api/v1/calendar/subscriptions/${s.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !s.enabled }) }))}>{s.enabled ? "停用" : "启用"}</Button>
          <Button size="sm" variant="ghost" className="text-destructive" disabled={!!busy} onClick={() => void run(s.id, () => api(`/api/v1/calendar/subscriptions/${s.id}`, { method: "DELETE" }), "已删除订阅")}>删除</Button>
        </div>)}
        {!subs.length && <p className="text-xs text-muted-foreground">订阅进来的内容只读：不能编辑、不能勾选，也不会写回对方。</p>}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">导出订阅地址</h3>
        {/* 这是日历唯一的对外通道，泄露面必须说清楚，而不是让人以为只是个链接 */}
        <p className="text-xs text-muted-foreground">知道这个地址的人可以看到你的日程<strong>标题与时间</strong>（不含笔记正文）。可以随时轮换或吊销。</p>
        {feeds.map(f => <div key={f.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
          <div className="min-w-0 flex-1">
            <Badge className="font-normal">{f.scope === "mine" ? "只含我的" : "整个工作区"}</Badge>
            <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{f.url}</div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard?.writeText(f.url); toast.success("已复制订阅地址"); }}>复制</Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run(f.id, () => api(`/api/v1/calendar/feed-tokens/${f.id}/rotate`, { method: "POST" }), "已轮换，旧地址立即失效")}>轮换</Button>
          <Button size="sm" variant="ghost" className="text-destructive" disabled={!!busy} onClick={() => void run(f.id, () => api(`/api/v1/calendar/feed-tokens/${f.id}`, { method: "DELETE" }), "已吊销")}>吊销</Button>
        </div>)}
        <div className="flex gap-2">
          {(["mine", "workspace"] as const).map(scope => <Button key={scope} size="sm" variant="outline" disabled={!!busy} onClick={() => void run(`new-${scope}`, () => api(`/api/v1/workspaces/${wsId}/calendar/feed-tokens`, { method: "POST", body: JSON.stringify({ scope }) }), "已生成订阅地址")}>
            <Plus />生成{scope === "mine" ? "「我的」" : "「工作区」"}地址
          </Button>)}
        </div>
      </section>
    </DialogContent>
  </Dialog>;
}

// ── 今天 ────────────────────────────────────────────────────────────────

type TodayData = { date: string; timezone: string; items: CalendarItem[]; overdue: CalendarItem[]; notes: Array<{ id: string; title: string; updatedAt: string }> };

export function TodayPage() {
  const { wsId = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [data, setData] = useState<TodayData | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setData(await api<TodayData>(`/api/v1/workspaces/${wsId}/today`)); setError(""); }
    catch (e) { setError((e as Error).message); }
  }, [wsId]);
  useEffect(() => { void load(); }, [load]);

  async function toggle(item: CalendarItem, done: boolean) {
    try {
      const r = await api<{ noteWritten: boolean; detached: boolean }>(`/api/v1/calendar/items/${item.id}/complete`, { method: "POST", body: JSON.stringify({ done, occurrenceStart: item.recurring ? item.occurrenceStart : undefined }) });
      if (r.detached) toast.error("已脱离原文", "笔记里找不到这一行了，条目状态照记，但不再同步。");
      else if (r.noteWritten && item.sourceNoteTitle) toast.success(`已同步到《${item.sourceNoteTitle}》`);
      await load();
    } catch (e) { toast.error("操作失败", (e as Error).message); }
  }

  async function openDiary() {
    try {
      const r = await api<{ noteId: string }>(`/api/v1/workspaces/${wsId}/calendar/diary`, { method: "POST", body: JSON.stringify({}) });
      nav(`/w/${wsId}/n/${r.noteId}`);
    } catch (e) { toast.error("打不开日记", (e as Error).message); }
  }

  const tz = data?.timezone ?? "Asia/Shanghai";
  const tasks = (data?.items ?? []).filter(i => i.kind === "task");
  const events = (data?.items ?? []).filter(i => i.kind === "event");
  const [y, m, d] = (data?.date ?? "").split("-");

  return <div className="flex h-full min-h-0 flex-col bg-background">
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
      <Button variant="ghost" size="sm" onClick={() => nav(`/w/${wsId}`)}><ChevronRight className="rotate-180" />笔记</Button>
      <h1 className="ml-1 text-base font-semibold tracking-[-.02em]">{data ? `${y}年${Number(m)}月${Number(d)}日` : "今天"}</h1>
      <div className="ml-auto flex items-center gap-1">
        <span className="mr-2 text-xs text-muted-foreground">{tz}</span>
        <Button variant="outline" size="sm" onClick={() => void openDiary()}><PenLine />写今天的日记</Button>
        <Button variant="ghost" size="sm" onClick={() => nav(`/w/${wsId}/calendar`)}><CalendarDays />日历</Button>
      </div>
    </header>

    {error && <div className="flex items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm">
      <span className="flex-1">加载失败：{error}</span><Button size="sm" variant="outline" onClick={() => void load()}><RotateCcw />重试</Button>
    </div>}

    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto grid max-w-4xl gap-5 p-5 md:grid-cols-2">
        {/* 逾期停在最前面，但不自动搬到今天：让人看见自己欠了什么 */}
        {!!data?.overdue.length && <section className="md:col-span-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3">
          <h2 className="mb-2 text-sm font-semibold text-destructive">逾期 {data.overdue.length}</h2>
          <div className="space-y-0.5">{data.overdue.map(i => <ItemChip key={i.id} item={i} tz={tz} onToggle={toggle} />)}</div>
        </section>}

        <section className="rounded-xl border border-border p-3">
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><Inbox className="size-4" />今天要做</h2>
          {tasks.length ? <div className="space-y-0.5">{tasks.map(i => <ItemChip key={`${i.id}:${i.occurrenceStart}`} item={i} tz={tz} onToggle={toggle} />)}</div>
            : <p className="text-xs text-muted-foreground">今天没有待办。</p>}
        </section>

        <section className="rounded-xl border border-border p-3">
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><CalendarDays className="size-4" />今天的日程</h2>
          {events.length ? <div className="space-y-0.5">{events.map(i => <ItemChip key={`${i.id}:${i.occurrenceStart}`} item={i} tz={tz} onToggle={toggle} />)}</div>
            : <p className="text-xs text-muted-foreground">今天没有日程。</p>}
        </section>

        <section className="rounded-xl border border-border p-3 md:col-span-2">
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><FileText className="size-4" />今天写过的笔记</h2>
          {data?.notes.length ? <div className="space-y-0.5">
            {data.notes.map(n => <button key={n.id} onClick={() => nav(`/w/${wsId}/n/${n.id}`)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-muted">
              <FileText className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{n.title}</span>
              <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{fmtHM(civil(n.updatedAt, tz))}</span>
            </button>)}
          </div> : <p className="text-xs text-muted-foreground">今天还没动过笔记。<button className="underline underline-offset-2" onClick={() => void openDiary()}>写点什么</button>。</p>}
        </section>
      </div>
    </ScrollArea>
  </div>;
}
