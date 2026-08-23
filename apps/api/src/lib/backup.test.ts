import assert from "node:assert/strict";
import test from "node:test";
import { backupDue, checksum, decryptPackage, encryptPackage, fingerprint } from "./backup.ts";

test("加密包带头，口令对才能解开", () => {
  const raw = Buffer.from(JSON.stringify({ format: "knowledge-workspace-backup", notes: [1] }));
  const enc = encryptPackage(raw, "passphrase-ok");
  assert.equal(enc.subarray(0, 6).toString(), "KBENC1");
  assert.notEqual(enc.equals(raw), true);
  assert.deepEqual(JSON.parse(decryptPackage(enc, "passphrase-ok").toString()), JSON.parse(raw.toString()));
  assert.throws(() => decryptPackage(enc, "wrong-pass"));
});

test("未加密的包原样返回", () => {
  const raw = Buffer.from("plain-json");
  assert.equal(decryptPackage(raw, "x").toString(), "plain-json");
});

test("手动不调度；没跑过的每天/每周立刻到期", () => {
  const now = new Date("2026-04-08T08:00:00Z");
  assert.equal(backupDue({ schedule: "manual", lastRunAt: null }, now), false);
  assert.equal(backupDue({ schedule: "daily", lastRunAt: null }, now), true);
  assert.equal(backupDue({ schedule: "weekly", lastRunAt: null }, now), true);
});

test("每天/每周按上次成功间隔到期，进行中或刚失败的不连打", () => {
  const now = new Date("2026-04-08T08:00:00Z");
  assert.equal(backupDue({ schedule: "daily", lastRunAt: new Date("2026-04-07T09:00:00Z") }, now), false);
  assert.equal(backupDue({ schedule: "daily", lastRunAt: new Date("2026-04-07T07:00:00Z") }, now), true);
  assert.equal(backupDue({ schedule: "weekly", lastRunAt: new Date("2026-04-02T08:00:00Z") }, now), false);
  assert.equal(backupDue({
    schedule: "daily",
    lastRunAt: new Date("2026-04-01T00:00:00Z"),
    latest: { status: "running", finishedAt: null },
  }, now), false);
  assert.equal(backupDue({
    schedule: "daily",
    lastRunAt: new Date("2026-04-01T00:00:00Z"),
    latest: { status: "failed", finishedAt: new Date("2026-04-08T07:40:00Z") },
  }, now), false);
  assert.equal(backupDue({
    schedule: "daily",
    lastRunAt: new Date("2026-04-01T00:00:00Z"),
    latest: { status: "failed", finishedAt: new Date("2026-04-08T07:00:00Z") },
  }, now), true);
});

test("校验和与指纹是稳定的 hex", () => {
  assert.match(checksum(Buffer.from("abc")), /^[a-f0-9]{64}$/);
  assert.equal(fingerprint("same"), fingerprint("same"));
  assert.notEqual(fingerprint("same"), fingerprint("other"));
});
