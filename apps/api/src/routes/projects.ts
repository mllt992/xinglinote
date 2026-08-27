import { Hono } from "hono";
import { and, asc, count, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import {
  BOARD_COLUMNS,
  MAX_ACTIVE_PROJECTS,
  MAX_SUBTASKS,
  MAX_TASKS_PER_PROJECT,
  PROJECT_COLORS,
  PROJECT_STATUSES,
  PROJECT_VISIBILITIES,
  TASK_STATUSES,
  canArchiveProject,
  canReadProject,
  canWriteProject,
  scoreProjectHealth,
  type TaskStatus,
} from "@kb/core";
import { fail, nextSortKey } from "@kb/shared";
import { db } from "../db/client.ts";
import { auditLogs, notes, projectMilestones, projectTasks, projectTimeEntries, projects, users, workspaces } from "../db/schema.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";
import { memberRole } from "../lib/workspace.ts";
import { noteAccess } from "../lib/note-access.ts";

export const projectRoutes = new Hono();

const iso = z.string().datetime({ offset: true }).nullable().optional();
const projectCreate = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  color: z.enum(PROJECT_COLORS).optional(),
  startAt: iso,
  dueAt: iso,
  visibility: z.enum(PROJECT_VISIBILITIES).optional(),
});
const projectPatch = projectCreate.partial().extend({
  status: z.enum(PROJECT_STATUSES).optional(),
});
const taskCreate = z.object({
  title: z.string().trim().min(1).max(200),
  bodyMd: z.string().max(20_000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.number().int().min(0).max(3).optional(),
  startAt: iso,
  dueAt: iso,
  estimateMin: z.number().int().min(1).max(100_000).nullable().optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  sourceNoteId: z.string().uuid().nullable().optional(),
});
const taskPatch = taskCreate.partial();
const taskMove = z.object({
  status: z.enum(BOARD_COLUMNS),
  beforeId: z.string().uuid().nullable().optional(),
  afterId: z.string().uuid().nullable().optional(),
});
const taskReschedule = z.object({
  startAt: z.string().datetime({ offset: true }).nullable(),
  dueAt: z.string().datetime({ offset: true }).nullable(),
});
const timeStart = z.object({ taskId: z.string().uuid() });
const timeStop = z.object({ entryId: z.string().uuid().optional() });
const timeManual = z.object({
  taskId: z.string().uuid(),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }),
  note: z.string().max(500).optional(),
});
const milestoneCreate = z.object({
  title: z.string().trim().min(1).max(200),
  dueAt: z.string().datetime({ offset: true }),
  done: z.boolean().optional(),
});

async function requireUser(c: Parameters<typeof currentUser>[0]) {
  const user = await currentUser(c);
  if (!user) throw fail("UNAUTHENTICATED", "未登录");
  return user;
}

async function workspaceContext(c: Parameters<typeof currentUser>[0], workspaceId: string) {
  const user = await requireUser(c);
  const role = await memberRole(workspaceId, user.id);
  if (!role) throw fail("NOT_FOUND", "工作区不存在");
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) throw fail("NOT_FOUND", "工作区不存在");
  return { user, role, ws };
}

async function audit(workspaceId: string, userId: string, action: string, targetType: "project" | "project_task", targetId: string | null, details?: Record<string, unknown>) {
  await db.insert(auditLogs).values({
    userId, workspaceId, actorType: "user", actorId: userId,
    action, targetType, targetId, result: "ok", details: details ?? null,
  });
}

function parseTime(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw fail("VALIDATION", "时间不合法");
  return d;
}

function rangeOk(start: Date | null | undefined, due: Date | null | undefined) {
  if (start && due && due.getTime() < start.getTime()) throw fail("VALIDATION", "截止不能早于开始");
}

async function loadProject(c: Parameters<typeof currentUser>[0], id: string, mode: "read" | "write" | "archive" = "read") {
  const [row] = await db.select().from(projects).where(eq(projects.id, id));
  if (!row) throw fail("NOT_FOUND", "项目不存在");
  const { user, role, ws } = await workspaceContext(c, row.workspaceId);
  const acl = { userId: user.id, wsRole: role, frozen: ws.frozen, visibility: row.visibility as "workspace" | "private", createdBy: row.createdBy, status: row.status as "planning" | "active" | "paused" | "done" | "archived" };
  if (!canReadProject(acl)) throw fail("NOT_FOUND", "项目不存在");
  if (mode === "write" && !canWriteProject(acl)) {
    if (role === "viewer" || ws.frozen) throw fail("FORBIDDEN", ws.frozen ? "工作区已冻结，暂时只读" : "只读成员不能改项目");
    throw fail("FORBIDDEN", "已归档的项目只读");
  }
  if (mode === "archive" && !canArchiveProject(acl)) throw fail("FORBIDDEN", "只有创建者或管理员能改可见性 / 归档");
  return { user, role, ws, project: row, acl, canEdit: canWriteProject({ ...acl, status: row.status === "archived" ? "active" : acl.status }), canArchive: canArchiveProject(acl) };
}

