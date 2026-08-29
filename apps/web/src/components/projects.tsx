import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Activity, Archive, ArrowRightLeft, CalendarRange, ChevronRight, Clock, Kanban, MoreHorizontal, Plus, RotateCcw, Search, Timer, X,
} from "lucide-react";
import { api, type Me } from "../api";
import { cn } from "../lib/utils";
import { AppNav, loadLastWorkspace, saveLastWorkspace } from "./app-nav";
import { NotificationBell } from "./notifications";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { Textarea } from "./ui/textarea";
import { useConfirm } from "./ui/confirm";
import { useToast } from "./ui/toast";

type HealthBand = "steady" | "tight" | "risk";
type BoardColumn = "backlog" | "todo" | "doing" | "review" | "done";
const BOARD_COLUMNS: BoardColumn[] = ["backlog", "todo", "doing", "review", "done"];
const HEALTH_BAND_LABEL: Record<HealthBand, string> = { steady: "稳", tight: "紧", risk: "险" };
type Health = { score: number; band: HealthBand; overdue: number; stale: number; nearDue: boolean; overrun: boolean; completion: number };
type Project = {
  id: string; workspaceId: string; title: string; description: string;
  status: "planning" | "active" | "paused" | "done" | "archived";
  color: "ink" | "accent" | "good" | "warn" | "muted";
  startAt: string | null; dueAt: string | null; visibility: "workspace" | "private";
  createdBy: string; archivedAt: string | null;
  health: Health; taskCount: number; doneCount: number; estimateMin: number; actualSeconds: number;
  canEdit: boolean; canArchive: boolean;
};
type Task = {
  id: string; title: string; bodyMd: string; status: BoardColumn | "cancelled";
  priority: number; startAt: string | null; dueAt: string | null; estimateMin: number | null;
  assigneeUserId: string | null; parentId: string | null; sourceNoteId: string | null; sourceNoteTitle: string | null;
  completedAt: string | null; actualSeconds: number; children?: Task[];
};
type Milestone = { id: string; title: string; dueAt: string; done: boolean };
type Pulse = {
  byStatus: Record<string, number>; estimateMin: number; actualSeconds: number;
  days: Array<{ day: string; completed: number; minutes: number }>;
  overdue: Array<{ id: string; title: string; dueAt: string | null }>;
  stale: Array<{ id: string; title: string; updatedAt: string }>;
};
type Detail = {
  project: Project; tasks: Task[]; cancelled: Task[]; milestones: Milestone[];
  running: { id: string; taskId: string; startedAt: string } | null;
  todaySeconds: number; pulse: Pulse; me: string; canEdit: boolean;
};
type Member = { userId: string; displayName: string; handle: string };
type Workspace = { id: string; name: string; role: "owner" | "admin" | "editor" | "viewer"; frozen: boolean; canEdit?: boolean; projectCount?: number };
type View = "board" | "gantt" | "time" | "pulse";

const VIEWS: Array<{ id: View; label: string; icon: typeof Kanban }> = [
  { id: "board", label: "看板", icon: Kanban },
  { id: "gantt", label: "甘特", icon: CalendarRange },
  { id: "time", label: "计时", icon: Timer },
  { id: "pulse", label: "脉搏", icon: Activity },
];
const COL_LABEL: Record<BoardColumn, string> = { backlog: "积压", todo: "待办", doing: "进行", review: "复核", done: "完成" };
const STATUS_LABEL: Record<Project["status"], string> = { planning: "规划", active: "进行", paused: "暂停", done: "完成", archived: "归档" };
const COLOR_DOT: Record<Project["color"], string> = {
  ink: "bg-foreground", accent: "bg-primary", good: "bg-[var(--good)]", warn: "bg-[var(--warn,theme(colors.amber.500))]", muted: "bg-muted-foreground",
};
const PRI = ["无", "低", "中", "高"];

