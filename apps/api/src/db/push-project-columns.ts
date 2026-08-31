import { sql } from "./client.ts";

const statements = [
  `CREATE TABLE IF NOT EXISTS project_columns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id),
    title text NOT NULL,
    key text NOT NULL,
    sort_key integer NOT NULL DEFAULT 0,
    is_default boolean NOT NULL DEFAULT false,
    is_done boolean NOT NULL DEFAULT false,
    is_wip boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS project_columns_project_key_idx ON project_columns(project_id, key)`,
  `CREATE INDEX IF NOT EXISTS project_columns_project_idx ON project_columns(project_id, sort_key)`,
  `INSERT INTO project_columns (project_id, title, key, sort_key, is_default, is_done, is_wip)
     SELECT p.id, d.title, d.key, d.sort_key, d.is_default, d.is_done, d.is_wip
     FROM projects p
     CROSS JOIN (VALUES
       ('积压', 'backlog', 0, true, false, false),
       ('待办', 'todo', 1, false, false, false),
       ('进行', 'doing', 2, false, false, true),
       ('复核', 'review', 3, false, false, false),
       ('完成', 'done', 4, false, true, false)
     ) AS d(title, key, sort_key, is_default, is_done, is_wip)
     WHERE NOT EXISTS (SELECT 1 FROM project_columns c WHERE c.project_id = p.id)`,
];

let todo = statements;
while (todo.length) {
  const failed: Array<{ sql: string; error: unknown }> = [];
  for (const s of todo) {
    try { await sql.unsafe(s); } catch (error) { failed.push({ sql: s, error }); }
  }
  if (failed.length === todo.length) {
    console.error(`还有 ${failed.length} 条语句无法执行，第一条：\n${failed[0]!.sql}`);
    throw failed[0]!.error;
  }
  todo = failed.map((f) => f.sql);
}
console.log("project_columns ready");