async function loadTask(c: Parameters<typeof currentUser>[0], id: string, mode: "read" | "write" = "read") {
  const [task] = await db.select().from(projectTasks).where(eq(projectTasks.id, id));
  if (!task) throw fail("NOT_FOUND", "任务不存在");
  const ctx = await loadProject(c, task.projectId, mode);
  return { ...ctx, task };
}

type TaskRow = typeof projectTasks.$inferSelect;
type TimeRow = typeof projectTimeEntries.$inferSelect;

function secondsOf(entries: TimeRow[], taskId?: string, onlyClosed = false) {
  return entries
    .filter(e => (!taskId || e.taskId === taskId) && (!onlyClosed || e.endedAt))
    .reduce((sum, e) => sum + (e.endedAt ? e.seconds : 0), 0);
}

function healthOf(project: typeof projects.$inferSelect, tasks: TaskRow[], entries: TimeRow[]) {
  return scoreProjectHealth(
    { dueAt: project.dueAt },
    tasks.map(t => ({
      status: t.status as TaskStatus,
      dueAt: t.dueAt,
      updatedAt: t.updatedAt,
      estimateMin: t.estimateMin,
      actualSeconds: secondsOf(entries, t.id, true),
    })),
  );
}

function projectDto(
  row: typeof projects.$inferSelect,
  extras: {
    health: ReturnType<typeof scoreProjectHealth>;
    taskCount: number;
    doneCount: number;
    estimateMin: number;
    actualSeconds: number;
    canEdit: boolean;
    canArchive: boolean;
  },
) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    description: row.description,
    status: row.status,
    color: row.color,
    startAt: row.startAt,
    dueAt: row.dueAt,
    visibility: row.visibility,
    sortKey: row.sortKey,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    ...extras,
  };
}

function taskDto(row: TaskRow, extras: { actualSeconds: number; sourceNoteTitle?: string | null; children?: unknown[] } = { actualSeconds: 0 }) {
  return {
    id: row.id,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    title: row.title,
    bodyMd: row.bodyMd,
    status: row.status,
    priority: row.priority,
    startAt: row.startAt,
    dueAt: row.dueAt,
    estimateMin: row.estimateMin,
    assigneeUserId: row.assigneeUserId,
    parentId: row.parentId,
    sortKey: row.sortKey,
    sourceNoteId: row.sourceNoteId,
    sourceNoteTitle: extras.sourceNoteTitle ?? null,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    completedBy: row.completedBy,
    actualSeconds: extras.actualSeconds,
    children: extras.children,
  };
}

async function noteTitles(ids: Array<string | null | undefined>) {
  const clean = [...new Set(ids.filter((x): x is string => !!x))];
  if (!clean.length) return new Map<string, string>();
  const rows = await db.select({ id: notes.id, title: notes.title }).from(notes).where(inArray(notes.id, clean));
  return new Map(rows.map(r => [r.id, r.title]));
}

async function assertAssignee(workspaceId: string, userId: string | null | undefined) {
  if (!userId) return;
  const role = await memberRole(workspaceId, userId);
  if (!role) throw fail("VALIDATION", "指派人必须是工作区成员");
}

async function assertSourceNote(userId: string, noteId: string | null | undefined) {
  if (!noteId) return;
  await noteAccess(noteId, userId, "read");
}

async function assertParent(projectId: string, parentId: string | null | undefined, selfId?: string) {
  if (!parentId) return null;
  if (selfId && parentId === selfId) throw fail("VALIDATION", "任务不能挂自己");
  const [parent] = await db.select().from(projectTasks).where(eq(projectTasks.id, parentId));
  if (!parent || parent.projectId !== projectId) throw fail("NOT_FOUND", "父任务不存在");
  if (parent.parentId) throw fail("VALIDATION", "子任务不能再挂子任务");
  const [{ value }] = await db.select({ value: count() }).from(projectTasks).where(eq(projectTasks.parentId, parentId));
  if (Number(value) >= MAX_SUBTASKS) throw fail("VALIDATION", `每个任务最多 ${MAX_SUBTASKS} 条子任务`);
  return parent;
}

/** 项目的「今天 / 本周」按东八区民用日，别让 UTC 把周一凌晨算进上周。 */
function shanghaiDay(d: Date) {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}
function shanghaiWeekStart(now = new Date()) {
  const local = new Date(now.getTime() + 8 * 3600_000);
  const mondayOffset = (local.getUTCDay() + 6) % 7;
  local.setUTCHours(0, 0, 0, 0);
  local.setUTCDate(local.getUTCDate() - mondayOffset);
  return new Date(local.getTime() - 8 * 3600_000);
}

