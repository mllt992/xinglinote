import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Archive, ArrowRightLeft, ChevronRight, Clock, MoreHorizontal, Plus,
} from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";
import { saveLastWorkspace } from "./app-nav";
import { BoardView } from "./board-view";
import { GanttView, PulseView, TimeView } from "./gantt-time-pulse";
import {
  type Detail, type Member, type Task, type View, type Workspace,
  boardColumns, COLOR_DOT, doneCol, fmtClock, fmtSec, HEALTH_BAND_LABEL, healthTone, openCol, pickTask, VIEWS,
} from "./project-model";
import { MoveProjectDialog, ProjectDialog, TaskDialog } from "./project-dialogs";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useConfirm } from "./ui/confirm";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { useToast } from "./ui/toast";

export function ProjectPage() {
  const { wsId = "", projectId = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const ask = useConfirm();
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.find(v => v.id === params.get("view"))?.id ?? "board") as View;
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [editProject, setEditProject] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [spaces, setSpaces] = useState<Workspace[]>([]);
  const [movingProject, setMovingProject] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => { api<{ workspaces: Workspace[] }>("/api/v1/workspaces").then(result => setSpaces(result.workspaces)).catch(() => {}); }, []);
  const load = useCallback(async () => {
    try {
      const next = await api<Detail>(`/api/v1/projects/${projectId}`);
      setData(next);
      setError("");
      return next;
    } catch (e) { setError((e as Error).message); setData(null); return null; }
  }, [projectId]);
  const reloadEditing = useCallback(async (id: string) => {
    const next = await load();
    if (!next) return;
    const hit = pickTask(next, id);
    if (hit) setEditing(hit);
  }, [load]);
  useEffect(() => { void load(); }, [load]);
  const actualWsId = data?.project.workspaceId ?? wsId;
  useEffect(() => { if (actualWsId) saveLastWorkspace(actualWsId); }, [actualWsId]);
  useEffect(() => {
    if (!data || !projectId || data.project.workspaceId === wsId) return;
    const query = params.toString();
    nav(`/w/${data.project.workspaceId}/projects/${projectId}${query ? `?${query}` : ""}`, { replace: true });
  }, [data, wsId, projectId, params, nav]);
  useEffect(() => { api<{ members: Member[] }>(`/api/v1/workspaces/${actualWsId}/members`).then(r => setMembers(r.members)).catch(() => {}); }, [actualWsId]);
  useEffect(() => {
    if (!data?.running) return;
    const t = window.setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [data?.running?.id]);

  const setView = (v: View) => setParams(p => { p.set("view", v); return p; }, { replace: true });
  const liveRunning = data?.running ? Math.max(0, Math.floor((Date.now() - new Date(data.running.startedAt).getTime()) / 1000) + tick * 0) : 0;

  async function startTimer(taskId: string) {
    try {
      await api(`/api/v1/projects/${projectId}/time/start`, { method: "POST", body: JSON.stringify({ taskId }) });
      await load();
    } catch (e) { toast.error("开不了表", (e as Error).message); }
  }
  async function stopTimer() {
    try {
      const r = await api<{ entry: { seconds: number } }>(`/api/v1/projects/${projectId}/time/stop`, { method: "POST", body: "{}" });
      toast.success(`记下 ${fmtSec(r.entry.seconds)}`);
      await load();
    } catch (e) { toast.error("停不了表", (e as Error).message); }
  }

  if (error && !data) return <div className="grid h-full place-items-center p-8 text-center">
    <div>
      <p className="text-sm font-medium">打不开这个项目</p>
      <p className="mt-1 text-xs text-muted-foreground">{error}</p>
      <Button className="mt-4" variant="outline" onClick={() => nav(`/w/${wsId}/projects`)}>回项目列表</Button>
    </div>
  </div>;
  if (!data) return <div className="grid h-full place-items-center text-sm text-muted-foreground">加载项目…</div>;

  const p = data.project;
  const readonly = !data.canEdit || p.status === "archived";
  const currentSpace = spaces.find(space => space.id === p.workspaceId);
  const moveTargets = spaces.filter(space => space.id !== p.workspaceId && space.role !== "viewer" && !space.frozen);

  return <div className="flex h-full min-h-0 flex-col bg-background">
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-4">
      <Button variant="ghost" size="sm" onClick={() => nav(`/w/${p.workspaceId}/projects`)}><ChevronRight className="rotate-180" />项目</Button>
      <span className={cn("size-2.5 shrink-0 rounded-full", COLOR_DOT[p.color])} />
      <h1 className="min-w-0 truncate text-sm font-semibold">{p.title}</h1>
      {currentSpace && <Badge className="hidden sm:inline-flex">{currentSpace.name}</Badge>}
      <span className={cn("hidden text-xs font-medium tabular-nums sm:inline", healthTone(p.health.band))}>{p.health.score} {HEALTH_BAND_LABEL[p.health.band]}</span>
      <div className="ml-2 hidden rounded-lg bg-muted p-1 md:inline-flex">
        {VIEWS.map(v => <button key={v.id} onClick={() => setView(v.id)} className={cn("rounded-md px-2.5 py-1 text-sm", view === v.id ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}>{v.label}</button>)}
      </div>
      <div className="ml-auto flex items-center gap-1">
        {data.running && <button onClick={() => void stopTimer()} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-xs tabular-nums">
          <Clock className="size-3.5 animate-pulse" />{fmtClock(liveRunning)} · 停
        </button>}
        {!readonly && <Button size="sm" onClick={() => setCreating(true)}><Plus />任务</Button>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-8" aria-label="更多"><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {VIEWS.map(v => <DropdownMenuItem key={v.id} className="md:hidden" onSelect={() => setView(v.id)}><v.icon />{v.label}</DropdownMenuItem>)}
            {!readonly && <DropdownMenuItem onSelect={() => setEditProject(true)}>编辑项目</DropdownMenuItem>}
            {p.canArchive && !currentSpace?.frozen && moveTargets.length > 0 && <DropdownMenuItem onSelect={() => setMovingProject(true)}><ArrowRightLeft />移动到其他工作区…</DropdownMenuItem>}
            {p.canArchive && p.status !== "archived" && <DropdownMenuItem onSelect={async () => {
              if (!await ask({ title: "归档这个项目？", description: "列表里不再出现，详情仍能打开只读。", confirmText: "归档" })) return;
              await api(`/api/v1/projects/${p.id}/archive`, { method: "POST" });
              toast.success("已归档");
              await load();
            }}><Archive />归档</DropdownMenuItem>}
            {p.canArchive && p.status === "archived" && <DropdownMenuItem onSelect={async () => {
              await api(`/api/v1/projects/${p.id}/unarchive`, { method: "POST" });
              toast.success("已从归档拉回");
              await load();
            }}>取消归档</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
    {p.status === "archived" && <div className="border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">已归档，只读。创建者或管理员可以从右上角拉回。</div>}
    <div className="min-h-0 flex-1">
      {view === "board" && <BoardView projectId={projectId} columns={boardColumns(data)} tasks={data.tasks} cancelled={data.cancelled} canEdit={!readonly} onOpen={t => setEditing(pickTask(data, t.id) ?? t)} onChanged={() => load()} onQuickCreate={async title => {
        try {
          await api(`/api/v1/projects/${projectId}/tasks`, { method: "POST", body: JSON.stringify({ title }) });
          await load();
        } catch (e) { toast.error("建不了任务", (e as Error).message); }
      }} onMoved={async (id, status, beforeId) => {
        try {
          await api(`/api/v1/project-tasks/${id}/move`, { method: "POST", body: JSON.stringify({ status, beforeId: beforeId ?? null }) });
          await load();
        } catch (e) { toast.error("挪不动", (e as Error).message); }
      }} />}
      {view === "gantt" && <GanttView tasks={data.tasks} milestones={data.milestones} canEdit={!readonly} onOpen={t => setEditing(pickTask(data, t.id) ?? t)} onFillDate={t => setEditing(pickTask(data, t.id) ?? t)} onReschedule={async (id, startAt, dueAt) => {
        try {
          await api(`/api/v1/project-tasks/${id}/reschedule`, { method: "POST", body: JSON.stringify({ startAt, dueAt }) });
          await load();
        } catch (e) { toast.error("改不了期", (e as Error).message); }
      }} onAddMilestone={async (title, dueAt) => {
        try {
          await api(`/api/v1/projects/${projectId}/milestones`, { method: "POST", body: JSON.stringify({ title, dueAt }) });
          await load();
        } catch (e) { toast.error("加不了里程碑", (e as Error).message); }
      }} />}
      {view === "time" && <TimeView projectId={projectId} data={data} liveSeconds={liveRunning} canEdit={!readonly} onStart={startTimer} onStop={stopTimer} onLogged={() => void load()} />}
      {view === "pulse" && <PulseView project={p} columns={boardColumns(data)} pulse={data.pulse} onOpen={id => {
        const hit = pickTask(data, id);
        if (hit) setEditing(hit);
      }} />}
    </div>
    <TaskDialog
      open={creating || !!editing}
      task={editing}
      columns={boardColumns(data)}
      wsId={p.workspaceId}
      members={members}
      canEdit={!readonly}
      onOpenChange={v => { if (!v) { setCreating(false); setEditing(null); } }}
      onSubmit={async body => {
        if (editing) await api(`/api/v1/project-tasks/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) });
        else await api(`/api/v1/projects/${projectId}/tasks`, { method: "POST", body: JSON.stringify(body) });
        setCreating(false); setEditing(null);
        await load();
      }}
      onDelete={editing && !readonly ? async () => {
        if (!await ask({ title: "删除这件任务？", description: "子任务和工时一起删，不能撤销。", confirmText: "删除", destructive: true })) return;
        await api(`/api/v1/project-tasks/${editing.id}`, { method: "DELETE" });
        setEditing(null);
        await load();
      } : undefined}
      onOpenNote={id => nav(`/w/${p.workspaceId}/n/${id}`)}
      onCreateChild={editing && !editing.parentId && !readonly ? async title => {
        await api(`/api/v1/projects/${projectId}/tasks`, { method: "POST", body: JSON.stringify({ title, parentId: editing.id, status: editing.status === "cancelled" ? (openCol(boardColumns(data))?.key ?? "todo") : editing.status }) });
        await reloadEditing(editing.id);
      } : undefined}
      onToggleChild={editing && !readonly ? async (id, done) => {
        const cols = boardColumns(data);
        await api(`/api/v1/project-tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status: done ? (doneCol(cols)?.key ?? "done") : (openCol(cols)?.key ?? "todo") }) });
        await reloadEditing(editing.id);
      } : undefined}
      onDeleteChild={editing && !readonly ? async id => {
        await api(`/api/v1/project-tasks/${id}`, { method: "DELETE" });
        await reloadEditing(editing.id);
      } : undefined}
    />
    <ProjectDialog
      open={editProject}
      project={p}
      canChangeVisibility={p.canArchive}
      onOpenChange={setEditProject}
      onSubmit={async body => {
        await api(`/api/v1/projects/${p.id}`, { method: "PATCH", body: JSON.stringify(body) });
        toast.success("已保存");
        setEditProject(false);
        await load();
      }}
    />
    <MoveProjectDialog
      open={movingProject}
      project={p}
      currentWorkspaceName={currentSpace?.name ?? "当前工作区"}
      targets={moveTargets}
      onOpenChange={setMovingProject}
      onMoved={(workspaceId, moved) => {
        const targetName = spaces.find(space => space.id === workspaceId)?.name ?? "目标工作区";
        toast.success(`已移到「${targetName}」`, moved.clearedAssignees ? `已清空 ${moved.clearedAssignees} 个不属于目标工作区的指派` : undefined);
        setData(current => current ? { ...current, project: { ...current.project, workspaceId } } : current);
        nav(`/w/${workspaceId}/projects/${p.id}`, { replace: true });
        void load();
      }}
    />
  </div>;
}
