import assert from "node:assert/strict";
import test from "node:test";
import { assertConfirmedRevokedShare, removeConfirmedRevokedShare } from "./share-dialog-state.ts";

test("撤销成功后从分享弹窗移除对应链接", () => {
  const rows = [
    { id: "share-1", status: "active" },
    { id: "share-2", status: "active" },
  ];

  assert.deepEqual(
    removeConfirmedRevokedShare(rows, { id: "share-1", status: "revoked" }),
    [{ id: "share-2", status: "active" }],
  );
});

test("接口没有确认 revoked 时不产生删除假象", () => {
  const rows = [{ id: "share-1", status: "active" }];
  assert.throws(
    () => removeConfirmedRevokedShare(rows, { id: "share-1", status: "active" }),
    /未确认链接已经失效/,
  );
  assert.equal(rows.length, 1);
});

test("可在提交 React 状态更新前单独校验接口结果", () => {
  assert.doesNotThrow(() => assertConfirmedRevokedShare({ status: "revoked" }));
  assert.throws(() => assertConfirmedRevokedShare({ status: "active" }), /未确认链接已经失效/);
});