function rekey(ids: string[], beforeId?: string | null, afterId?: string | null) {
  const next = ids.slice();
  if (beforeId) {
    const i = next.indexOf(beforeId);
    if (i >= 0) return { before: next.slice(0, i), after: next.slice(i) };
  }
  if (afterId) {
    const i = next.indexOf(afterId);
    if (i >= 0) return { before: next.slice(0, i + 1), after: next.slice(i + 1) };
  }
  return { before: next, after: [] as string[] };
}

async function pulseOf(tasks: TaskRow[], entries: TimeRow[]) {
  const days: Array<{ day: string; completed: number; minutes: number }> = [];
  const now = new Date();
  const today = shanghaiDay(now);
  for (let i = 13; i >= 0; i--) {
    const d = new Date(`${today}T00:00:00.000+08:00`);
    d.setTime(d.getTime() - i * 86400_000);
    days.push({ day: shanghaiDay(d), completed: 0, minutes: 0 });
  }
  const index = new Map(days.map((d, i) => [d.day, i]));
  for (const t of tasks) {
    if (t.status !== "done" || !t.completedAt) continue;
    const key = shanghaiDay(t.completedAt);
    const at = index.get(key);
    if (at !== undefined) days[at]!.completed += 1;
  }
  for (const e of entries) {
    if (!e.endedAt) continue;
    const key = shanghaiDay(e.endedAt);
    const at = index.get(key);
    if (at !== undefined) days[at]!.minutes += Math.round(e.seconds / 60);
  }
  const byStatus: Record<string, number> = { backlog: 0, todo: 0, doing: 0, review: 0, done: 0, cancelled: 0 };
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const estimateMin = tasks.reduce((s, t) => s + (t.estimateMin ?? 0), 0);
  const actualSeconds = secondsOf(entries, undefined, true);
  const overdue = tasks.filter(t => t.status !== "done" && t.status !== "cancelled" && t.dueAt && t.dueAt.getTime() < now.getTime());
  const stale = tasks.filter(t => t.status === "doing" && now.getTime() - t.updatedAt.getTime() > 7 * 86400_000);
  return { byStatus, estimateMin, actualSeconds, days, overdue: overdue.map(t => ({ id: t.id, title: t.title, dueAt: t.dueAt })), stale: stale.map(t => ({ id: t.id, title: t.title, updatedAt: t.updatedAt })) };
}

// ── 列表 / 新建 ────────────────────────────────────────────────────────

projectRoutes.get("/workspaces/:id/projects/running", async c => {
  const workspaceId = c.req.param("id");
  const { user } = await workspaceContext(c, workspaceId);
  const [running] = await db.select().from(projectTimeEntries).where(and(eq(projectTimeEntries.userId, user.id), isNull(projectTimeEntries.endedAt))).limit(1);
  if (!running) return ok(c, { running: null });
  const [task] = await db.select().from(projectTasks).where(eq(projectTasks.id, running.taskId));
  const [project] = await db.select().from(projects).where(eq(projects.id, running.projectId));
  return ok(c, { running: { id: running.id, taskId: running.taskId, projectId: running.projectId, startedAt: running.startedAt, taskTitle: task?.title ?? "", projectTitle: project?.title ?? "" } });
});

projectRoutes.get("/workspaces/:id/projects", async c => {
  const workspaceId = c.req.param("id");
  const { user, role, ws } = await workspaceContext(c, workspaceId);
  const archived = c.req.query("archived") === "1";
  const rows = await db.select().from(projects).where(eq(projects.workspaceId, workspaceId)).orderBy(asc(projects.sortKey), desc(projects.updatedAt));
  const visible = rows.filter(r => canReadProject({ userId: user.id, wsRole: role, visibility: r.visibility as "workspace" | "private", createdBy: r.createdBy }));
  const listed = archived ? visible.filter(r => r.status === "archived") : visible.filter(r => r.status !== "archived");
  const ids = listed.map(r => r.id);
  const tasks = ids.length ? await db.select().from(projectTasks).where(inArray(projectTasks.projectId, ids)) : [];
  const entries = ids.length ? await db.select().from(projectTimeEntries).where(inArray(projectTimeEntries.projectId, ids)) : [];
  const tasksBy = new Map<string, TaskRow[]>();
  const entriesBy = new Map<string, TimeRow[]>();
  for (const t of tasks) tasksBy.set(t.projectId, [...(tasksBy.get(t.projectId) ?? []), t]);
  for (const e of entries) entriesBy.set(e.projectId, [...(entriesBy.get(e.projectId) ?? []), e]);

  const weekStart = shanghaiWeekStart();
  const weekTasks = tasks.filter(t => t.status === "done" && t.completedAt && t.completedAt >= weekStart);
  const weekSeconds = entries.filter(e => e.endedAt && e.endedAt >= weekStart).reduce((s, e) => s + e.seconds, 0);

  return ok(c, {
    canEdit: role !== "viewer" && !ws.frozen,
    rhythm: { completedThisWeek: weekTasks.length, minutesThisWeek: Math.round(weekSeconds / 60) },
    projects: listed.map(row => {
      const ts = tasksBy.get(row.id) ?? [];
      const es = entriesBy.get(row.id) ?? [];
      const health = healthOf(row, ts, es);
      const acl = { userId: user.id, wsRole: role, frozen: ws.frozen, visibility: row.visibility as "workspace" | "private", createdBy: row.createdBy, status: row.status as "planning" | "active" | "paused" | "done" | "archived" };
      return projectDto(row, {
        health,
        taskCount: ts.filter(t => t.status !== "cancelled").length,
        doneCount: ts.filter(t => t.status === "done").length,
        estimateMin: ts.reduce((s, t) => s + (t.estimateMin ?? 0), 0),
        actualSeconds: secondsOf(es, undefined, true),
        canEdit: canWriteProject(acl),
        canArchive: canArchiveProject(acl),
      });
    }),
  });
});

