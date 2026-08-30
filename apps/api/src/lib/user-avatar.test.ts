import assert from "node:assert/strict";
import test from "node:test";
import { userAvatarUrl } from "./user-avatar.ts";

test("没有头像时不生成地址", () => {
  assert.equal(userAvatarUrl({ id: "user-1", avatarSha256: null }), null);
});

test("头像地址带内容版本，替换后不会命中旧缓存", () => {
  const a = userAvatarUrl({ id: "user-1", avatarSha256: "a".repeat(64) });
  const b = userAvatarUrl({ id: "user-1", avatarSha256: "b".repeat(64) });
  assert.equal(a, "/api/v1/users/user-1/avatar?v=aaaaaaaaaaaa");
  assert.notEqual(a, b);
});
