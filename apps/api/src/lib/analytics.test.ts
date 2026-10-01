import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { analyticsQuerySchema, analyticsWindow, buildAnalyticsQuery } from "./analytics.ts";

test("统计只接受有界的 7/30 天与 UUID 筛选", () => {
  assert.deepEqual(analyticsQuerySchema.parse({}), { days: "30" });
  assert.equal(analyticsQuerySchema.parse({ days: "7" }).days, "7");
  for (const days of ["0", "8", "365000", "7; drop table notes"]) assert.equal(analyticsQuerySchema.safeParse({ days }).success, false);
  assert.equal(analyticsQuerySchema.safeParse({ notebookId: "not-a-uuid" }).success, false);
});

test("UTC 自然日跨月、闰年与非 UTC 输入，始终包含当天", () => {
  assert.deepEqual(analyticsWindow(7, new Date("2024-03-01T00:30:00+08:00")), {
    from: "2024-02-23T00:00:00.000Z", until: "2024-03-01T00:00:00.000Z", through: "2024-02-29",
  });
  const range = analyticsWindow(30, new Date("2026-01-01T23:59:59Z"));
  assert.equal(range.from, "2025-12-03T00:00:00.000Z");
  assert.equal(Date.parse(range.until) - Date.parse(range.from), 30 * 86400_000);
});

test("聚合 SQL 参数化，主体、目标双链、任务和附件均从可读集合出发", () => {
  const userId = "user' OR true --";
  const query = new PgDialect().sqlToQuery(buildAnalyticsQuery({ workspaceId: "workspace", userId, notebookId: "selected", days: 7, now: new Date("2026-03-01Z") }));
  assert.ok(!query.sql.includes(userId));
  assert.ok(query.params.includes(userId));
  assert.match(query.sql, /join workspace_members m on m.workspace_id = w.id/);
  assert.match(query.sql, /b.visibility = 'restricted' and exists/);
  assert.match(query.sql, /join visible_notes b on b.id = l.target_note_id/);
  assert.match(query.sql, /join scope_notes n on n.id = t.source_note_id/);
  assert.match(query.sql, /join scope_notes n on n.id = a.note_id/);
  assert.ok(!query.sql.includes("role = 'admin'"));
  assert.ok(!query.sql.includes("v.body_md"));
});
