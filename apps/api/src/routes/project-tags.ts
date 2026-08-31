import { Hono } from "hono";
import { and, asc, count, eq } from "drizzle-orm";
import { z } from "zod";
import {
  MAX_TAGS_PER_PROJECT,
  MAX_TAGS_PER_TASK,
  TAG_COLORS,
  canReadProject,
  canWriteProject,
  isTagColor,
  type WsRole,
} from "@kb/core";
import { fail, nextSortKey } from "@kb/shared";
import { db } from "../db/client.ts";
import { auditLogs, projectMilestones, projectTasks, projects, workspaces } from "../db/schema.ts";
import { projectTags, projectTaskMilestones, projectTaskTags } from "../db/project-tags.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";
import { memberRole } from "../lib/workspace.ts";

export const projectTagRoutes = new Hono();

const tagCreate = z.object({
  name: z.string().trim().min(1).max(24),
  color: z.enum(TAG_COLORS).optional(),
});
const tagPatch = tagCreate.partial();
const assignTag = z.object({ tagId: z.string().uuid() });
const assignMilestone = z.object({ milestoneId: z.string().uuid().nullable() });

async function requireUser(c: Parameters<typeof currentUser>[0]) {
  const user = await currentUser(c);
  if (!user) throw fail("UNAUTHENTICATED", "未登录");
  return user;
}

async function loadProject(c: Parameters<typeof currentUser>[0], id: string, mode: "read" | "write" = "read") {
  const [row] = await db.select().from(projects).where(eq(projects.id, id));
  if (!row) throw fail("NOT_FOUND", "项目不存在");
  const user = await requireUser(c);
  const role = await memberRole(row.workspaceId, user.id);
  if (!role) throw fail("NOT_FOUND", "工作区不存在");
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId));
  if (!ws) throw fail("NOT_FOUND", "工作区不存在");
  const acl = {
    userId: user.id, wsRole: role as WsRole, frozen: ws.frozen,
    visibility: row.visibility as "workspace" | "private",
    createdBy: row.createdBy,
    status: row.status as "planning" | "active" | "paused" | "done" | "archived",
  };
  if (!canReadProject(acl)) throw fail("NOT_FOUND", "项目不存在");
  if (mode === "write" && !canWriteProject(acl)) {
    if (role === "viewer" || ws.frozen) throw fail("FORBIDDEN", ws.frozen ? "工作区已冻结，暂时只读" : "只读成员不能改项目");
    throw fail("FORBIDDEN", "已归档的项目只读");
  }
  return { user, project: row };
}

async function loadTask(c: Parameters<typeof currentUser>[0], id: string, mode: "read" | "write" = "read") {
  const [task] = await db.select().from(projectTasks).where(eq(projectTasks.id, id));
  if (!task) throw fail("NOT_FOUND", "任务不存在");
  const ctx = await loadProject(c, task.projectId, mode);
  return { ...ctx, task };
}

async function audit(workspaceId: string, userId: string, action: string, targetType: "project" | "project_task", targetId: string | null, details?: Record<string, unknown>) {
  await db.insert(auditLogs).values({
    userId, workspaceId, actorType: "user", actorId: userId,
    action, targetType, targetId, result: "ok", details: details ?? null,
  });
}

function tagDto(row: typeof projectTags.$inferSelect) {
  return { id: row.id, projectId: row.projectId, name: row.name, color: row.color, sortKey: row.sortKey };
}

function normalizeName(name: string) {
  return name.trim().replace(/\s+/g, " ");
}

async function assertUniqueName(projectId: string, name: string, selfId?: string) {
  const rows = await db.select().from(projectTags).where(eq(projectTags.projectId, projectId));
  const key = name.toLowerCase();
  if (rows.some(row => row.name.toLowerCase() === key && row.id !== selfId)) {
    throw fail("VALIDATION", "这个项目里已经有同名标签");
  }
}

projectTagRoutes.get("/projects/:id/tags", async c => {
  const { project } = await loadProject(c, c.req.param("id"));
  const tags = await db.select().from(projectTags).where(eq(projectTags.projectId, project.id)).orderBy(asc(projectTags.sortKey), asc(projectTags.createdAt));
  const assignments = tags.length
    ? await db.select({ taskId: projectTaskTags.taskId, tagId: projectTaskTags.tagId }).from(projectTaskTags)
      .innerJoin(projectTasks, eq(projectTasks.id, projectTaskTags.taskId))
      .where(eq(projectTasks.projectId, project.id))
    : [];
  const taskMilestones = await db.select({
    taskId: projectTaskMilestones.taskId,
    milestoneId: projectTaskMilestones.milestoneId,
  }).from(projectTaskMilestones)
    .innerJoin(projectTasks, eq(projectTasks.id, projectTaskMilestones.taskId))
    .where(eq(projectTasks.projectId, project.id));
  return ok(c, { tags: tags.map(tagDto), assignments, taskMilestones });
});

