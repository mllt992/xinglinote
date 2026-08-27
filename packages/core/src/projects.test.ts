import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canArchiveProject,
  canReadProject,
  canWriteProject,
  healthBand,
  scoreProjectHealth,
  type HealthTask,
} from "./projects.ts";

const now = new Date("2026-09-01T00:00:00.000Z");
const task = (partial: Partial<HealthTask> = {}): HealthTask => ({
  status: "todo",
  dueAt: null,
  updatedAt: now,
  estimateMin: null,
  actualSeconds: 0,
  ...partial,
});

test("私有项目只有创建者能读，对别人当不存在", () => {
  const priv = { visibility: "private" as const, createdBy: "u1", userId: "u2", wsRole: "admin" as const };
  assert.equal(canReadProject(priv), false);
  assert.equal(canReadProject({ ...priv, userId: "u1" }), true);
  assert.equal(canReadProject({ ...priv, visibility: "workspace" }), true);
  assert.equal(canReadProject({ ...priv, wsRole: null }), false);
});

test("Viewer 与冻结、已归档都不能写", () => {
  const base = { visibility: "workspace" as const, createdBy: "u1", userId: "u2", wsRole: "editor" as const, frozen: false, status: "active" as const };
  assert.equal(canWriteProject(base), true);
  assert.equal(canWriteProject({ ...base, wsRole: "viewer" }), false);
  assert.equal(canWriteProject({ ...base, frozen: true }), false);
  assert.equal(canWriteProject({ ...base, status: "archived" }), false);
});

test("归档权：创建者或 Admin / Owner", () => {
  assert.equal(canArchiveProject({ userId: "u1", createdBy: "u1", wsRole: "editor" }), true);
  assert.equal(canArchiveProject({ userId: "u2", createdBy: "u1", wsRole: "admin" }), true);
  assert.equal(canArchiveProject({ userId: "u2", createdBy: "u1", wsRole: "owner" }), true);
  assert.equal(canArchiveProject({ userId: "u2", createdBy: "u1", wsRole: "editor" }), false);
  assert.equal(canArchiveProject({ userId: "u2", createdBy: "u1", wsRole: null }), false);
});

test("健康度：满分、按条扣逾期和停滞、夹在 0–100", () => {
  assert.deepEqual(scoreProjectHealth({ dueAt: null }, [], now), {
    score: 100, band: "steady", overdue: 0, stale: 0, nearDue: false, overrun: false, completion: 1,
  });
  const overdue = scoreProjectHealth({ dueAt: null }, [task({ dueAt: "2026-08-01T00:00:00.000Z" })], now);
  assert.equal(overdue.overdue, 1);
  assert.equal(overdue.score, 88);
  const two = scoreProjectHealth({ dueAt: null }, [
    task({ dueAt: "2026-08-01T00:00:00.000Z" }),
    task({ status: "doing", updatedAt: "2026-08-20T00:00:00.000Z" }),
  ], now);
  assert.equal(two.score, 80);
  assert.equal(two.stale, 1);
  const floor = scoreProjectHealth({ dueAt: null }, Array.from({ length: 20 }, () => task({ dueAt: "2026-01-01T00:00:00.000Z" })), now);
  assert.equal(floor.score, 0);
  assert.equal(healthBand(75), "steady");
  assert.equal(healthBand(45), "tight");
  assert.equal(healthBand(44), "risk");
});

test("临期完成率不够扣 20；已完成或已过截止不走这条", () => {
  const near = scoreProjectHealth(
    { dueAt: "2026-09-03T00:00:00.000Z" },
    [task(), task(), task({ status: "done" })],
    now,
  );
  assert.equal(near.nearDue, true);
  assert.equal(near.completion < 0.5, true);
  assert.equal(near.score, 80);
  const ok = scoreProjectHealth(
    { dueAt: "2026-09-03T00:00:00.000Z" },
    [task({ status: "done" }), task({ status: "done" })],
    now,
  );
  assert.equal(ok.nearDue, false);
  const past = scoreProjectHealth({ dueAt: "2026-08-31T00:00:00.000Z" }, [task()], now);
  assert.equal(past.nearDue, false);
});

test("有估时且实耗打穿 1.3 倍才扣 10；取消的不算完成率分母", () => {
  const overrun = scoreProjectHealth({ dueAt: null }, [task({ estimateMin: 60, actualSeconds: 60 * 60 * 1.31 })], now);
  assert.equal(overrun.overrun, true);
  assert.equal(overrun.score, 90);
  const under = scoreProjectHealth({ dueAt: null }, [task({ estimateMin: 60, actualSeconds: 60 * 60 })], now);
  assert.equal(under.overrun, false);
  const noEstimate = scoreProjectHealth({ dueAt: null }, [task({ actualSeconds: 99999 })], now);
  assert.equal(noEstimate.overrun, false);
  const rate = scoreProjectHealth({ dueAt: null }, [task({ status: "done" }), task({ status: "cancelled" })], now);
  assert.equal(rate.completion, 1);
});
