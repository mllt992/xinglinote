import assert from "node:assert/strict";
import { test } from "node:test";
import { autoSaveDecision, SAVED_SHARE_CAP } from "./saved-shares.ts";

test("自动收下：无行且不能靠 ACL 读 → 插入", () => {
  assert.equal(autoSaveDecision({ existing: null, canReadViaAcl: false, activeCount: 0 }), "insert");
});

test("自动收下：已是 active → 只更新打开时间", () => {
  assert.equal(autoSaveDecision({ existing: { status: "active" }, canReadViaAcl: false, activeCount: 1 }), "touch");
});

test("自动收下：dismissed 不救活", () => {
  assert.equal(autoSaveDecision({ existing: { status: "dismissed" }, canReadViaAcl: false, activeCount: 0 }), "skip");
});

test("自动收下：ACL 已能读则不插入", () => {
  assert.equal(autoSaveDecision({ existing: null, canReadViaAcl: true, activeCount: 0 }), "skip");
});

test("自动收下：ACL 已能读但不影响已有 active 的 touch", () => {
  assert.equal(autoSaveDecision({ existing: { status: "active" }, canReadViaAcl: true, activeCount: 3 }), "touch");
});

test("自动收下：满员不再插入", () => {
  assert.equal(autoSaveDecision({ existing: null, canReadViaAcl: false, activeCount: SAVED_SHARE_CAP }), "skip");
});
