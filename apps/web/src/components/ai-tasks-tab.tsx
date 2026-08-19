import { useEffect, useRef, useState } from "react";
import { CheckSquare, ListChecks, Quote, Sparkles } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { FormError } from "./ui/form-error";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { useToast } from "./ui/toast";
import type { RailNote } from "./note-rail";

type Candidate = { title: string; day: string | null; startMin: number | null; priority: number; quote: string | null; dueAt: string | null };
type Draft = Candidate & { picked: boolean };

const PRIORITIES: Array<[number, string]> = [[0, "无"], [1, "低"], [2, "中"], [3, "高"]];

/** ISO → date input 要的 YYYY-MM-DD（按浏览器本地时区读，跟输入框自己的口径一致）。 */
function toDateInput(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * AI 从纪要里提待办（设计 16 §6.4）。
 *
 * 这一栏最要紧的一条：**提取只给候选，一条都不写库**。逐条改过、勾过，
 * 点了「创建」才落。模型抽风时宁可少给——猜错的待办比没有待办更糟，
 * 人会以为记全了。
 */
export function AiTasksTab({ note, workspaceId, onCreated }: {
  note: RailNote;
  workspaceId?: string;
  onCreated?: (count: number) => void;
}) {
  const toast = useToast();
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [dropped, setDropped] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);

  // 换笔记就清空，免得把上一篇的待办落到这一篇
  useEffect(() => { setDrafts(null); setError(""); setDropped(0); }, [note.id]);
  useEffect(() => () => abort.current?.abort(), []);

  async function extract() {
    if (!workspaceId) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true); setError("");
    try {
      const r = await api<{ candidates: Candidate[]; dropped: number }>(`/api/v1/workspaces/${workspaceId}/calendar/extract-tasks`, {
        method: "POST", body: JSON.stringify({ noteId: note.id }), signal: ctrl.signal,
      });
      setDrafts(r.candidates.map(x => ({ ...x, picked: true })));
      setDropped(r.dropped);
    } catch (e) { if (!ctrl.signal.aborted) setError((e as Error).message); }
    finally { if (!ctrl.signal.aborted) setBusy(false); }
  }

  async function create() {
    if (!workspaceId || !drafts) return;
    const picked = drafts.filter(d => d.picked && d.title.trim());
    if (!picked.length) return;
    setBusy(true); setError("");
    try {
      await api(`/api/v1/workspaces/${workspaceId}/calendar/tasks-from-note`, {
        method: "POST",
        body: JSON.stringify({ noteId: note.id, tasks: picked.map(d => ({ title: d.title.trim(), dueAt: d.dueAt, priority: d.priority })) }),
      });
      toast.success(`已创建 ${picked.length} 条待办`, "在日历和收件箱里能看到，改期删除都随意。");
      setDrafts(null);
      onCreated?.(picked.length);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const chosen = drafts?.filter(d => d.picked).length ?? 0;
  const patch = (i: number, part: Partial<Draft>) => setDrafts(list => list?.map((d, j) => (j === i ? { ...d, ...part } : d)) ?? null);

  if (!workspaceId) return <p className="p-4 text-xs text-muted-foreground">这篇笔记还没落到工作区里。</p>;

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="border-b border-border p-3">
      <p className="mb-2 text-xs leading-5 text-muted-foreground">
        把这篇纪要交给模型，挑出「需要有人去做的事」。<strong className="font-medium text-foreground">只给建议，不会自己写进日历</strong>——
        逐条看过、改过、勾过，点「创建」才落库。
      </p>
      <Button size="sm" disabled={busy} onClick={() => void extract()}>
        <Sparkles />{drafts ? "重新提取" : "提取待办"}
      </Button>
      <FormError>{error}</FormError>
    </div>

    {drafts && drafts.length === 0 && <div className="p-4 text-center">
      <p className="text-sm font-medium">没提取出待办</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        {dropped > 0 ? `模型给的 ${dropped} 条都已经在这篇的任务列表里了。` : "这篇里没有明确「谁要做什么」。把纪要写具体些再试。"}
      </p>
    </div>}

    {drafts && drafts.length > 0 && <>
      <ScrollArea className="min-h-0 flex-1"><div className="grid gap-2 p-3">
        {drafts.map((d, i) => <div key={i} className={cn("rounded-lg border border-border p-2", !d.picked && "opacity-50")}>
          <div className="flex items-start gap-2">
            <input type="checkbox" className="mt-2 size-3.5 shrink-0 accent-[var(--foreground)]" checked={d.picked}
              onChange={e => patch(i, { picked: e.target.checked })} aria-label={`要不要建「${d.title}」`} />
            <Input className="h-8 flex-1" value={d.title} onChange={e => patch(i, { title: e.target.value })} aria-label="待办标题" />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-6">
            <Input type="date" className="h-7 w-36 text-xs" value={toDateInput(d.dueAt)} aria-label="期限"
              onChange={e => patch(i, { dueAt: e.target.value ? new Date(`${e.target.value}T09:00:00`).toISOString() : null })} />
            {PRIORITIES.map(([p, label]) => <button key={p} type="button" aria-pressed={d.priority === p}
              onClick={() => patch(i, { priority: p })}
              className={cn("rounded border px-1.5 py-0.5 text-[10px]", d.priority === p ? "border-primary bg-primary/10" : "border-border hover:bg-muted")}>{label}</button>)}
          </div>
          {/* 让人一眼看出这条是从哪句话来的：对不上就说明模型在编 */}
          {d.quote && <p className="mt-1.5 flex items-start gap-1 pl-6 text-[11px] leading-4 text-muted-foreground">
            <Quote className="mt-0.5 size-2.5 shrink-0" /><span className="line-clamp-2">{d.quote}</span>
          </p>}
        </div>)}
        {dropped > 0 && <p className="text-[11px] text-muted-foreground"><ListChecks className="mr-1 inline size-3" />另有 {dropped} 条已经在这篇的任务列表里，没有重复列出。</p>}
      </div></ScrollArea>

      <div className="flex items-center gap-2 border-t border-border p-3">
        <span className="text-xs text-muted-foreground">选中 {chosen} / {drafts.length}</span>
        <Button size="sm" className="ml-auto" disabled={busy || !chosen} onClick={() => void create()}><CheckSquare />创建 {chosen} 条</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDrafts(null)}>丢弃</Button>
      </div>
    </>}
  </div>;
}
