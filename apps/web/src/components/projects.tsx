import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Activity, Archive, ArrowRightLeft, CalendarRange, ChevronLeft, ChevronRight, Clock, Kanban, MoreHorizontal, Plus, RotateCcw, Search, Timer, X,
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
import { useConfirm, usePrompt } from "./ui/confirm";
import { useToast } from "./ui/toast";

type HealthBand = "steady" | "tight" | "risk";
type BoardCol = {
  id: string; projectId: string; title: string; key: string; sortKey: number;
  isDefault: boolean; isDone: boolean; isWip: boolean;
};
const FALLBACK_COLUMNS: BoardCol[] = [
  { id: "backlog", projectId: "", title: "积压", key: "backlog", sortKey: 0, isDefault: true, isDone: false, isWip: false },
  { id: "todo", projectId: "", title: "待办", key: "todo", sortKey: 1, isDefault: false, isDone: false, isWip: false },
  { id: "doing", projectId: "", title: "进行", key: "doing", sortKey: 2, isDefault: false, isDone: false, isWip: true },
  { id: "review", projectId: "", title: "复核", key: "review", sortKey: 3, isDefault: false, isDone: false, isWip: false },
  { id: "done", projectId: "", title: "完成", key: "done", sortKey: 4, isDefault: false, isDone: false, isWip: false },
];
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
  id: string; title: string; bodyMd: string; status: string;
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
  project: Project; tasks: Task[]; cancelled: Task[]; columns?: BoardCol[]; milestones: Milestone[];
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
function boardColumns(data: Pick<Detail, "columns"> | BoardCol[] | undefined): BoardCol[] {
  const rows = Array.isArray(data) ? data : data?.columns;
  return rows?.length ? [...rows].sort((a, b) => a.sortKey - b.sortKey) : FALLBACK_COLUMNS;
}
function isDoneStatus(status: string, columns: BoardCol[]) {
  if (status === "cancelled") return false;
  const col = columns.find(c => c.key === status);
  if (col) return col.isDone;
  return status === "done";
}
function defaultCol(columns: BoardCol[]) {
  return columns.find(c => c.isDefault) ?? columns[0];
}
function doneCol(columns: BoardCol[]) {
  return columns.find(c => c.isDone);
}
function openCol(columns: BoardCol[]) {
  return columns.find(c => c.key === "todo") ?? columns.find(c => !c.isDone && !c.isDefault) ?? defaultCol(columns);
}
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