projectRoutes.post("/workspaces/:id/projects", async c => {
  const workspaceId = c.req.param("id");
  const { user, role, ws } = await workspaceContext(c, workspaceId);
  if (role === "viewer") throw fail("FORBIDDEN", "只读成员不能建项目");
  if (ws.frozen) throw fail("FORBIDDEN", "工作区已冻结，暂时只读");
  const body = projectCreate.parse(await c.req.json());
  const startAt = parseTime(body.startAt);
  const dueAt = parseTime(body.dueAt);
  rangeOk(startAt, dueAt);
  const [{ value }] = await db.select({ value: count() }).from(projects).where(and(eq(projects.workspaceId, workspaceId), ne(projects.status, "archived")));
  if (Number(value) >= MAX_ACTIVE_PROJECTS) throw fail("VALIDATION", `每个工作区最多 ${MAX_ACTIVE_PROJECTS} 个未归档项目`);
  const keys = await db.select({ sortKey: projects.sortKey }).from(projects).where(eq(projects.workspaceId, workspaceId));
  const [row] = await db.insert(projects).values({
    workspaceId,
    title: body.title,
    description: body.description ?? "",
    status: body.status === "archived" ? "planning" : (body.status ?? "planning"),
    color: body.color ?? "ink",
    startAt,
    dueAt,
    visibility: body.visibility ?? "workspace",
    sortKey: nextSortKey(keys.map(k => k.sortKey)),
    createdBy: user.id,
    updatedBy: user.id,
  }).returning();
  await audit(workspaceId, user.id, "project.create", "project", row.id, { title: row.title });
  const health = scoreProjectHealth({ dueAt: row.dueAt }, []);
  return ok(c, projectDto(row, { health, taskCount: 0, doneCount: 0, estimateMin: 0, actualSeconds: 0, canEdit: true, canArchive: true }), 201);
});

// ── 单个项目 ──────────────────────────────────────────────────────────

projectRoutes.get("/projects/:id", async c => {
  const { user, role, ws, project, acl } = await loadProject(c, c.req.param("id"));
  const tasks = await db.select().from(projectTasks).where(eq(projectTasks.projectId, project.id)).orderBy(asc(projectTasks.sortKey), asc(projectTasks.createdAt));
  const entries = await db.select().from(projectTimeEntries).where(eq(projectTimeEntries.projectId, project.id));
  const milestones = await db.select().from(projectMilestones).where(eq(projectMilestones.projectId, project.id)).orderBy(asc(projectMilestones.sortKey), asc(projectMilestones.dueAt));
  const titles = await noteTitles(tasks.map(t => t.sourceNoteId));
  const health = healthOf(project, tasks, entries);
  const running = entries.find(e => !e.endedAt && e.userId === user.id) ?? null;
  const todayKey = shanghaiDay(new Date());
  const todaySeconds = entries.filter(e => e.userId === user.id && e.endedAt && shanghaiDay(e.endedAt) === todayKey).reduce((s, e) => s + e.seconds, 0)
    + (running ? Math.max(0, Math.round((Date.now() - running.startedAt.getTime()) / 1000)) : 0);
  const parents = tasks.filter(t => !t.parentId);
  const childrenOf = (id: string) => tasks.filter(t => t.parentId === id).map(t => taskDto(t, { actualSeconds: secondsOf(entries, t.id, true), sourceNoteTitle: t.sourceNoteId ? titles.get(t.sourceNoteId) ?? null : null }));
  return ok(c, {
    project: projectDto(project, {
      health,
      taskCount: tasks.filter(t => t.status !== "cancelled").length,
      doneCount: tasks.filter(t => t.status === "done").length,
      estimateMin: tasks.reduce((s, t) => s + (t.estimateMin ?? 0), 0),
      actualSeconds: secondsOf(entries, undefined, true),
      canEdit: canWriteProject({ ...acl, status: project.status === "archived" ? "active" : acl.status }) && project.status !== "archived" && !ws.frozen && role !== "viewer",
      canArchive: canArchiveProject(acl),
    }),
    tasks: parents.map(t => taskDto(t, {
      actualSeconds: secondsOf(entries, t.id, true),
      sourceNoteTitle: t.sourceNoteId ? titles.get(t.sourceNoteId) ?? null : null,
      children: childrenOf(t.id),
    })),
    cancelled: tasks.filter(t => t.status === "cancelled").map(t => taskDto(t, { actualSeconds: secondsOf(entries, t.id, true) })),
    milestones,
    running: running ? { id: running.id, taskId: running.taskId, startedAt: running.startedAt } : null,
    todaySeconds,
    pulse: await pulseOf(tasks, entries),
    me: user.id,
    canEdit: project.status !== "archived" && !ws.frozen && role !== "viewer",
  });
});

