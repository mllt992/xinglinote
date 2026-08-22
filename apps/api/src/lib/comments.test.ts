import assert from "node:assert/strict";
import { test } from "node:test";
import { commentListedTo, feedPostHref } from "./comments.ts";

test("公开评论谁都能看见", () => {
  const row = { status: "visible", authorUserId: "u1" };
  assert.equal(commentListedTo(row), true);
  assert.equal(commentListedTo(row, "u2"), true);
  assert.equal(commentListedTo(row, "u1", true), true);
});

test("待审只有版主看见", () => {
  const row = { status: "pending", authorUserId: null };
  assert.equal(commentListedTo(row), false);
  assert.equal(commentListedTo(row, "u1"), false);
  assert.equal(commentListedTo(row, "u1", true), true);
});

test("隐藏后作者和版主仍能看见，别人不能", () => {
  const row = { status: "hidden", authorUserId: "u1" };
  assert.equal(commentListedTo(row), false);
  assert.equal(commentListedTo(row, "u2"), false);
  assert.equal(commentListedTo(row, "u1"), true);
  assert.equal(commentListedTo(row, "u2", true), true);
});

test("已拒绝的不进楼", () => {
  assert.equal(commentListedTo({ status: "rejected", authorUserId: "u1" }, "u1", true), false);
});

test("通知深链带上帖 id", () => {
  assert.equal(feedPostHref({ id: "p1", workspaceId: null }), "/?post=p1");
  assert.equal(feedPostHref({ id: "p1", workspaceId: "w1" }), "/w/w1/feed?post=p1");
});
