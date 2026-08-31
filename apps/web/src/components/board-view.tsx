import { useState } from "react";
import { ChevronLeft, ChevronRight, MoreHorizontal, Plus } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";
import { type BoardCol, type ProjectTag, type Task, defaultCol, fmtMin, isoDate, isDoneStatus, PRI } from "./project-model";
import { TagChips, TagFilter } from "./project-tags";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useConfirm, usePrompt } from "./ui/confirm";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { useToast } from "./ui/toast";

export function BoardView({ projectId, columns, tasks, cancelled = [], tags = [], canEdit, onOpen, onQuickCreate, onMoved, onChanged }: {
  projectId: string; columns: BoardCol[]; tasks: Task[]; cancelled?: Task[]; tags?: ProjectTag[]; canEdit: boolean;
  onOpen: (t: Task) => void; onQuickCreate: (title: string) => Promise<void>;
  onMoved: (id: string, status: string, beforeId?: string) => Promise<void>;
  onChanged: () => Promise<void> | void;
}) {
  const ask = useConfirm();
  const askPrompt = usePrompt();
  const toast = useToast();
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [over, setOver] = useState<{ col: string; beforeId?: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const dest = defaultCol(columns);
  async function addColumn() {
    const title = await askPrompt({ title: "加一列", label: "列名", placeholder: "例如 阻塞", confirmText: "加上" });
    if (!title?.trim()) return;
    try {
      await api(`/api/v1/projects/${projectId}/columns`, { method: "POST", body: JSON.stringify({ title: title.trim() }) });
      await onChanged();
    } catch (e) { toast.error("加不了列", (e as Error).message); }
  }
  async function renameColumn(col: BoardCol) {
    const title = await askPrompt({ title: "改列名", label: "列名", defaultValue: col.title, confirmText: "保存" });
    if (!title?.trim() || title.trim() === col.title) return;
    try {
      await api(`/api/v1/project-columns/${col.id}`, { method: "PATCH", body: JSON.stringify({ title: title.trim() }) });
      await onChanged();
    } catch (e) { toast.error("改不了名", (e as Error).message); }
  }
  async function shiftColumn(col: BoardCol, dir: -1 | 1) {
    const ids = columns.map(c => c.id);
    const i = ids.indexOf(col.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const next = ids.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    try {
      await api(`/api/v1/projects/${projectId}/columns/reorder`, { method: "POST", body: JSON.stringify({ ids: next }) });
      await onChanged();
    } catch (e) { toast.error("换不了序", (e as Error).message); }
  }
  async function deleteColumn(col: BoardCol) {
    if (columns.length <= 1) { toast.error("至少留一列"); return; }
    const target = dest && dest.id !== col.id ? dest : columns.find(c => c.id !== col.id);
    if (!await ask({
      title: `删除「${col.title}」列？`,
      description: `列上的卡片会移到「${target?.title ?? "积压"}」，不会删掉。`,
      confirmText: "删除列",
      destructive: true,
    })) return;
    try {
      await api(`/api/v1/project-columns/${col.id}`, { method: "DELETE" });
      await onChanged();
    } catch (e) { toast.error("删不了列", (e as Error).message); }
  }
  if (!tasks.length && !cancelled.length) return <div className="grid h-full place-items-center p-8 text-center">
    <div className="w-full max-w-sm">
      <p className="text-sm font-medium">写下第一件要交的事</p>
      {canEdit && <form className="mt-4" onSubmit={async e => {
        e.preventDefault();
        const title = draft.trim();
        if (!title || busy) return;
        setBusy(true);
        try { await onQuickCreate(title); setDraft(""); }
        finally { setBusy(false); }
      }}>
        <Input autoFocus value={draft} onChange={e => setDraft(e.target.value)} placeholder="回车即建" disabled={busy} />
      </form>}
      {!canEdit && <p className="mt-2 text-xs text-muted-foreground">这个项目现在只读。</p>}
    </div>
  </div>;
  const visible = tagFilter ? tasks.filter(t => t.tags?.some(tag => tag.id === tagFilter)) : tasks;
  return <div className="flex h-full min-h-0 flex-col">
    <TagFilter tags={tags} value={tagFilter} onChange={setTagFilter} />
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
    {columns.map((col, index) => {
      const cards = visible.filter(t => t.status === col.key);
      return <section key={col.id} className="flex w-72 shrink-0 flex-col rounded-xl bg-muted/40"
        onDragOver={e => { if (!canEdit) return; e.preventDefault(); setOver({ col: col.key }); }}
        onDrop={e => { if (!canEdit) return; e.preventDefault(); const id = e.dataTransfer.getData("text/task-id"); if (id) void onMoved(id, col.key, over?.col === col.key ? over.beforeId : undefined); setOver(null); }}
        onDragLeave={() => setOver(null)}>
        <header className="flex items-center justify-between gap-1 px-2 py-2 text-xs font-medium text-muted-foreground">
          <span className="min-w-0 truncate px-1">{col.title}{col.isDefault ? " · 积压" : col.isDone ? " · 完成" : ""}</span>
          <span className="tabular-nums">{cards.length}</span>
          {canEdit && <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={`${col.title}列菜单`}><MoreHorizontal className="size-3.5" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void renameColumn(col)}>改名</DropdownMenuItem>
              <DropdownMenuItem disabled={index === 0} onSelect={() => void shiftColumn(col, -1)}><ChevronLeft className="size-3.5" />左移</DropdownMenuItem>
              <DropdownMenuItem disabled={index === columns.length - 1} onSelect={() => void shiftColumn(col, 1)}>右移<ChevronRight className="size-3.5" /></DropdownMenuItem>
              <DropdownMenuItem className="text-destructive" onSelect={() => void deleteColumn(col)}>删除列…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>}
        </header>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-2 px-2 pb-3">
            {cards.map(task => <article key={task.id} draggable={canEdit}
              onDragStart={e => { e.dataTransfer.setData("text/task-id", task.id); e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={e => { if (!canEdit) return; e.preventDefault(); e.stopPropagation(); setOver({ col: col.key, beforeId: task.id }); }}
              onClick={() => onOpen(task)}
              className={cn("cursor-pointer rounded-lg border border-border bg-background p-3 text-sm shadow-sm", over?.beforeId === task.id && "ring-1 ring-foreground/25")}>
              <p className="font-medium">{task.title}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                {task.priority > 0 && <Badge className="px-1.5">{PRI[task.priority]}</Badge>}
                {task.dueAt && <span>截止 {isoDate(task.dueAt)}</span>}
                {task.startAt && <span>起 {isoDate(task.startAt)}</span>}
                {task.estimateMin ? <span>估 {fmtMin(task.estimateMin)}</span> : null}
                {task.sourceNoteTitle && <span className="truncate">《{task.sourceNoteTitle}》</span>}
              </div>
              <TagChips tags={task.tags ?? []} className="mt-2" />
              {!!task.children?.length && <p className="mt-2 text-[11px] text-muted-foreground">{task.children.filter(c => isDoneStatus(c.status, columns)).length}/{task.children.length} 子任务</p>}
            </article>)}
          </div>
        </ScrollArea>
      </section>;
    })}
    {canEdit && <button type="button" onClick={() => void addColumn()} className="flex h-fit w-56 shrink-0 items-center justify-center gap-1 rounded-xl border border-dashed border-border px-3 py-8 text-sm text-muted-foreground hover:bg-muted/40">
      <Plus className="size-4" />加一列
    </button>}
    {!!cancelled.length && <section className="flex w-56 shrink-0 flex-col rounded-xl bg-muted/20">
      <header className="px-3 py-2 text-xs font-medium text-muted-foreground">不做了 <span className="tabular-nums">{cancelled.length}</span></header>
      <div className="space-y-1 px-2 pb-3">
        {cancelled.map(task => <button key={task.id} onClick={() => onOpen(task)} className="block w-full truncate rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground line-through hover:bg-muted">{task.title}</button>)}
      </div>
    </section>}
    </div>
  </div>;
}