projectRoutes.patch("/projects/:id", async c => {
  const body = projectPatch.parse(await c.req.json());
  const needsArchive = body.visibility !== undefined || body.status === "archived";
  const { user, role, ws, project, acl } = await loadProject(c, c.req.param("id"), needsArchive ? "archive" : "write");
  const startAt = body.startAt !== undefined ? parseTime(body.startAt) : project.startAt;
  const dueAt = body.dueAt !== undefined ? parseTime(body.dueAt) : project.dueAt;
  rangeOk(startAt ?? null, dueAt ?? null);
  const nextStatus = body.status ?? project.status;
  const [saved] = await db.update(projects).set({
    title: body.title ?? project.title,
    description: body.description ?? project.description,
    status: nextStatus,
    color: body.color ?? project.color,
    startAt: startAt === undefined ? project.startAt : startAt,
    dueAt: dueAt === undefined ? project.dueAt : dueAt,
    visibility: body.visibility ?? project.visibility,
    updatedBy: user.id,
    updatedAt: new Date(),
    archivedAt: nextStatus === "archived" ? (project.archivedAt ?? new Date()) : null,
  }).where(eq(projects.id, project.id)).returning();
  await audit(project.workspaceId, user.id, "project.update", "project", project.id, { status: saved.status, visibility: saved.visibility });
  const tasks = await db.select().from(projectTasks).where(eq(projectTasks.projectId, project.id));
  const entries = await db.select().from(projectTimeEntries).where(eq(projectTimeEntries.projectId, project.id));
  return ok(c, projectDto(saved, {
    health: healthOf(saved, tasks, entries),
    taskCount: tasks.filter(t => t.status !== "cancelled").length,
    doneCount: tasks.filter(t => t.status === "done").length,
    estimateMin: tasks.reduce((s, t) => s + (t.estimateMin ?? 0), 0),
    actualSeconds: secondsOf(entries, undefined, true),
    canEdit: saved.status !== "archived" && !ws.frozen && role !== "viewer",
    canArchive: canArchiveProject(acl),
  }));
});

projectRoutes.post("/projects/:id/archive", async c => {
  const { user, project } = await loadProject(c, c.req.param("id"), "archive");
  const [saved] = await db.update(projects).set({
    status: "archived",
    archivedAt: project.archivedAt ?? new Date(),
    updatedBy: user.id,
    updatedAt: new Date(),
  }).where(eq(projects.id, project.id)).returning();
  await audit(project.workspaceId, user.id, "project.archive", "project", project.id);
  return ok(c, { id: saved.id, status: saved.status, archivedAt: saved.archivedAt });
});

projectRoutes.post("/projects/:id/unarchive", async c => {
  const { user, project, ws } = await loadProject(c, c.req.param("id"), "archive");
  const [{ value }] = await db.select({ value: count() }).from(projects).where(and(eq(projects.workspaceId, project.workspaceId), ne(projects.status, "archived")));
  if (Number(value) >= MAX_ACTIVE_PROJECTS) throw fail("VALIDATION", `每个工作区最多 ${MAX_ACTIVE_PROJECTS} 个未归档项目`);
  if (ws.frozen) throw fail("FORBIDDEN", "工作区已冻结，暂时只读");
  const [saved] = await db.update(projects).set({
    status: "done",
    archivedAt: null,
    updatedBy: user.id,
    updatedAt: new Date(),
  }).where(eq(projects.id, project.id)).returning();
  await audit(project.workspaceId, user.id, "project.unarchive", "project", project.id);
  return ok(c, { id: saved.id, status: saved.status, archivedAt: saved.archivedAt });
});

// ── 任务 ──────────────────────────────────────────────────────────────