/** 日期一律按东八区民用日，避免 UTC 切片把 0 点写成前一天。 */
function isoDate(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}
function toIso(day: string | null | undefined) { return day ? `${day}T00:00:00.000+08:00` : null; }
function fmtMin(min: number) { return min >= 60 ? `${(min / 60).toFixed(min % 60 ? 1 : 0)} 小时` : `${min} 分钟`; }
function fmtSec(sec: number) {
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} 分钟`;
  return `${(m / 60).toFixed(m % 60 ? 1 : 0)} 小时`;
}
function fmtClock(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}
function flattenTasks(tasks: Task[]) {
  return tasks.flatMap(t => [t, ...(t.children ?? [])]);
}
function pickTask(detail: Detail, id: string) {
  return flattenTasks(detail.tasks).find(t => t.id === id) ?? detail.cancelled.find(t => t.id === id) ?? null;
}
function healthTone(band: HealthBand) {
  return band === "steady" ? "text-[var(--good)]" : band === "tight" ? "text-amber-600 dark:text-amber-400" : "text-destructive";
}

export function ProjectsPage() {
  const { wsId = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const allSpaces = params.get("scope") === "all";
  const [me, setMe] = useState<Me | null>(null);
  const [spaces, setSpaces] = useState<Workspace[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [rhythm, setRhythm] = useState({ completedThisWeek: 0, minutesThisWeek: 0 });
  const [canEdit, setCanEdit] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | Project["status"]>("all");

  useEffect(() => { if (wsId) saveLastWorkspace(wsId); }, [wsId]);
  useEffect(() => { api<Me>("/api/v1/me").then(setMe).catch(() => setMe(null)); }, []);
  useEffect(() => { api<{ workspaces: Workspace[] }>("/api/v1/workspaces").then(d => setSpaces(d.workspaces)).catch(() => {}); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const endpoint = allSpaces ? "/api/v1/projects" : `/api/v1/workspaces/${wsId}/projects`;
      const d = await api<{ projects: Project[]; canEdit: boolean; rhythm: { completedThisWeek: number; minutesThisWeek: number }; workspaces?: Workspace[] }>(
        `${endpoint}${showArchived ? "?archived=1" : ""}`,
      );
      setProjects(d.projects); setCanEdit(d.canEdit); setRhythm(d.rhythm); setError("");
      if (allSpaces && d.workspaces?.length) setSpaces(current => {
        const byId = new Map(current.map(space => [space.id, space]));
        return d.workspaces!.map(space => ({ ...byId.get(space.id), ...space }));
      });
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [wsId, showArchived, allSpaces]);
  useEffect(() => { void load(); }, [load]);

  const editableSpaces = spaces.filter(space => space.role !== "viewer" && !space.frozen);
  const canCreate = canEdit && editableSpaces.length > 0;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = projects.filter(project =>
    (status === "all" || project.status === status)
    && (!normalizedQuery || `${project.title}\n${project.description}`.toLocaleLowerCase().includes(normalizedQuery)),
  );
  const groups = spaces.map(space => ({ space, projects: filtered.filter(project => project.workspaceId === space.id) }))
    .filter(group => group.projects.length);
  const currentName = spaces.find(space => space.id === wsId)?.name ?? "项目";
  const changeScope = (value: string) => {
    if (value === "all") setParams(current => { current.set("scope", "all"); return current; }, { replace: true });
    else nav(`/w/${value}/projects`);
  };

  return <div className="flex h-full min-h-0 flex-col bg-muted/25">
    <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-background">
      <div className="mx-auto flex h-14 w-full max-w-[1180px] items-center gap-2 px-4 sm:px-6">
        <button className="-mx-1 flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-muted" onClick={() => nav(`/w/${wsId}`)}>
          <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground text-xs font-semibold">星</span>
          <span className="max-w-40 truncate text-sm font-semibold">{allSpaces ? "所有工作区" : currentName}</span>
        </button>
        <AppNav wsId={wsId} active="projects" />
        <div className="ml-auto flex items-center gap-1">
          {me && <NotificationBell />}
          <Button variant="ghost" size="sm" onClick={() => nav(`/w/${wsId}`)}>笔记</Button>
        </div>
      </div>
    </header>
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1180px] px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-[-.035em]">项目</h1>
            <p className="mt-1 text-sm text-muted-foreground">{allSpaces ? "跨工作区看清所有交付，不必来回切换。" : "交付面，不是第二个待办。日历管日期，这里管交不交得出去。"}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant={showArchived ? "secondary" : "ghost"} size="sm" onClick={() => setShowArchived(v => !v)}><Archive />{showArchived ? "看进行中" : "看归档"}</Button>
            {canCreate && <Button size="sm" onClick={() => setCreating(true)}><Plus />建项目</Button>}
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <select aria-label="项目工作区范围" className="h-9 min-w-44 rounded-lg border border-input bg-background px-3 text-sm" value={allSpaces ? "all" : wsId} onChange={event => changeScope(event.target.value)}>
            <option value="all">所有工作区</option>
            {spaces.map(space => <option key={space.id} value={space.id}>{space.name}{space.frozen ? "（已冻结）" : ""}</option>)}
          </select>
          <label className="relative min-w-48 flex-1 sm:max-w-72">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input className="pl-9" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索项目" />
          </label>
          <select aria-label="项目状态" className="h-9 rounded-lg border border-input bg-background px-3 text-sm" value={status} onChange={event => setStatus(event.target.value as typeof status)}>
            <option value="all">全部状态</option>
            {(["planning", "active", "paused", "done"] as const).map(value => <option key={value} value={value}>{STATUS_LABEL[value]}</option>)}
          </select>
        </div>
        {!showArchived && <p className="mt-3 text-sm text-muted-foreground">本周完成 {rhythm.completedThisWeek} 件 · 记下 {rhythm.minutesThisWeek} 分钟</p>}
        {error && <div className="mt-4 flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm"><span className="flex-1">{error}</span><Button size="sm" variant="outline" onClick={() => void load()}><RotateCcw />重试</Button></div>}
        {loading ? <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <div key={i} className="h-36 animate-pulse rounded-xl border bg-muted/50" />)}</div>
          : !filtered.length ? <div className="mt-16 text-center">
            <p className="text-sm font-medium">{projects.length ? "没有符合筛选条件的项目" : showArchived ? "还没有归档的项目" : "项目是交付面，不是第二个待办"}</p>
            {projects.length > 0 && <Button className="mt-4" variant="ghost" onClick={() => { setQuery(""); setStatus("all"); }}>清除筛选</Button>}
            {!projects.length && !showArchived && canCreate && <Button className="mt-4" onClick={() => setCreating(true)}><Plus />建第一个项目</Button>}
          </div>
          : allSpaces ? <div className="mt-6 space-y-7">{groups.map(group => <section key={group.space.id}>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-sm font-semibold">{group.space.name}</h2>
              <span className="text-xs text-muted-foreground">{group.projects.length} 个</span>
              <Button className="ml-auto" variant="ghost" size="sm" onClick={() => nav(`/w/${group.space.id}/projects`)}>只看这里<ChevronRight /></Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{group.projects.map(project => <ProjectCard key={project.id} project={project} workspaceName={group.space.name} showWorkspace onOpen={() => nav(`/w/${project.workspaceId}/projects/${project.id}`)} />)}</div>
          </section>)}</div>
            : <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{filtered.map(project => <ProjectCard key={project.id} project={project} workspaceName={currentName} onOpen={() => nav(`/w/${project.workspaceId}/projects/${project.id}`)} />)}</div>}
      </div>
    </main>
    <ProjectDialog open={creating} onOpenChange={setCreating} onSubmit={async body => {
      const { workspaceId, ...projectBody } = body;
      const targetId = String(workspaceId || wsId);
      const created = await api<Project>(`/api/v1/workspaces/${targetId}/projects`, { method: "POST", body: JSON.stringify(projectBody) });
      toast.success(`已建到「${spaces.find(space => space.id === targetId)?.name ?? "工作区"}」`);
      nav(`/w/${created.workspaceId}/projects/${created.id}`);
    }} workspaces={editableSpaces} initialWorkspaceId={editableSpaces.some(space => space.id === wsId) ? wsId : editableSpaces[0]?.id} />
  </div>;
}

function ProjectCard({ project, workspaceName, showWorkspace = false, onOpen }: { project: Project; workspaceName: string; showWorkspace?: boolean; onOpen: () => void }) {
  return <button onClick={onOpen} className="rounded-xl border border-border bg-background p-4 text-left transition hover:border-foreground/20 hover:shadow-sm">
    <div className="flex items-start gap-2">
      <span className={cn("mt-1 size-2.5 shrink-0 rounded-full", COLOR_DOT[project.color])} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{project.title}</p>
        {showWorkspace && <p className="mt-0.5 truncate text-[11px] font-medium text-muted-foreground">{workspaceName}</p>}
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{project.description || "还没写说明"}</p>
      </div>
      <Badge>{STATUS_LABEL[project.status]}</Badge>
    </div>
    <div className="mt-4 flex items-center justify-between text-xs">
      <span className={cn("font-medium tabular-nums", healthTone(project.health.band))}>{project.health.score} {HEALTH_BAND_LABEL[project.health.band]}</span>
      <span className="text-muted-foreground">{project.doneCount}/{project.taskCount} · {fmtSec(project.actualSeconds)}</span>
    </div>
    {project.dueAt && <p className="mt-2 text-[11px] text-muted-foreground">截止 {isoDate(project.dueAt)}</p>}
  </button>;
}

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
      {view === "board" && <BoardView tasks={data.tasks} cancelled={data.cancelled} canEdit={!readonly} onOpen={t => setEditing(pickTask(data, t.id) ?? t)} onQuickCreate={async title => {
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
      {view === "pulse" && <PulseView project={p} pulse={data.pulse} onOpen={id => {
        const hit = pickTask(data, id);
        if (hit) setEditing(hit);
      }} />}
    </div>
    <TaskDialog
      open={creating || !!editing}
      task={editing}
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
        await api(`/api/v1/projects/${projectId}/tasks`, { method: "POST", body: JSON.stringify({ title, parentId: editing.id, status: editing.status === "cancelled" ? "todo" : editing.status }) });
        await reloadEditing(editing.id);
      } : undefined}
      onToggleChild={editing && !readonly ? async (id, done) => {
        await api(`/api/v1/project-tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status: done ? "done" : "todo" }) });
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