projectTagRoutes.post("/projects/:id/tags", async c => {
  const { user, project } = await loadProject(c, c.req.param("id"), "write");
  const body = tagCreate.parse(await c.req.json());
  const name = normalizeName(body.name);
  const [{ value }] = await db.select({ value: count() }).from(projectTags).where(eq(projectTags.projectId, project.id));
  if (Number(value) >= MAX_TAGS_PER_PROJECT) throw fail("VALIDATION", `每个项目最多 ${MAX_TAGS_PER_PROJECT} 个标签`);
  await assertUniqueName(project.id, name);
  const keys = await db.select({ sortKey: projectTags.sortKey }).from(projectTags).where(eq(projectTags.projectId, project.id));
  const color = body.color ?? TAG_COLORS[Number(value) % TAG_COLORS.length]!;
  const [row] = await db.insert(projectTags).values({
    projectId: project.id,
    name,
    color,
    sortKey: nextSortKey(keys.map(k => k.sortKey)),
  }).returning();
  await audit(project.workspaceId, user.id, "project_tag.create", "project", project.id, { tagId: row.id, name: row.name });
  return ok(c, tagDto(row), 201);
});

projectTagRoutes.patch("/project-tags/:id", async c => {
  const [row] = await db.select().from(projectTags).where(eq(projectTags.id, c.req.param("id")));
  if (!row) throw fail("NOT_FOUND", "标签不存在");
  const { user, project } = await loadProject(c, row.projectId, "write");
  const body = tagPatch.parse(await c.req.json());
  const name = body.name !== undefined ? normalizeName(body.name) : row.name;
  if (!name) throw fail("VALIDATION", "标签名不能为空");
  if (body.color !== undefined && !isTagColor(body.color)) throw fail("VALIDATION", "标签颜色不合法");
  await assertUniqueName(project.id, name, row.id);
  const [saved] = await db.update(projectTags).set({
    name,
    color: body.color ?? row.color,
  }).where(eq(projectTags.id, row.id)).returning();
  await audit(project.workspaceId, user.id, "project_tag.update", "project", project.id, { tagId: saved.id, name: saved.name });
  return ok(c, tagDto(saved));
});

projectTagRoutes.delete("/project-tags/:id", async c => {
  const [row] = await db.select().from(projectTags).where(eq(projectTags.id, c.req.param("id")));
  if (!row) throw fail("NOT_FOUND", "标签不存在");
  const { user, project } = await loadProject(c, row.projectId, "write");
  await db.delete(projectTaskTags).where(eq(projectTaskTags.tagId, row.id));
  await db.delete(projectTags).where(eq(projectTags.id, row.id));
  await audit(project.workspaceId, user.id, "project_tag.delete", "project", project.id, { tagId: row.id, name: row.name });
  return ok(c, { id: row.id });
});

projectTagRoutes.post("/project-tasks/:id/tags", async c => {
  const { user, task, project } = await loadTask(c, c.req.param("id"), "write");
  const body = assignTag.parse(await c.req.json());
  const [tag] = await db.select().from(projectTags).where(eq(projectTags.id, body.tagId));
  if (!tag || tag.projectId !== project.id) throw fail("NOT_FOUND", "标签不存在");
  const [{ value }] = await db.select({ value: count() }).from(projectTaskTags).where(eq(projectTaskTags.taskId, task.id));
  if (Number(value) >= MAX_TAGS_PER_TASK) throw fail("VALIDATION", `每件任务最多 ${MAX_TAGS_PER_TASK} 个标签`);
  const [hit] = await db.select().from(projectTaskTags).where(and(eq(projectTaskTags.taskId, task.id), eq(projectTaskTags.tagId, tag.id)));
  if (!hit) {
    await db.insert(projectTaskTags).values({ taskId: task.id, tagId: tag.id });
    await audit(project.workspaceId, user.id, "project_task.tag", "project_task", task.id, { tagId: tag.id });
  }
  return ok(c, { taskId: task.id, tagId: tag.id });
});

projectTagRoutes.delete("/project-tasks/:id/tags/:tagId", async c => {
  const { user, task, project } = await loadTask(c, c.req.param("id"), "write");
  const tagId = c.req.param("tagId");
  await db.delete(projectTaskTags).where(and(eq(projectTaskTags.taskId, task.id), eq(projectTaskTags.tagId, tagId)));
  await audit(project.workspaceId, user.id, "project_task.untag", "project_task", task.id, { tagId });
  return ok(c, { taskId: task.id, tagId });
});

projectTagRoutes.post("/project-tasks/:id/milestone", async c => {
  const { user, task, project } = await loadTask(c, c.req.param("id"), "write");
  const body = assignMilestone.parse(await c.req.json());
  if (body.milestoneId === null) {
    await db.delete(projectTaskMilestones).where(eq(projectTaskMilestones.taskId, task.id));
    await audit(project.workspaceId, user.id, "project_task.milestone", "project_task", task.id, { milestoneId: null });
    return ok(c, { taskId: task.id, milestoneId: null });
  }
  const [milestone] = await db.select().from(projectMilestones).where(eq(projectMilestones.id, body.milestoneId));
  if (!milestone || milestone.projectId !== project.id) throw fail("NOT_FOUND", "里程碑不存在");
  await db.delete(projectTaskMilestones).where(eq(projectTaskMilestones.taskId, task.id));
  await db.insert(projectTaskMilestones).values({ taskId: task.id, milestoneId: milestone.id });
  await audit(project.workspaceId, user.id, "project_task.milestone", "project_task", task.id, { milestoneId: milestone.id });
  return ok(c, { taskId: task.id, milestoneId: milestone.id });
});