projectRoutes.post("/projects/:id/tasks", async c => {
  const { user, project } = await loadProject(c, c.req.param("id"), "write");
  const body = taskCreate.parse(await c.req.json());
  const [{ value }] = await db.select({ value: count() }).from(projectTasks).where(eq(projectTasks.projectId, project.id));
  if (Number(value) >= MAX_TASKS_PER_PROJECT) throw fail("VALIDATION", `每个项目最多 ${MAX_TASKS_PER_PROJECT} 条任务`);
  await assertAssignee(project.workspaceId, body.assigneeUserId);
  await assertSourceNote(user.id, body.sourceNoteId);
  const parent = await assertParent(project.id, body.parentId);
  const startAt = parseTime(body.startAt);
  const dueAt = parseTime(body.dueAt);
  rangeOk(startAt, dueAt);
  const status = body.status ?? "todo";
  const siblings = await db.select({ sortKey: projectTasks.sortKey }).from(projectTasks)
    .where(and(eq(projectTasks.projectId, project.id), eq(projectTasks.status, status), parent ? eq(projectTasks.parentId, parent.id) : isNull(projectTasks.parentId)));
  const done = status === "done";
  const [row] = await db.insert(projectTasks).values({
    projectId: project.id,
    workspaceId: project.workspaceId,
    title: body.title,
    bodyMd: body.bodyMd ?? "",
    status,
    priority: body.priority ?? 0,
    startAt,
    dueAt,
    estimateMin: body.estimateMin ?? null,
    assigneeUserId: body.assigneeUserId ?? null,
    parentId: parent?.id ?? null,
    sortKey: nextSortKey(siblings.map(s => s.sortKey)),
    sourceNoteId: body.sourceNoteId ?? null,
    createdBy: user.id,
    updatedBy: user.id,
    completedAt: done ? new Date() : null,
    completedBy: done ? user.id : null,
  }).returning();
  await db.update(projects).set({ updatedAt: new Date(), updatedBy: user.id }).where(eq(projects.id, project.id));
  await audit(project.workspaceId, user.id, "project_task.create", "project_task", row.id, { title: row.title, status: row.status });
  return ok(c, taskDto(row, { actualSeconds: 0 }), 201);
});

projectRoutes.patch("/project-tasks/:id", async c => {
  const { user, task, project } = await loadTask(c, c.req.param("id"), "write");
  const body = taskPatch.parse(await c.req.json());
  await assertAssignee(project.workspaceId, body.assigneeUserId);
  await assertSourceNote(user.id, body.sourceNoteId);
  if (body.parentId !== undefined) await assertParent(project.id, body.parentId, task.id);
  const startAt = body.startAt !== undefined ? parseTime(body.startAt) : task.startAt;
  const dueAt = body.dueAt !== undefined ? parseTime(body.dueAt) : task.dueAt;
  rangeOk(startAt, dueAt);
  const nextStatus = body.status ?? task.status;
  const becomingDone = nextStatus === "done" && task.status !== "done";
  const leavingDone = nextStatus !== "done" && task.status === "done";
  const [saved] = await db.update(projectTasks).set({
    title: body.title ?? task.title,
    bodyMd: body.bodyMd ?? task.bodyMd,
    status: nextStatus,
    priority: body.priority ?? task.priority,
    startAt,
    dueAt,
    estimateMin: body.estimateMin === undefined ? task.estimateMin : body.estimateMin,
    assigneeUserId: body.assigneeUserId === undefined ? task.assigneeUserId : body.assigneeUserId,
    parentId: body.parentId === undefined ? task.parentId : body.parentId,
    sourceNoteId: body.sourceNoteId === undefined ? task.sourceNoteId : body.sourceNoteId,
    updatedBy: user.id,
    updatedAt: new Date(),
    completedAt: becomingDone ? new Date() : leavingDone ? null : task.completedAt,
    completedBy: becomingDone ? user.id : leavingDone ? null : task.completedBy,
  }).where(eq(projectTasks.id, task.id)).returning();
  await db.update(projects).set({ updatedAt: new Date(), updatedBy: user.id }).where(eq(projects.id, project.id));
  await audit(project.workspaceId, user.id, "project_task.update", "project_task", task.id, { status: saved.status });
  const entries = await db.select().from(projectTimeEntries).where(eq(projectTimeEntries.taskId, task.id));
  return ok(c, taskDto(saved, { actualSeconds: secondsOf(entries, task.id, true) }));
});

