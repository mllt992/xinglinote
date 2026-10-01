import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskHealth, publicUrlHealth, secretHealth, workerHealth } from "./instance-health-state.ts";
import { readWorkerHeartbeat, writeWorkerHeartbeat } from "./worker-heartbeat.ts";
test("健康检查不会把危险默认或陈旧/未来心跳标绿", () => {
  assert.equal(publicUrlHealth("https://notes.example.com").status, "ok");
  for (const url of ["bad", "https://user:pass@example.com", "https://example.com/path", "https://example.com?token=x"]) assert.equal(publicUrlHealth(url).status, "error");
  assert.equal(publicUrlHealth("http://localhost:12099").status, "warning");
  assert.equal(secretHealth("dev-only-change-me").status, "error"); assert.equal(secretHealth("a".repeat(48)).status, "ok");
  assert.equal(workerHealth(100000, 120000).status, "ok"); assert.equal(workerHealth(10000, 120000).status, "error"); assert.equal(workerHealth(160000, 120000).status, "error"); assert.equal(workerHealth(null).status, "error");
  assert.equal(diskHealth(100e9, 1e9).status, "warning"); assert.equal(diskHealth(100e9, 50e9).status, "ok");
});
test("worker 心跳跨进程目录记录且无凭据", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xingli-heartbeat-"));
  try { assert.equal(await readWorkerHeartbeat(dir), null); await writeWorkerHeartbeat(dir, 123456); assert.equal(await readWorkerHeartbeat(dir), 123456); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
test("一个成功目标不能掩盖另一个未测试/失败目标，陈旧成功不是当前绿灯", async () => {
  const { backupHealth } = await import("./instance-health-state.ts"); const now = Date.now();
  assert.equal(backupHealth([]).status, "error");
  const good = { name: "已验证", run: { status: "success", at: now } };
  assert.equal(backupHealth([good], now).status, "ok");
  assert.equal(backupHealth([good, { name: "未验证" }], now).status, "warning");
  assert.equal(backupHealth([{ name: "旧记录", run: { status: "success", at: now - 8 * 86400000 } }], now).status, "warning");
  assert.equal(backupHealth([good, { name: "失败", test: { status: "failed", at: now } }], now).status, "error");
});
