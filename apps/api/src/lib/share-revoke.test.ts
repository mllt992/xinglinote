import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "@kb/shared";
import { canManageShare, requireRevokedShare } from "./share-revoke.ts";

test("只有创建者和管理员能撤销分享", () => {
  assert.equal(canManageShare("editor", "author", "author"), true);
  assert.equal(canManageShare("editor", "other", "author"), false);
  assert.equal(canManageShare("viewer", "author", "author"), true);
  assert.equal(canManageShare("admin", "other", "author"), true);
  assert.equal(canManageShare("owner", "other", "author"), true);
  assert.equal(canManageShare(null, "author", "author"), false);
});

test("只有数据库实际返回更新行才算撤销成功", async () => {
  const row = { id: "share-1", status: "revoked" };
  assert.equal(await requireRevokedShare(async () => row), row);
  await assert.rejects(
    requireRevokedShare(async () => undefined),
    (e: unknown) => e instanceof AppError && e.code === "NOT_FOUND",
  );
});

test("数据库锁超时返回可重试冲突", async () => {
  await assert.rejects(
    requireRevokedShare(async () => { throw Object.assign(new Error("lock timeout"), { code: "55P03" }); }),
    (e: unknown) => e instanceof AppError && e.code === "CONFLICT_VERSION",
  );
});
