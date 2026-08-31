import { useEffect, useRef, useState, type PointerEvent } from "react";
import { api } from "../api";
import { cn } from "../lib/utils";
import {
  type BoardCol, type Detail, type Milestone, type Project, type Pulse, type Task,
  flattenTasks, fmtClock, fmtMin, fmtSec, HEALTH_BAND_LABEL, healthTone, isoDate, toIso,
} from "./project-model";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { useToast } from "./ui/toast";

function addDays(d: Date, n: number) { return new Date(d.getTime() + n * 86400_000); }
function dayKey(d: Date) { return d.toISOString().slice(0, 10); }
function todayKey() { return isoDate(new Date().toISOString()); }

export function GanttView({ tasks, milestones, canEdit, onOpen, onFillDate, onReschedule, onAddMilestone }: {
  tasks: Task[]; milestones: Milestone[]; canEdit: boolean;
  onOpen: (t: Task) => void; onFillDate: (t: Task) => void;
  onReschedule: (id: string, startAt: string | null, dueAt: string | null) => Promise<void>;
  onAddMilestone?: (title: string, dueAt: string) => Promise<void>;
}) {
  const [milestoneTitle, setMilestoneTitle] = useState("");
  const [milestoneDue, setMilestoneDue] = useState(isoDate(new Date().toISOString()));
  const dated = flattenTasks(tasks).filter(t => t.startAt || t.dueAt);
  const undated = flattenTasks(tasks).filter(t => !t.startAt && !t.dueAt);
  const today = todayKey();
  const allDates = [
    ...dated.flatMap(t => [t.startAt, t.dueAt]),
    ...milestones.map(m => m.dueAt),
    today,
  ].filter((x): x is string => !!x).map(isoDate);
  const min = allDates.length ? allDates.reduce((a, b) => a < b ? a : b) : today;
  const max = allDates.length ? allDates.reduce((a, b) => a > b ? a : b) : today;
  const start = new Date(`${min}T00:00:00Z`);
  const end = addDays(new Date(`${max}T00:00:00Z`), 1);
  const days: Date[] = [];
  for (let d = start; d < end; d = addDays(d, 1)) days.push(d);
  const COL = 28;

  function span(t: { startAt: string | null; dueAt: string | null }) {
    const a = isoDate(t.startAt ?? t.dueAt);
    const b = isoDate(t.dueAt ?? t.startAt);
    const from = Math.max(0, Math.round((new Date(`${a}T00:00:00Z`).getTime() - start.getTime()) / 86400_000));
    const to = Math.max(from + 1, Math.round((new Date(`${b}T00:00:00Z`).getTime() - start.getTime()) / 86400_000) + 1);
    return { from, to };
  }

  return <div className="flex h-full min-h-0">
    <ScrollArea className="min-w-0 flex-1">
      <div className="min-w-max p-4">
        <div className="sticky top-0 z-10 mb-2 flex bg-background/90 text-[11px] text-muted-foreground backdrop-blur">
          <div className="w-40 shrink-0" />
          {days.map(d => {
            const key = dayKey(d);
            const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
            return <div key={key} className={cn("shrink-0 border-l border-border/60 px-0.5 text-center", weekend && "bg-muted/40", key === today && "text-foreground")} style={{ width: COL }}>{d.getUTCDate()}</div>;
          })}
        </div>
        {dated.map(t => {
          const { from, to } = span(t);
          return <div key={t.id} className="relative mb-1 flex h-8 items-center">
            <button className="w-40 shrink-0 truncate pr-2 text-left text-xs hover:underline" onClick={() => onOpen(t)}>{t.title}</button>
            <div className="relative h-8" style={{ width: days.length * COL }}>
              <div className="absolute inset-y-0 border-l border-primary/40" style={{ left: days.findIndex(d => dayKey(d) === today) * COL }} />
              <GanttBar left={from * COL} width={(to - from) * COL} canEdit={canEdit} onShift={delta => {
                const a = isoDate(t.startAt ?? t.dueAt)!;
                const b = isoDate(t.dueAt ?? t.startAt)!;
                const nextStart = dayKey(addDays(new Date(`${a}T00:00:00Z`), delta));
                const nextDue = dayKey(addDays(new Date(`${b}T00:00:00Z`), delta));
                void onReschedule(t.id, toIso(t.startAt ? nextStart : null), toIso(t.dueAt ? nextDue : t.startAt ? nextDue : null));
              }} onResize={(edge, delta) => {
                const a = isoDate(t.startAt ?? t.dueAt)!;
                const b = isoDate(t.dueAt ?? t.startAt)!;
                const nextStart = edge === "start" ? dayKey(addDays(new Date(`${a}T00:00:00Z`), delta)) : a;
                const nextDue = edge === "end" ? dayKey(addDays(new Date(`${b}T00:00:00Z`), delta)) : b;
                void onReschedule(t.id, toIso(nextStart), toIso(nextDue));
              }} />
            </div>
          </div>;
        })}
        {milestones.map(m => {
          const at = Math.round((new Date(`${isoDate(m.dueAt)}T00:00:00Z`).getTime() - start.getTime()) / 86400_000);
          return <div key={m.id} className="relative mb-1 flex h-6 items-center text-[11px] text-muted-foreground">
            <span className="w-40 shrink-0 truncate pr-2">◇ {m.title}</span>
            <div className="relative h-6" style={{ width: days.length * COL }}>
              <span className="absolute top-1 rotate-45 border border-foreground/70 bg-background" style={{ left: at * COL + 8, width: 8, height: 8 }} />
            </div>
          </div>;
        })}
      </div>
    </ScrollArea>
    <aside className="w-64 shrink-0 border-l border-border p-3">
      <p className="text-xs font-medium text-muted-foreground">补上日期</p>
      {undated.length ? undated.map(t => <button key={t.id} onClick={() => onFillDate(t)} className="mt-2 block w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted">{t.title}</button>)
        : <p className="mt-2 text-xs text-muted-foreground">有日期的条都在图上。</p>}
      {canEdit && onAddMilestone && <form className="mt-6 grid gap-2" onSubmit={e => {
        e.preventDefault();
        const title = milestoneTitle.trim();
        if (!title || !milestoneDue) return;
        void onAddMilestone(title, toIso(milestoneDue)!).then(() => setMilestoneTitle(""));
      }}>
        <p className="text-xs font-medium text-muted-foreground">加菱形里程碑</p>
        <Input value={milestoneTitle} onChange={e => setMilestoneTitle(e.target.value)} placeholder="里程碑名" />
        <Input type="date" value={milestoneDue} onChange={e => setMilestoneDue(e.target.value)} />
        <Button type="submit" size="sm" variant="outline" disabled={!milestoneTitle.trim()}>加上</Button>
      </form>}
    </aside>
  </div>;
}