projectRoutes.post("/project-tasks/:id/move", async c => {
  const { user, task, project } = await loadTask(c, c.req.param("id"), "write");
  const body = taskMove.parse(await c.req.json());
  const siblings = (await db.select().from(projectTasks).where(and(
    eq(projectTasks.projectId, project.id),
    eq(projectTasks.status, body.status),
    task.parentId ? eq(projectTasks.parentId, task.parentId) : isNull(projectTasks.parentId),
  ))).sort((a, b) => a.sortKey - b.sortKey || +a.createdAt - +b.createdAt);
  const others = siblings.filter(s => s.id !== task.id).map(s => s.id);
  const { before, after } = rekey(others, body.beforeId, body.afterId);
  const ordered = [...before, task.id, ...after];
  await db.transaction(async tx => {
    for (let i = 0; i < ordered.length; i++) {
      const patch: { sortKey: number; status?: string; updatedAt: Date; updatedBy: string; completedAt?: Date | null; completedBy?: string | null } = {
        sortKey: i, updatedAt: new Date(), updatedBy: user.id,
      };
      if (ordered[i] === task.id) {
        patch.status = body.status;
        if (body.status === "done" && task.status !== "done") { patch.completedAt = new Date(); patch.completedBy = user.id; }
        if (body.status !== "done" && task.status === "done") { patch.completedAt = null; patch.completedBy = null; }
      }
      await tx.update(projectTasks).set(patch).where(eq(projectTasks.id, ordered[i]!));
    }
    await tx.update(projects).set({ updatedAt: new Date(), updatedBy: user.id }).where(eq(projects.id, project.id));
  });
  await audit(project.workspaceId, user.id, "project_task.move", "project_task", task.id, { status: body.status });
  const [saved] = await db.select().from(projectTasks).where(eq(projectTasks.id, task.id));
  return ok(c, taskDto(saved, { actualSeconds: 0 }));
});

projectRoutes.post("/project-tasks/:id/reschedule", async c => {
  const { user, task, project } = await loadTask(c, c.req.param("id"), "write");
  const body = taskReschedule.parse(await c.req.json());
  const startAt = parseTime(body.startAt);
  const dueAt = parseTime(body.dueAt);
  rangeOk(startAt, dueAt);
  if (!startAt && !dueAt) throw fail("VALIDATION", "甘特条至少要有一个日期");
  const [saved] = await db.update(projectTasks).set({
    startAt, dueAt, updatedBy: user.id, updatedAt: new Date(),
  }).where(eq(projectTasks.id, task.id)).returning();
  await db.update(projects).set({ updatedAt: new Date(), updatedBy: user.id }).where(eq(projects.id, project.id));
  await audit(project.workspaceId, user.id, "project_task.reschedule", "project_task", task.id, { startAt, dueAt });
  return ok(c, taskDto(saved, { actualSeconds: 0 }));
});

projectRoutes.delete("/project-tasks/:id", async c => {
  const { user, task, project } = await loadTask(c, c.req.param("id"), "write");
  const children = await db.select({ id: projectTasks.id }).from(projectTasks).where(eq(projectTasks.parentId, task.id));
  const doomed = [task.id, ...children.map(row => row.id)];
  await db.delete(projectTimeEntries).where(inArray(projectTimeEntries.taskId, doomed));
  await db.delete(projectTasks).where(eq(projectTasks.parentId, task.id));
  await db.delete(projectTasks).where(eq(projectTasks.id, task.id));
  await db.update(projects).set({ updatedAt: new Date(), updatedBy: user.id }).where(eq(projects.id, project.id));
  await audit(project.workspaceId, user.id, "project_task.delete", "project_task", task.id, { title: task.title });
  return ok(c, { id: task.id });
});

// ── 计时 ──────────────────────────────────────────────────────────────

async function stopEntry(entry: TimeRow, note?: string) {
  const ended = new Date();
  const seconds = Math.max(1, Math.round((ended.getTime() - entry.startedAt.getTime()) / 1000));
  const [saved] = await db.update(projectTimeEntries).set({
    endedAt: ended,
    seconds,
    note: note ?? entry.note,
  }).where(eq(projectTimeEntries.id, entry.id)).returning();
  return saved;
}

projectRoutes.post("/projects/:id/time/start", async c => {
  const { user, project } = await loadProject(c, c.req.param("id"), "write");
  const body = timeStart.parse(await c.req.json());
  const [task] = await db.select().from(projectTasks).where(eq(projectTasks.id, body.taskId));
  if (!task || task.projectId !== project.id) throw fail("NOT_FOUND", "任务不存在");
  const open = await db.select().from(projectTimeEntries).where(and(eq(projectTimeEntries.userId, user.id), isNull(projectTimeEntries.endedAt)));
  const stopped = [];
  for (const entry of open) stopped.push(await stopEntry(entry));
  const [row] = await db.insert(projectTimeEntries).values({
    projectId: project.id,
    taskId: task.id,
    userId: user.id,
    startedAt: new Date(),
  }).returning();
  await audit(project.workspaceId, user.id, "project_time.start", "project_task", task.id, { entryId: row.id, stopped: stopped.map(s => s.id) });
  return ok(c, { running: { id: row.id, taskId: row.taskId, startedAt: row.startedAt }, stopped: stopped.map(s => ({ id: s.id, seconds: s.seconds })) });
});

