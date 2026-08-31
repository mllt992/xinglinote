import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { projects } from "./schema.ts";

/** 看板列。key 写入 project_tasks.status，与现有 backlog|todo|doing|review|done 对齐。cancelled 不是列。 */
export const projectColumns = pgTable("project_columns", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  title: text("title").notNull(),
  key: text("key").notNull(),
  sortKey: integer("sort_key").notNull().default(0),
  isDefault: boolean("is_default").notNull().default(false),
  isDone: boolean("is_done").notNull().default(false),
  isWip: boolean("is_wip").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  uniqueIndex("project_columns_project_key_idx").on(t.projectId, t.key),
  index("project_columns_project_idx").on(t.projectId, t.sortKey),
]);