function GanttBar({ left, width, canEdit, onShift, onResize }: {
  left: number; width: number; canEdit: boolean;
  onShift: (days: number) => void; onResize: (edge: "start" | "end", days: number) => void;
}) {
  const origin = useRef<{ x: number; mode: "move" | "start" | "end" } | null>(null);
  function down(mode: "move" | "start" | "end", e: PointerEvent) {
    if (!canEdit) return;
    e.preventDefault(); e.stopPropagation();
    origin.current = { x: e.clientX, mode };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function up(e: PointerEvent) {
    if (!origin.current) return;
    const delta = Math.round((e.clientX - origin.current.x) / 28);
    const mode = origin.current.mode;
    origin.current = null;
    if (!delta) return;
    if (mode === "move") onShift(delta);
    else onResize(mode, delta);
  }
  return <div className="absolute top-1.5 h-5 rounded-md bg-primary/80" style={{ left, width: Math.max(width, 16) }}
    onPointerDown={e => down("move", e)} onPointerUp={up}>
    {canEdit && <>
      <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize" onPointerDown={e => down("start", e)} />
      <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize" onPointerDown={e => down("end", e)} />
    </>}
  </div>;
}

export function TimeView({ projectId, data, liveSeconds = 0, canEdit, onStart, onStop, onLogged }: {
  projectId: string; data: Detail; liveSeconds?: number; canEdit: boolean;
  onStart: (id: string) => Promise<void>; onStop: () => Promise<void>; onLogged: () => void;
}) {
  const toast = useToast();
  const [entries, setEntries] = useState<Array<{ id: string; taskTitle: string; displayName: string; startedAt: string; endedAt: string | null; seconds: number; note: string }>>([]);
  const [form, setForm] = useState({ taskId: flattenTasks(data.tasks)[0]?.id ?? "", startedAt: "", endedAt: "", note: "补录" });
  useEffect(() => {
    api<{ entries: typeof entries }>(`/api/v1/projects/${projectId}/time`).then(d => setEntries(d.entries)).catch(() => {});
  }, [projectId, data.todaySeconds, data.running?.id]);
  useEffect(() => {
    const first = flattenTasks(data.tasks)[0]?.id ?? "";
    setForm(f => f.taskId && flattenTasks(data.tasks).some(t => t.id === f.taskId) ? f : { ...f, taskId: first });
  }, [data.tasks]);
  const allTasks = flattenTasks(data.tasks);
  const runningTask = allTasks.find(t => t.id === data.running?.taskId);
  return <ScrollArea className="h-full"><div className="mx-auto grid max-w-3xl gap-4 p-5">
    <section className="rounded-xl border p-4">
      <p className="text-sm font-medium">正在跑的一只</p>
      {data.running ? <div className="mt-2 flex items-center justify-between text-sm">
        <span>{runningTask?.title ?? "任务"} · {fmtClock(liveSeconds)} · 从 {new Date(data.running.startedAt).toLocaleTimeString()}</span>
        {canEdit && <Button size="sm" onClick={() => void onStop()}>停止</Button>}
      </div> : <p className="mt-2 text-xs text-muted-foreground">现在没人在计时。从下面挑一件开始。</p>}
      <p className="mt-3 text-xs text-muted-foreground">今日合计 {fmtSec(data.todaySeconds + (data.running ? liveSeconds : 0))}</p>
    </section>
    {canEdit && <section className="rounded-xl border p-4">
      <p className="text-sm font-medium">按任务补录</p>
      <form className="mt-3 grid gap-2 sm:grid-cols-2" onSubmit={async e => {
        e.preventDefault();
        try {
          await api(`/api/v1/projects/${projectId}/time`, { method: "POST", body: JSON.stringify({
            taskId: form.taskId,
            startedAt: new Date(form.startedAt).toISOString(),
            endedAt: new Date(form.endedAt).toISOString(),
            note: form.note || "补录",
          }) });
          toast.success("已补录");
          onLogged();
        } catch (err) { toast.error("补录失败", (err as Error).message); }
      }}>
        <select className="h-9 rounded-lg border border-input bg-background px-2 text-sm" value={form.taskId} onChange={e => setForm(f => ({ ...f, taskId: e.target.value }))}>
          {allTasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
        </select>
        <Input type="datetime-local" value={form.startedAt} onChange={e => setForm(f => ({ ...f, startedAt: e.target.value }))} required />
        <Input type="datetime-local" value={form.endedAt} onChange={e => setForm(f => ({ ...f, endedAt: e.target.value }))} required />
        <Input value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="备注，默认写补录" />
        <div className="sm:col-span-2"><Button type="submit" size="sm">记下</Button></div>
      </form>
      <div className="mt-4 flex flex-wrap gap-2">
        {allTasks.map(t => <Button key={t.id} size="sm" variant="outline" onClick={() => void onStart(t.id)}>{data.running?.taskId === t.id ? "正在跑" : "开始"} · {t.title}</Button>)}
      </div>
    </section>}
    <section className="rounded-xl border p-4">
      <p className="text-sm font-medium">账本</p>
      <div className="mt-2 space-y-1 text-xs">
        {entries.map(e => <div key={e.id} className="flex justify-between gap-2 rounded-md px-1 py-1">
          <span className="min-w-0 truncate">{e.taskTitle} · {e.displayName}{e.note ? ` · ${e.note}` : ""}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground">{e.endedAt ? fmtSec(e.seconds) : "进行中"}</span>
        </div>)}
        {!entries.length && <p className="text-muted-foreground">还没有工时。</p>}
      </div>
    </section>
  </div></ScrollArea>;
}

export function PulseView({ project, columns, pulse, onOpen }: { project: Project; columns: BoardCol[]; pulse: Pulse; onOpen?: (id: string) => void }) {
  const max = Math.max(1, ...pulse.days.map(d => Math.max(d.completed, d.minutes)));
  return <ScrollArea className="h-full"><div className="mx-auto grid max-w-3xl gap-4 p-5">
    <section className="rounded-xl border p-4">
      <p className="text-sm font-medium">状态环</p>
      <div className="mt-3 flex flex-wrap gap-3 text-sm">
        {columns.map(c => <span key={c.key}>{c.title} <strong className="tabular-nums">{pulse.byStatus[c.key] ?? 0}</strong></span>)}
        {(pulse.byStatus.cancelled ?? 0) > 0 && <span>不做了 <strong className="tabular-nums">{pulse.byStatus.cancelled}</strong></span>}
      </div>
      <p className={cn("mt-3 text-sm font-medium", healthTone(project.health.band))}>健康度 {project.health.score} {HEALTH_BAND_LABEL[project.health.band]}</p>
    </section>
    <section className="rounded-xl border p-4">
      <p className="text-sm font-medium">估时对实耗</p>
      <p className="mt-2 text-sm">{fmtMin(pulse.estimateMin)} vs {fmtSec(pulse.actualSeconds)}{project.health.overrun ? " · 已打穿" : ""}</p>
    </section>
    <section className="rounded-xl border p-4">
      <p className="text-sm font-medium">近 14 日</p>
      <div className="mt-3 flex items-end gap-1">
        {pulse.days.map(d => <div key={d.day} className="flex flex-1 flex-col items-center gap-1" title={`${d.day} · ${d.completed} 件 · ${d.minutes} 分钟`}>
          <div className="w-full rounded-sm bg-primary/80" style={{ height: 8 + (d.completed / max) * 48 }} />
          <span className="text-[10px] text-muted-foreground">{d.day.slice(8)}</span>
        </div>)}
      </div>
    </section>
    <section className="rounded-xl border p-4">
      <p className="text-sm font-medium">逾期</p>
      {pulse.overdue.length ? pulse.overdue.map(t => <button key={t.id} type="button" className="mt-1 block text-left text-sm hover:underline" onClick={() => onOpen?.(t.id)}>{t.title} · {isoDate(t.dueAt)}</button>) : <p className="mt-1 text-xs text-muted-foreground">无</p>}
      <p className="mt-4 text-sm font-medium">停滞</p>
      {pulse.stale.length ? pulse.stale.map(t => <button key={t.id} type="button" className="mt-1 block text-left text-sm hover:underline" onClick={() => onOpen?.(t.id)}>{t.title}</button>) : <p className="mt-1 text-xs text-muted-foreground">无</p>}
    </section>
  </div></ScrollArea>;
}