projectRoutes.post("/projects/:id/time/stop", async c => {
  const { user, project } = await loadProject(c, c.req.param("id"), "write");
  const body = timeStop.parse(await c.req.json().catch(() => ({})));
  const [running] = body.entryId
    ? await db.select().from(projectTimeEntries).where(eq(projectTimeEntries.id, body.entryId))
    : await db.select().from(projectTimeEntries).where(and(eq(projectTimeEntries.projectId, project.id), eq(projectTimeEntries.userId, user.id), isNull(projectTimeEntries.endedAt))).limit(1);
  if (!running || running.userId !== user.id || running.endedAt) throw fail("NOT_FOUND", "没有正在跑的计时");
  const saved = await stopEntry(running);
  await audit(project.workspaceId, user.id, "project_time.stop", "project_task", saved.taskId, { entryId: saved.id, seconds: saved.seconds });
  return ok(c, { entry: { id: saved.id, taskId: saved.taskId, startedAt: saved.startedAt, endedAt: saved.endedAt, seconds: saved.seconds } });
});

projectRoutes.post("/projects/:id/time", async c => {
  const { user, project } = await loadProject(c, c.req.param("id"), "write");
  const body = timeManual.parse(await c.req.json());
  const [task] = await db.select().from(projectTasks).where(eq(projectTasks.id, body.taskId));
  if (!task || task.projectId !== project.id) throw fail("NOT_FOUND", "任务不存在");
  const startedAt = new Date(body.startedAt);
  const endedAt = new Date(body.endedAt);
  if (endedAt.getTime() <= startedAt.getTime()) throw fail("VALIDATION", "结束必须晚于开始");
  const seconds = Math.max(1, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000));
  const [row] = await db.insert(projectTimeEntries).values({
    projectId: project.id,
    taskId: task.id,
    userId: user.id,
    startedAt,
    endedAt,
    seconds,
    note: body.note ?? "补录",
  }).returning();
  await audit(project.workspaceId, user.id, "project_time.manual", "project_task", task.id, { entryId: row.id, seconds });
  return ok(c, { entry: { id: row.id, taskId: row.taskId, startedAt: row.startedAt, endedAt: row.endedAt, seconds: row.seconds, note: row.note } }, 201);
});

projectRoutes.get("/projects/:id/time", async c => {
  const { project } = await loadProject(c, c.req.param("id"));
  const rows = await db.select({
    id: projectTimeEntries.id,
    taskId: projectTimeEntries.taskId,
    userId: projectTimeEntries.userId,
    startedAt: projectTimeEntries.startedAt,
    endedAt: projectTimeEntries.endedAt,
    seconds: projectTimeEntries.seconds,
    note: projectTimeEntries.note,
    displayName: users.displayName,
    taskTitle: projectTasks.title,
  }).from(projectTimeEntries)
    .innerJoin(users, eq(users.id, projectTimeEntries.userId))
    .innerJoin(projectTasks, eq(projectTasks.id, projectTimeEntries.taskId))
    .where(eq(projectTimeEntries.projectId, project.id))
    .orderBy(desc(projectTimeEntries.startedAt));
  return ok(c, { entries: rows });
});

// ── 里程碑 ────────────────────────────────────────────────────────────

projectRoutes.post("/projects/:id/milestones", async c => {
  const { user, project } = await loadProject(c, c.req.param("id"), "write");
  const body = milestoneCreate.parse(await c.req.json());
  const keys = await db.select({ sortKey: projectMilestones.sortKey }).from(projectMilestones).where(eq(projectMilestones.projectId, project.id));
  const [row] = await db.insert(projectMilestones).values({
    projectId: project.id,
    title: body.title,
    dueAt: new Date(body.dueAt),
    done: body.done ?? false,
    sortKey: nextSortKey(keys.map(k => k.sortKey)),
  }).returning();
  await audit(project.workspaceId, user.id, "project_milestone.create", "project", project.id, { milestoneId: row.id, title: row.title });
  return ok(c, row, 201);
});

projectRoutes.patch("/project-milestones/:id", async c => {
  const [row] = await db.select().from(projectMilestones).where(eq(projectMilestones.id, c.req.param("id")));
  if (!row) throw fail("NOT_FOUND", "里程碑不存在");
  const { user, project } = await loadProject(c, row.projectId, "write");
  const body = milestoneCreate.partial().parse(await c.req.json());
  const [saved] = await db.update(projectMilestones).set({
    title: body.title ?? row.title,
    dueAt: body.dueAt ? new Date(body.dueAt) : row.dueAt,
    done: body.done ?? row.done,
  }).where(eq(projectMilestones.id, row.id)).returning();
  await audit(project.workspaceId, user.id, "project_milestone.update", "project", project.id, { milestoneId: saved.id, done: saved.done });
  return ok(c, saved);
});

projectRoutes.delete("/project-milestones/:id", async c => {
  const [row] = await db.select().from(projectMilestones).where(eq(projectMilestones.id, c.req.param("id")));
  if (!row) throw fail("NOT_FOUND", "里程碑不存在");
  const { user, project } = await loadProject(c, row.projectId, "write");
  await db.delete(projectMilestones).where(eq(projectMilestones.id, row.id));
  await audit(project.workspaceId, user.id, "project_milestone.delete", "project", project.id, { milestoneId: row.id, title: row.title });
  return ok(c, { id: row.id });
});
