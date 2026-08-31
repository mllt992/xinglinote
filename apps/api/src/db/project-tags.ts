import { index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { projectMilestones, projectTasks, projects } from "./schema.ts";

/** 项目内标签。color 与项目色同一套语义 token：ink | accent | good | warn | muted。 */
export const projectTags = pgTable("project_tags", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color").notNull().default("ink"),
  sortKey: integer("sort_key").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  uniqueIndex("project_tags_project_name_idx").on(t.projectId, t.name),
  index("project_tags_project_idx").on(t.projectId, t.sortKey),
]);

/** 任务挂标签。删任务或删标签时级联摘掉。 */
export const projectTaskTags = pgTable("project_task_tags", {
  taskId: uuid("task_id").notNull().references(() => projectTasks.id, { onDelete: "cascade" }),
  tagId: uuid("tag_id").notNull().references(() => projectTags.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  primaryKey({ columns: [t.taskId, t.tagId] }),
  index("project_task_tags_tag_idx").on(t.tagId),
]);

/** 一件任务最多挂一个本项目里程碑。起止日期仍在任务自己的 start_at / due_at。 */
export const projectTaskMilestones = pgTable("project_task_milestones", {
  taskId: uuid("task_id").primaryKey().references(() => projectTasks.id, { onDelete: "cascade" }),
  milestoneId: uuid("milestone_id").notNull().references(() => projectMilestones.id, { onDelete: "cascade" }),
}, t => [
  index("project_task_milestones_milestone_idx").on(t.milestoneId),
]);