function BoardView({ tasks, cancelled = [], canEdit, onOpen, onQuickCreate, onMoved }: {
  tasks: Task[]; cancelled?: Task[]; canEdit: boolean; onOpen: (t: Task) => void; onQuickCreate: (title: string) => Promise<void>;
  onMoved: (id: string, status: BoardColumn, beforeId?: string) => Promise<void>;
}) {
  const [over, setOver] = useState<{ col: BoardColumn; beforeId?: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
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
  return <div className="flex h-full min-h-0 gap-3 overflow-x-auto p-4">
    {BOARD_COLUMNS.map(col => {
      const cards = tasks.filter(t => t.status === col);
      return <section key={col} className="flex w-72 shrink-0 flex-col rounded-xl bg-muted/40"
        onDragOver={e => { if (!canEdit) return; e.preventDefault(); setOver({ col }); }}
        onDrop={e => { if (!canEdit) return; e.preventDefault(); const id = e.dataTransfer.getData("text/task-id"); if (id) void onMoved(id, col, over?.col === col ? over.beforeId : undefined); setOver(null); }}
        onDragLeave={() => setOver(null)}>
        <header className="flex items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground">
          <span>{COL_LABEL[col]}</span><span className="tabular-nums">{cards.length}</span>
        </header>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-2 px-2 pb-3">
            {cards.map(t => <article key={t.id} draggable={canEdit}
              onDragStart={e => { e.dataTransfer.setData("text/task-id", t.id); e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={e => { if (!canEdit) return; e.preventDefault(); e.stopPropagation(); setOver({ col, beforeId: t.id }); }}
              onClick={() => onOpen(t)}
              className={cn("cursor-pointer rounded-lg border border-border bg-background p-3 text-sm shadow-sm", over?.beforeId === t.id && "ring-1 ring-foreground/25")}>
              <p className="font-medium">{t.title}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                {t.priority > 0 && <Badge className="px-1.5">{PRI[t.priority]}</Badge>}
                {t.dueAt && <span>截止 {isoDate(t.dueAt)}</span>}
                {t.estimateMin ? <span>估 {fmtMin(t.estimateMin)}</span> : null}
                {t.sourceNoteTitle && <span className="truncate">《{t.sourceNoteTitle}》</span>}
              </div>
              {!!t.children?.length && <p className="mt-2 text-[11px] text-muted-foreground">{t.children.filter(c => c.status === "done").length}/{t.children.length} 子任务</p>}
            </article>)}
          </div>
        </ScrollArea>
      </section>;
    })}
    {!!cancelled.length && <section className="flex w-56 shrink-0 flex-col rounded-xl bg-muted/20">
      <header className="px-3 py-2 text-xs font-medium text-muted-foreground">不做了 <span className="tabular-nums">{cancelled.length}</span></header>
      <div className="space-y-1 px-2 pb-3">
        {cancelled.map(t => <button key={t.id} onClick={() => onOpen(t)} className="block w-full truncate rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground line-through hover:bg-muted">{t.title}</button>)}
      </div>
    </section>}
  </div>;
}

function addDays(d: Date, n: number) { return new Date(d.getTime() + n * 86400_000); }
function dayKey(d: Date) { return d.toISOString().slice(0, 10); }
function todayKey() { return isoDate(new Date().toISOString()); }

function GanttView({ tasks, milestones, canEdit, onOpen, onFillDate, onReschedule, onAddMilestone }: {
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

function TimeView({ projectId, data, liveSeconds = 0, canEdit, onStart, onStop, onLogged }: {
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

function PulseView({ project, pulse, onOpen }: { project: Project; pulse: Pulse; onOpen?: (id: string) => void }) {
  const max = Math.max(1, ...pulse.days.map(d => Math.max(d.completed, d.minutes)));
  return <ScrollArea className="h-full"><div className="mx-auto grid max-w-3xl gap-4 p-5">
    <section className="rounded-xl border p-4">
      <p className="text-sm font-medium">状态环</p>
      <div className="mt-3 flex flex-wrap gap-3 text-sm">
        {BOARD_COLUMNS.map(c => <span key={c}>{COL_LABEL[c]} <strong className="tabular-nums">{pulse.byStatus[c] ?? 0}</strong></span>)}
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

function ProjectDialog({ open, onOpenChange, onSubmit, project, canChangeVisibility = true, workspaces = [], initialWorkspaceId }: {
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

function MoveProjectDialog({ open, project, currentWorkspaceName, targets, onOpenChange, onMoved }: {
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

function TaskDialog({ open, task, wsId, members, canEdit, onOpenChange, onSubmit, onDelete, onOpenNote, onCreateChild, onToggleChild, onDeleteChild }: {
  open: boolean; task: Task | null; wsId: string; members: Member[]; canEdit: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
  onDelete?: () => Promise<void>;
  onOpenNote: (id: string) => void;
  onCreateChild?: (title: string) => Promise<void>;
  onToggleChild?: (id: string, done: boolean) => Promise<void>;
  onDeleteChild?: (id: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [bodyMd, setBodyMd] = useState("");
  const [status, setStatus] = useState<BoardColumn>("todo");
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!open) return;
    setTitle(task?.title ?? ""); setBodyMd(task?.bodyMd ?? "");
    setStatus((task?.status === "cancelled" ? "todo" : task?.status) ?? "todo");
    setPriority(task?.priority ?? 0);
    setEstimateMin(task?.estimateMin ? String(task.estimateMin) : "");
    setStartAt(isoDate(task?.startAt ?? null)); setDueAt(isoDate(task?.dueAt ?? null));
    setAssigneeUserId(task?.assigneeUserId ?? ""); setChildTitle(""); setErr("");
    setSourceNoteId(task?.sourceNoteId ?? null); setSourceNoteTitle(task?.sourceNoteTitle ?? null);
    setNoteQuery(""); setNoteHits([]);
  }, [open, task?.id]);
  useEffect(() => {
    if (!open || !canEdit) return;
    const q = noteQuery.trim();
    if (q.length < 1) { setNoteHits([]); return; }
    const t = window.setTimeout(() => {
      const params = new URLSearchParams({ q, workspaceId: wsId, titleOnly: "1", limit: "8" });
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
        <select className="h-9 rounded-lg border border-input bg-background px-2 text-sm" value={status} disabled={!canEdit} onChange={e => setStatus(e.target.value as BoardColumn)}>
          {BOARD_COLUMNS.map(c => <option key={c} value={c}>{COL_LABEL[c]}</option>)}
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
          <p className="text-xs text-muted-foreground">{task.children.filter(c => c.status === "done").length}/{task.children.length} 子任务</p>
          <ul className="max-h-40 overflow-y-auto rounded-md border">
            {task.children.map(child => <li key={child.id} className="flex items-center gap-2 px-2 py-1.5">
              <input
                type="checkbox"
                className="size-3.5 shrink-0 accent-[var(--foreground)]"
                checked={child.status === "done"}
                disabled={!onToggleChild || busy || child.status === "cancelled"}
                onChange={e => {
                  if (!onToggleChild) return;
                  setBusy(true); setErr("");
                  void onToggleChild(child.id, e.target.checked).catch(x => setErr((x as Error).message)).finally(() => setBusy(false));
                }}
                aria-label={`完成 ${child.title}`}
              />
              <span className={cn("min-w-0 flex-1 truncate text-sm", (child.status === "done" || child.status === "cancelled") && "text-muted-foreground line-through")}>{child.title}</span>
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

export function projectHome(wsId?: string) {
  return `/w/${wsId || loadLastWorkspace() || ""}/projects`;
}
