import { Activity, CalendarRange, Kanban, Timer } from "lucide-react";

export type HealthBand = "steady" | "tight" | "risk";
export type BoardCol = {
  id: string; projectId: string; title: string; key: string; sortKey: number;
  isDefault: boolean; isDone: boolean; isWip: boolean;
};
export const FALLBACK_COLUMNS: BoardCol[] = [
  { id: "backlog", projectId: "", title: "积压", key: "backlog", sortKey: 0, isDefault: true, isDone: false, isWip: false },
  { id: "todo", projectId: "", title: "待办", key: "todo", sortKey: 1, isDefault: false, isDone: false, isWip: false },
  { id: "doing", projectId: "", title: "进行", key: "doing", sortKey: 2, isDefault: false, isDone: false, isWip: true },
  { id: "review", projectId: "", title: "复核", key: "review", sortKey: 3, isDefault: false, isDone: false, isWip: false },
  { id: "done", projectId: "", title: "完成", key: "done", sortKey: 4, isDefault: false, isDone: true, isWip: false },
];
export const HEALTH_BAND_LABEL: Record<HealthBand, string> = { steady: "稳", tight: "紧", risk: "险" };
export type Health = { score: number; band: HealthBand; overdue: number; stale: number; nearDue: boolean; overrun: boolean; completion: number };
export type Project = {
  id: string; workspaceId: string; title: string; description: string;
  status: "planning" | "active" | "paused" | "done" | "archived";
  color: "ink" | "accent" | "good" | "warn" | "muted";
  startAt: string | null; dueAt: string | null; visibility: "workspace" | "private";
  createdBy: string; archivedAt: string | null;
  health: Health; taskCount: number; doneCount: number; estimateMin: number; actualSeconds: number;
  canEdit: boolean; canArchive: boolean;
};
export type ProjectTag = { id: string; projectId: string; name: string; color: Project["color"] };
export type Task = {
  id: string; title: string; bodyMd: string; status: string;
  priority: number; startAt: string | null; dueAt: string | null; estimateMin: number | null;
  assigneeUserId: string | null; parentId: string | null; sourceNoteId: string | null; sourceNoteTitle: string | null;
  completedAt: string | null; actualSeconds: number; children?: Task[];
  tags?: ProjectTag[]; milestoneId?: string | null;
};
export type Milestone = { id: string; title: string; dueAt: string; done: boolean };
export type TagBundle = {
  tags: ProjectTag[];
  assignments: Array<{ taskId: string; tagId: string }>;
  taskMilestones: Array<{ taskId: string; milestoneId: string }>;
};
export type Pulse = {
  byStatus: Record<string, number>; estimateMin: number; actualSeconds: number;
  days: Array<{ day: string; completed: number; minutes: number }>;
  overdue: Array<{ id: string; title: string; dueAt: string | null }>;
  stale: Array<{ id: string; title: string; updatedAt: string }>;
};
export type Detail = {
  project: Project; tasks: Task[]; cancelled: Task[]; columns?: BoardCol[]; milestones: Milestone[];
  running: { id: string; taskId: string; startedAt: string } | null;
  todaySeconds: number; pulse: Pulse; me: string; canEdit: boolean;
  tags?: ProjectTag[];
};
export type Member = { userId: string; displayName: string; handle: string };
export type Workspace = { id: string; name: string; role: "owner" | "admin" | "editor" | "viewer"; frozen: boolean; canEdit?: boolean; projectCount?: number };
export type View = "board" | "gantt" | "time" | "pulse";

export const VIEWS: Array<{ id: View; label: string; icon: typeof Kanban }> = [
  { id: "board", label: "看板", icon: Kanban },
  { id: "gantt", label: "甘特", icon: CalendarRange },
  { id: "time", label: "计时", icon: Timer },
  { id: "pulse", label: "脉搏", icon: Activity },
];
export function boardColumns(data: Pick<Detail, "columns"> | BoardCol[] | undefined): BoardCol[] {
  const rows = Array.isArray(data) ? data : data?.columns;
  return rows?.length ? [...rows].sort((a, b) => a.sortKey - b.sortKey) : FALLBACK_COLUMNS;
}
export function isDoneStatus(status: string, columns: BoardCol[]) {
  if (status === "cancelled") return false;
  const col = columns.find(c => c.key === status);
  if (col) return col.isDone;
  return status === "done";
}
export function defaultCol(columns: BoardCol[]) {
  return columns.find(c => c.isDefault) ?? columns[0];
}
export function doneCol(columns: BoardCol[]) {
  return columns.find(c => c.isDone);
}
export function openCol(columns: BoardCol[]) {
  return columns.find(c => c.key === "todo") ?? columns.find(c => !c.isDone && !c.isDefault) ?? defaultCol(columns);
}
export const STATUS_LABEL: Record<Project["status"], string> = { planning: "规划", active: "进行", paused: "暂停", done: "完成", archived: "归档" };
export const COLOR_DOT: Record<Project["color"], string> = {
  ink: "bg-foreground", accent: "bg-primary", good: "bg-[var(--good)]", warn: "bg-[var(--warn,theme(colors.amber.500))]", muted: "bg-muted-foreground",
};
export const PRI = ["无", "低", "中", "高"];

/** 日期一律按东八区民用日，避免 UTC 切片把 0 点写成前一天。 */
export function isoDate(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}
export function toIso(day: string | null | undefined) { return day ? `${day}T00:00:00.000+08:00` : null; }
export function fmtMin(min: number) { return min >= 60 ? `${(min / 60).toFixed(min % 60 ? 1 : 0)} 小时` : `${min} 分钟`; }
export function fmtSec(sec: number) {
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} 分钟`;
  return `${(m / 60).toFixed(m % 60 ? 1 : 0)} 小时`;
}
export function fmtClock(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}
export function flattenTasks(tasks: Task[]) {
  return tasks.flatMap(t => [t, ...(t.children ?? [])]);
}
export function pickTask(detail: Detail, id: string) {
  return flattenTasks(detail.tasks).find(t => t.id === id) ?? detail.cancelled.find(t => t.id === id) ?? null;
}
export function healthTone(band: HealthBand) {
  return band === "steady" ? "text-[var(--good)]" : band === "tight" ? "text-amber-600 dark:text-amber-400" : "text-destructive";
}

export function applyTagBundle(detail: Detail, bundle: TagBundle): Detail {
  const tagsById = new Map(bundle.tags.map(t => [t.id, t]));
  const tagsByTask = new Map<string, ProjectTag[]>();
  for (const a of bundle.assignments) {
    const tag = tagsById.get(a.tagId);
    if (!tag) continue;
    tagsByTask.set(a.taskId, [...(tagsByTask.get(a.taskId) ?? []), tag]);
  }
  const mileByTask = new Map(bundle.taskMilestones.map(x => [x.taskId, x.milestoneId]));
  const paint = (t: Task): Task => ({
    ...t,
    tags: tagsByTask.get(t.id) ?? [],
    milestoneId: mileByTask.get(t.id) ?? null,
    children: t.children?.map(paint),
  });
  return {
    ...detail,
    tags: bundle.tags,
    tasks: detail.tasks.map(paint),
    cancelled: detail.cancelled.map(paint),
  };
}
