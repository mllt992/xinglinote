import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Archive, ChevronRight, Plus, RotateCcw, Search } from "lucide-react";
import { api, type Me } from "../api";
import { cn } from "../lib/utils";
import { AppNav, loadLastWorkspace, saveLastWorkspace } from "./app-nav";
import { NotificationBell } from "./notifications";
import {
  type Project, type Workspace,
  COLOR_DOT, fmtSec, HEALTH_BAND_LABEL, healthTone, isoDate, STATUS_LABEL,
} from "./project-model";
import { ProjectDialog } from "./project-dialogs";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useToast } from "./ui/toast";

export { ProjectPage } from "./project-page";

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
          : error ? null
          : !filtered.length ? <div className="mt-16 text-center">
            {(projects.length > 0 || showArchived) && <p className="text-sm font-medium">{projects.length ? "没有符合筛选条件的项目" : "还没有归档的项目"}</p>}
            {projects.length > 0 && <Button className="mt-4" variant="ghost" onClick={() => { setQuery(""); setStatus("all"); }}>清除筛选</Button>}
            {!projects.length && !showArchived && canCreate && <Button onClick={() => setCreating(true)}><Plus />建第一个项目</Button>}
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

export function projectHome(wsId?: string) {
  return `/w/${wsId || loadLastWorkspace() || ""}/projects`;
}
