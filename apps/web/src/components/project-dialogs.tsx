import { useEffect, useState, type FormEvent } from "react";
import { ArrowRightLeft, X } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";
import {
  type BoardCol, type Member, type Milestone, type Project, type ProjectTag, type Task, type Workspace,
  COLOR_DOT, isoDate, isDoneStatus, openCol, PRI, STATUS_LABEL, toIso,
} from "./project-model";
import { TaskTagFields } from "./project-tags";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

export function ProjectDialog({ open, onOpenChange, onSubmit, project, canChangeVisibility = true, workspaces = [], initialWorkspaceId }: {
  open: boolean; onOpenChange: (v: boolean) => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
  project?: Project; canChangeVisibility?: boolean; workspaces?: Workspace[]; initialWorkspaceId?: string;
}) {
  const [title, setTitle] = useState(project?.title ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [status, setStatus] = useState(project?.status ?? "planning");
  const [color, setColor] = useState(project?.color ?? "ink");
  const [visibility, setVisibility] = useState(project?.visibility ?? "workspace");
  const [startAt, setStartAt] = useState(isoDate(project?.startAt ?? null));
  const [dueAt, setDueAt] = useState(isoDate(project?.dueAt ?? null));
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const workspaceOptionsKey = workspaces.map(workspace => workspace.id).join(",");
  useEffect(() => {
    if (!open) return;
    setTitle(project?.title ?? ""); setDescription(project?.description ?? "");
    setStatus(project?.status === "archived" ? "done" : (project?.status ?? "planning"));
    setColor(project?.color ?? "ink"); setVisibility(project?.visibility ?? "workspace");
    setStartAt(isoDate(project?.startAt ?? null)); setDueAt(isoDate(project?.dueAt ?? null));
    setWorkspaceId(initialWorkspaceId ?? workspaces[0]?.id ?? "");
    setErr("");
  }, [open, project, initialWorkspaceId, workspaceOptionsKey]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || (!project && !workspaceId)) return;
    setBusy(true); setErr("");
    try {
      await onSubmit({ title: title.trim(), description, status, color, startAt: toIso(startAt), dueAt: toIso(dueAt), ...(canChangeVisibility ? { visibility } : {}), ...(!project ? { workspaceId } : {}) });
    } catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>{project ? "编辑项目" : "建项目"}</DialogTitle><DialogDescription>{project ? "项目回答「什么时候交、卡在哪、花了多久」。" : "先确认项目放在哪里。项目成员、权限和任务指派都以这个工作区为准。"}</DialogDescription></DialogHeader>
    <form className="space-y-3" onSubmit={submit}>
      {!project && <label className="block rounded-xl border border-primary/25 bg-primary/5 p-3">
        <span className="mb-1.5 block text-xs font-semibold">归属工作区</span>
        <select autoFocus className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm" value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}>
          {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </select>
        <span className="mt-1.5 block text-[11px] text-muted-foreground">创建后仍可从项目菜单移动，链接和历史会保留。</span>
      </label>}
      <Input autoFocus={!!project} value={title} onChange={e => setTitle(e.target.value)} placeholder="项目名" />
      <Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="一句话说明" />
      <div className="grid grid-cols-2 gap-2">
        <select className="h-9 rounded-lg border border-input bg-background px-2 text-sm" value={status} onChange={e => setStatus(e.target.value as Project["status"])}>
          {(["planning", "active", "paused", "done"] as const).map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <select className="h-9 rounded-lg border border-input bg-background px-2 text-sm" value={visibility} disabled={!canChangeVisibility} onChange={e => setVisibility(e.target.value as Project["visibility"])}>
          <option value="workspace">工作区可见</option>
          <option value="private">仅自己</option>
        </select>
        <Input type="date" value={startAt} onChange={e => setStartAt(e.target.value)} />
        <Input type="date" value={dueAt} onChange={e => setDueAt(e.target.value)} />
      </div>
      <div className="flex gap-1">{(["ink", "accent", "good", "warn", "muted"] as const).map(c => <button type="button" key={c} onClick={() => setColor(c)} className={cn("size-6 rounded-full", COLOR_DOT[c], color === c && "ring-2 ring-offset-2 ring-foreground")} aria-label={c} />)}</div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button><Button disabled={busy || !title.trim() || (!project && !workspaceId)}>{busy ? "保存中…" : project ? "保存" : "创建项目"}</Button></div>
    </form>
  </DialogContent></Dialog>;
}

export function MoveProjectDialog({ open, project, currentWorkspaceName, targets, onOpenChange, onMoved }: {
  open: boolean; project: Project; currentWorkspaceName: string; targets: Workspace[];
  onOpenChange: (open: boolean) => void;
  onMoved: (workspaceId: string, moved: { tasks: number; clearedAssignees: number }) => void;
}) {
  const [workspaceId, setWorkspaceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const targetOptionsKey = targets.map(target => target.id).join(",");
  useEffect(() => {
    if (!open) return;
    setWorkspaceId(targets[0]?.id ?? ""); setErr("");
  }, [open, targetOptionsKey]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!workspaceId || busy) return;
    setBusy(true); setErr("");
    try {
      const result = await api<{ workspaceId: string; moved: { tasks: number; clearedAssignees: number } }>(`/api/v1/projects/${project.id}/move`, {
        method: "POST",
        body: JSON.stringify({ workspaceId }),
      });
      onOpenChange(false);
      onMoved(result.workspaceId, result.moved);
    } catch (error) { setErr((error as Error).message); }
    finally { setBusy(false); }
  }
  const targetName = targets.find(target => target.id === workspaceId)?.name ?? "目标工作区";
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader>
      <DialogTitle>移动项目</DialogTitle>
      <DialogDescription>项目、任务、里程碑和历史工时会一起移动，项目链接保持不变。</DialogDescription>
    </DialogHeader>
    <form className="space-y-4" onSubmit={submit}>
      <div className="rounded-xl border bg-muted/30 p-3 text-sm">
        <p className="font-medium">{project.title}</p>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><span>{currentWorkspaceName}</span><ArrowRightLeft className="size-3.5" /><span>{targetName}</span></p>
      </div>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted-foreground">目标工作区</span>
        <select autoFocus className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm" value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}>
          {targets.map(target => <option key={target.id} value={target.id}>{target.name}</option>)}
        </select>
      </label>
      <p className="text-xs leading-relaxed text-muted-foreground">若任务指派人不属于目标工作区，对应指派会被清空。正在运行计时时不会移动。</p>
      {err && <p className="text-sm text-destructive">{err}</p>}
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button><Button disabled={busy || !workspaceId}>{busy ? "移动中…" : "确认移动"}</Button></div>
    </form>
  </DialogContent></Dialog>;
}

export function TaskDialog({ open, task, columns, wsId, members, tags = [], milestones = [], canEdit, onOpenChange, onSubmit, onDelete, onOpenNote, onCreateChild, onToggleChild, onDeleteChild, onToggleTag, onMilestone }: {
  open: boolean; task: Task | null; columns: BoardCol[]; wsId: string; members: Member[];
  tags?: ProjectTag[]; milestones?: Milestone[]; canEdit: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
  onDelete?: () => Promise<void>;
  onOpenNote: (id: string) => void;
  onCreateChild?: (title: string) => Promise<void>;
  onToggleChild?: (id: string, done: boolean) => Promise<void>;
  onDeleteChild?: (id: string) => Promise<void>;
  onToggleTag?: (tagId: string, on: boolean) => Promise<void>;
  onMilestone?: (milestoneId: string | null) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [bodyMd, setBodyMd] = useState("");
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState(0);
  const [estimateMin, setEstimateMin] = useState("");
  const [startAt, setStartAt] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [assigneeUserId, setAssigneeUserId] = useState("");
  const [childTitle, setChildTitle] = useState("");
  const [sourceNoteId, setSourceNoteId] = useState<string | null>(null);
  const [sourceNoteTitle, setSourceNoteTitle] = useState<string | null>(null);
  const [noteQuery, setNoteQuery] = useState("");
  const [noteHits, setNoteHits] = useState<Array<{ id: string; title: string }>>([]);
  const [draftTagIds, setDraftTagIds] = useState<string[]>([]);
  const [draftMilestoneId, setDraftMilestoneId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!open) return;
    setTitle(task?.title ?? ""); setBodyMd(task?.bodyMd ?? "");
    setStatus((task?.status === "cancelled" ? (openCol(columns)?.key ?? "todo") : task?.status) ?? (openCol(columns)?.key ?? "todo"));
    setPriority(task?.priority ?? 0);
    setEstimateMin(task?.estimateMin ? String(task.estimateMin) : "");
    setStartAt(isoDate(task?.startAt ?? null)); setDueAt(isoDate(task?.dueAt ?? null));
    setAssigneeUserId(task?.assigneeUserId ?? ""); setChildTitle(""); setErr("");
    setSourceNoteId(task?.sourceNoteId ?? null); setSourceNoteTitle(task?.sourceNoteTitle ?? null);
    setNoteQuery(""); setNoteHits([]);
    setDraftTagIds(task?.tags?.map(t => t.id) ?? []);
    setDraftMilestoneId(task?.milestoneId ?? null);
  }, [open, task?.id]);
  useEffect(() => {
    if (!open || !canEdit) return;
    const q = noteQuery.trim();
    if (q.length < 1) { setNoteHits([]); return; }
    const t = window.setTimeout(() => {
      const params = new URLSearchParams({ q, workspaceId: wsId, titleOnly: "1", limit: "8", boards: "0" });
      api<{ hits: Array<{ id: string; title: string }> }>(`/api/v1/search?${params}`)
        .then(d => setNoteHits(d.hits.filter(h => h.id !== sourceNoteId)))
        .catch(() => setNoteHits([]));
    }, 220);
    return () => window.clearTimeout(t);
  }, [open, canEdit, noteQuery, wsId, sourceNoteId]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || !canEdit) return;
    setBusy(true); setErr("");
    try {
      await onSubmit({
        title: title.trim(), bodyMd, status, priority,
        estimateMin: estimateMin ? Number(estimateMin) : null,
        startAt: toIso(startAt), dueAt: toIso(dueAt),
        assigneeUserId: assigneeUserId || null,
        sourceNoteId,
        ...(!task ? { tagIds: draftTagIds, milestoneId: draftMilestoneId } : {}),
      });
    } catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>{task ? "任务" : "写下要交的事"}</DialogTitle><DialogDescription>不回写笔记正文。挂笔记只当入口。</DialogDescription></DialogHeader>
    <form className="space-y-3" onSubmit={submit}>
      <Input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="第一件要交的事" disabled={!canEdit} />
      <Textarea value={bodyMd} onChange={e => setBodyMd(e.target.value)} placeholder="备注，可选" disabled={!canEdit} />
      <div className="grid grid-cols-2 gap-2">
        <select className="h-9 rounded-lg border border-input bg-background px-2 text-sm" value={status} disabled={!canEdit} onChange={e => setStatus(e.target.value)}>
          {columns.map(c => <option key={c.key} value={c.key}>{c.title}</option>)}
        </select>
        <select className="h-9 rounded-lg border border-input bg-background px-2 text-sm" value={priority} disabled={!canEdit} onChange={e => setPriority(Number(e.target.value))}>
          {PRI.map((l, i) => <option key={i} value={i}>{l}优先级</option>)}
        </select>
        <Input type="number" min={1} value={estimateMin} disabled={!canEdit} onChange={e => setEstimateMin(e.target.value)} placeholder="估时（分钟）" />
        <select className="h-9 rounded-lg border border-input bg-background px-2 text-sm" value={assigneeUserId} disabled={!canEdit} onChange={e => setAssigneeUserId(e.target.value)}>
          <option value="">不指派</option>
          {members.map(m => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
        </select>
        <Input type="date" value={startAt} disabled={!canEdit} onChange={e => setStartAt(e.target.value)} />
        <Input type="date" value={dueAt} disabled={!canEdit} onChange={e => setDueAt(e.target.value)} />
      </div>
      <TaskTagFields
        tags={tags}
        selectedIds={task ? (task.tags?.map(t => t.id) ?? []) : draftTagIds}
        milestones={milestones}
        milestoneId={task ? (task.milestoneId ?? null) : draftMilestoneId}
        canEdit={canEdit}
        onToggleTag={(id, on) => {
          if (task && onToggleTag) return onToggleTag(id, on);
          setDraftTagIds(prev => on ? [...prev, id] : prev.filter(x => x !== id));
        }}
        onMilestone={id => {
          if (task && onMilestone) return onMilestone(id);
          setDraftMilestoneId(id);
        }}
      />
      {canEdit && <div className="space-y-2">
        {sourceNoteId ? <div className="flex items-center justify-between gap-2 text-xs">
          <button type="button" className="min-w-0 truncate underline" onClick={() => onOpenNote(sourceNoteId)}>挂着《{sourceNoteTitle || "笔记"}》</button>
          <Button type="button" size="sm" variant="ghost" onClick={() => { setSourceNoteId(null); setSourceNoteTitle(null); }}>摘掉</Button>
        </div> : <p className="text-xs text-muted-foreground">挂一篇笔记当入口，不回写正文。</p>}
        <Input value={noteQuery} onChange={e => setNoteQuery(e.target.value)} placeholder="搜标题，挂笔记" />
        {!!noteHits.length && <div className="max-h-32 overflow-y-auto rounded-md border">
          {noteHits.map(h => <button type="button" key={h.id} className="block w-full truncate px-2 py-1.5 text-left text-sm hover:bg-muted" onClick={() => {
            setSourceNoteId(h.id); setSourceNoteTitle(h.title); setNoteQuery(""); setNoteHits([]);
          }}>{h.title}</button>)}
        </div>}
      </div>}
      {!canEdit && sourceNoteId && <button type="button" className="text-xs underline" onClick={() => onOpenNote(sourceNoteId)}>打开挂着的笔记{sourceNoteTitle ? `《${sourceNoteTitle}》` : ""}</button>}
      {(onCreateChild || !!task?.children?.length) && <div className="space-y-2">
        {onCreateChild && <div className="flex gap-2">
          <Input value={childTitle} onChange={e => setChildTitle(e.target.value)} placeholder="加一层子任务" disabled={busy} onKeyDown={e => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            const next = childTitle.trim();
            if (!next || busy) return;
            setBusy(true); setErr("");
            void onCreateChild(next).then(() => setChildTitle("")).catch(x => setErr((x as Error).message)).finally(() => setBusy(false));
          }} />
          <Button type="button" size="sm" variant="outline" disabled={busy || !childTitle.trim()} onClick={() => {
            const next = childTitle.trim();
            if (!next || busy) return;
            setBusy(true); setErr("");
            void onCreateChild(next).then(() => setChildTitle("")).catch(x => setErr((x as Error).message)).finally(() => setBusy(false));
          }}>加上</Button>
        </div>}
        {!!task?.children?.length && <>
          <p className="text-xs text-muted-foreground">{task.children.filter(c => isDoneStatus(c.status, columns)).length}/{task.children.length} 子任务</p>
          <ul className="max-h-40 overflow-y-auto rounded-md border">
            {task.children.map(child => <li key={child.id} className="flex items-center gap-2 px-2 py-1.5">
              <input
                type="checkbox"
                className="size-3.5 shrink-0 accent-[var(--foreground)]"
                checked={isDoneStatus(child.status, columns)}
                disabled={!onToggleChild || busy || child.status === "cancelled"}
                onChange={e => {
                  if (!onToggleChild) return;
                  setBusy(true); setErr("");
                  void onToggleChild(child.id, e.target.checked).catch(x => setErr((x as Error).message)).finally(() => setBusy(false));
                }}
                aria-label={`完成 ${child.title}`}
              />
              <span className={cn("min-w-0 flex-1 truncate text-sm", (isDoneStatus(child.status, columns) || child.status === "cancelled") && "text-muted-foreground line-through")}>{child.title}</span>
              {onDeleteChild && <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" disabled={busy} aria-label={`删除 ${child.title}`} onClick={() => {
                setBusy(true); setErr("");
                void onDeleteChild(child.id).catch(x => setErr((x as Error).message)).finally(() => setBusy(false));
              }}><X className="size-3.5" /></Button>}
            </li>)}
          </ul>
        </>}
      </div>}
      {err && <p className="text-sm text-destructive">{err}</p>}
      <div className="flex justify-end gap-2">
        {task && canEdit && task.status !== "cancelled" && <Button type="button" variant="outline" disabled={busy} onClick={async () => {
          setBusy(true); setErr("");
          try { await onSubmit({ status: "cancelled" }); }
          catch (x) { setErr((x as Error).message); }
          finally { setBusy(false); }
        }}>不做了</Button>}
        {onDelete && <Button type="button" variant="destructive" onClick={() => void onDelete()}>删除</Button>}
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>关闭</Button>
        {canEdit && <Button disabled={busy || !title.trim()}>{busy ? "保存中…" : task ? "保存" : "创建"}</Button>}
      </div>
    </form>
  </DialogContent></Dialog>;
}
