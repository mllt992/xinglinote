import assert from "node:assert/strict";
import { test } from "node:test";
import { canAiReadNote, canCreateShare, canEditNote, canReadNote } from "./acl.ts";

const actor = { kind: "user" as const, userId: "u1" };
const other = { kind: "user" as const, userId: "u2" };
const note = { id: "n", workspaceId: "w", notebookId: "b", trashed: false };
const openNb = {
  id: "b",
  workspaceId: "w",
  visibility: "open" as const,
  createdBy: "u1",
  frozenWorkspace: false,
};

test("guest cannot read", () => {
  assert.equal(
    canReadNote({ actor: { kind: "guest" }, note, notebook: openNb, wsRole: "editor", nbMemberRole: null, canSeeTrash: false }),
    false,
  );
});

test("non-member cannot read", () => {
  assert.equal(
    canReadNote({ actor, note, notebook: openNb, wsRole: null, nbMemberRole: null, canSeeTrash: false }),
    false,
  );
});

test("viewer reads open, cannot edit", () => {
  const args = { actor: other, note, notebook: openNb, wsRole: "viewer" as const, nbMemberRole: null, canSeeTrash: false };
  assert.equal(canReadNote(args), true);
  assert.equal(canEditNote(args), false);
});

test("editor edits open", () => {
  assert.equal(
    canEditNote({ actor: other, note, notebook: openNb, wsRole: "editor", nbMemberRole: null, canSeeTrash: false }),
    true,
  );
});

test("admin cannot read private notebook", () => {
  const priv = { ...openNb, visibility: "private" as const, createdBy: "u1" };
  assert.equal(
    canReadNote({ actor: other, note, notebook: priv, wsRole: "admin", nbMemberRole: null, canSeeTrash: false }),
    false,
  );
  assert.equal(
    canReadNote({ actor, note, notebook: priv, wsRole: "owner", nbMemberRole: null, canSeeTrash: false }),
    true,
  );
});

test("restricted needs whitelist to edit", () => {
  const rest = { ...openNb, visibility: "restricted" as const, createdBy: "u1" };
  assert.equal(
    canEditNote({ actor: other, note, notebook: rest, wsRole: "editor", nbMemberRole: "view", canSeeTrash: false }),
    false,
  );
  assert.equal(
    canEditNote({ actor: other, note, notebook: rest, wsRole: "editor", nbMemberRole: "edit", canSeeTrash: false }),
    true,
  );
});

test("frozen workspace is read-only", () => {
  const frozen = { ...openNb, frozenWorkspace: true };
  assert.equal(
    canEditNote({ actor, note, notebook: frozen, wsRole: "owner", nbMemberRole: null, canSeeTrash: false }),
    false,
  );
  // 新建笔记 / 目录 / 分享走的是这一条，冻结时同样必须挡住
  assert.equal(canCreateShare({ actor, notebook: frozen, wsRole: "owner", nbMemberRole: null }), false);
  assert.equal(canCreateShare({ actor, notebook: openNb, wsRole: "owner", nbMemberRole: null }), true);
});

test("ai_index off blocks AI even if readable", () => {
  const args = { actor, note, notebook: openNb, wsRole: "editor" as const, nbMemberRole: null, canSeeTrash: false, aiIndex: false, aiEnabled: true };
  assert.equal(canAiReadNote(args), false);
  assert.equal(canAiReadNote({ ...args, aiIndex: true }), true);
});
