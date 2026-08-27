import type { WsRole } from "./acl.ts";

export const PROJECT_STATUSES = ["planning", "active", "paused", "done", "archived"] as const;
export const PROJECT_COLORS = ["ink", "accent", "good", "warn", "muted"] as const;
export const PROJECT_VISIBILITIES = ["workspace", "private"] as const;
export const TASK_STATUSES = ["backlog", "todo", "doing", "review", "done", "cancelled"] as const;
export const BOARD_COLUMNS = ["backlog", "todo", "doing", "review", "done"] as const;
export const PROJECT_PRIORITIES = [0, 1, 2, 3] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type ProjectColor = (typeof PROJECT_COLORS)[number];
export type ProjectVisibility = (typeof PROJECT_VISIBILITIES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
export type HealthBand = "steady" | "tight" | "risk";

export const MAX_ACTIVE_PROJECTS = 200;
export const MAX_TASKS_PER_PROJECT = 2000;
export const MAX_SUBTASKS = 20;
export const STALE_DOING_MS = 7 * 86400_000;
export const NEAR_DUE_MS = 3 * 86400_000;
export const OVERRUN_RATIO = 1.3;

export const HEALTH_BAND_LABEL: Record<HealthBand, string> = {
  steady: "稳",
  tight: "紧",
  risk: "险",
};

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && (PROJECT_STATUSES as readonly string[]).includes(value);
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isBoardColumn(value: unknown): value is BoardColumn {
  return typeof value === "string" && (BOARD_COLUMNS as readonly string[]).includes(value);
}

export function healthBand(score: number): HealthBand {
  if (score >= 75) return "steady";
  if (score >= 45) return "tight";
  return "risk";
}

export type ProjectAcl = {
  userId: string;
  wsRole: WsRole | null;
  frozen?: boolean;
  visibility: ProjectVisibility;
  createdBy: string;
  status?: ProjectStatus;
};

export function canReadProject(input: ProjectAcl): boolean {
  if (!input.wsRole) return false;
  if (input.visibility === "private") return input.createdBy === input.userId;
  return true;
}

export function canWriteProject(input: ProjectAcl): boolean {
  if (!canReadProject(input)) return false;
  if (input.frozen) return false;
  if (input.wsRole === "viewer") return false;
  if (input.status === "archived") return false;
  return true;
}

/** 归档 / 改可见性：创建者或 Admin / Owner。 */
export function canArchiveProject(input: Pick<ProjectAcl, "userId" | "wsRole" | "createdBy">): boolean {
  if (!input.wsRole) return false;
  return input.createdBy === input.userId || input.wsRole === "admin" || input.wsRole === "owner";
}

export type HealthTask = {
  status: TaskStatus;
  dueAt: Date | string | null;
  updatedAt: Date | string;
  estimateMin: number | null;
  actualSeconds: number;
};

export type HealthProject = {
  dueAt: Date | string | null;
};

export type HealthResult = {
  score: number;
  band: HealthBand;
  overdue: number;
  stale: number;
  nearDue: boolean;
  overrun: boolean;
  completion: number;
};

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 从 100 起扣，夹在 0–100。扣分规则见设计 23 §3。
 * 逾期、停滞按条；临期进度不够、估时打穿按项目各扣一次。
 */
export function scoreProjectHealth(project: HealthProject, tasks: readonly HealthTask[], now = new Date()): HealthResult {
  const counted = tasks.filter(t => t.status !== "cancelled");
  const done = counted.filter(t => t.status === "done").length;
  const completion = counted.length ? done / counted.length : 1;

  let overdue = 0;
  let stale = 0;
  for (const task of tasks) {
    if (task.status === "done" || task.status === "cancelled") continue;
    const due = asDate(task.dueAt);
    if (due && due.getTime() < now.getTime()) overdue += 1;
    if (task.status === "doing") {
      const updated = asDate(task.updatedAt);
      if (updated && now.getTime() - updated.getTime() > STALE_DOING_MS) stale += 1;
    }
  }

  const projectDue = asDate(project.dueAt);
  const remaining = projectDue ? projectDue.getTime() - now.getTime() : null;
  const nearDue = remaining !== null && remaining >= 0 && remaining <= NEAR_DUE_MS && completion < 0.5;

  const estimateSec = tasks.reduce((sum, t) => sum + (t.estimateMin && t.estimateMin > 0 ? t.estimateMin * 60 : 0), 0);
  const actualSec = tasks.reduce((sum, t) => sum + Math.max(0, t.actualSeconds), 0);
  const overrun = estimateSec > 0 && actualSec > estimateSec * OVERRUN_RATIO;

  let score = 100 - overdue * 12 - stale * 8;
  if (nearDue) score -= 20;
  if (overrun) score -= 10;
  score = Math.min(100, Math.max(0, score));

  return { score, band: healthBand(score), overdue, stale, nearDue, overrun, completion };
}
