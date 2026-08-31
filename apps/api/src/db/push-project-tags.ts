import { sql } from "./client.ts";

const statements = [
  `CREATE TABLE IF NOT EXISTS project_tags (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name text NOT NULL,
    color text NOT NULL DEFAULT 'ink',
    sort_key integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS project_tags_project_name_idx ON project_tags(project_id, name)`,
  `CREATE INDEX IF NOT EXISTS project_tags_project_idx ON project_tags(project_id, sort_key)`,
  `CREATE TABLE IF NOT EXISTS project_task_tags (
    task_id uuid NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
    tag_id uuid NOT NULL REFERENCES project_tags(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, tag_id)
  )`,
  `CREATE INDEX IF NOT EXISTS project_task_tags_tag_idx ON project_task_tags(tag_id)`,
  `CREATE TABLE IF NOT EXISTS project_task_milestones (
    task_id uuid PRIMARY KEY REFERENCES project_tasks(id) ON DELETE CASCADE,
    milestone_id uuid NOT NULL REFERENCES project_milestones(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS project_task_milestones_milestone_idx ON project_task_milestones(milestone_id)`,
];

async function main() {
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
  console.log("project_tags ready");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
