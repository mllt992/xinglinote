export type WsRole = "owner" | "admin" | "editor" | "viewer";
export type NbVisibility = "open" | "private" | "restricted";
export type NbMemberRole = "edit" | "view";

export type Actor =
  | { kind: "user"; userId: string }
  | { kind: "mcp"; userId: string; tokenId: string; workspaceId: string; workspaceIds?: string[] }
  | { kind: "guest" };

export type NotebookAcl = {
  id: string;
  workspaceId: string;
  visibility: NbVisibility;
  createdBy: string;
  frozenWorkspace: boolean;
};

export type NoteAcl = {
  id: string;
  workspaceId: string;
  notebookId: string;
  trashed: boolean;
};

export function actorUserId(actor: Actor): string | null {
  return actor.kind === "guest" ? null : actor.userId;
}

export function canReadNote(input: {
  actor: Actor;
  note: NoteAcl;
  notebook: NotebookAcl;
  wsRole: WsRole | null;
  nbMemberRole: NbMemberRole | null;
  canSeeTrash: boolean;
}): boolean {
  const { actor, note, notebook, wsRole, nbMemberRole, canSeeTrash } = input;
  if (actor.kind === "guest") return false;
  // 工作区成员资格与笔记本可见性先过，再看回收站开关——
  // 反过来写的话 canSeeTrash=true 会让非成员也能读到已删除的笔记。
  if (!wsRole) return false;
  if (note.trashed && !canSeeTrash) return false;
  if (notebook.visibility === "private") return actor.userId === notebook.createdBy;
  if (notebook.visibility === "restricted") {
    return actor.userId === notebook.createdBy || nbMemberRole !== null;
  }
  return true;
}

export function canEditNote(input: {
  actor: Actor;
  note: NoteAcl;
  notebook: NotebookAcl;
  wsRole: WsRole | null;
  nbMemberRole: NbMemberRole | null;
  canSeeTrash: boolean;
}): boolean {
  if (!canReadNote(input)) return false;
  if (input.notebook.frozenWorkspace) return false;
  if (input.wsRole === "viewer" || !input.wsRole) return false;
  if (input.note.trashed) return false;
  if (input.notebook.visibility === "private") return input.actor.kind !== "guest" && input.actor.userId === input.notebook.createdBy;
  if (input.notebook.visibility === "restricted") {
    return input.actor.kind !== "guest" && (input.actor.userId === input.notebook.createdBy || input.nbMemberRole === "edit");
  }
  return input.wsRole === "owner" || input.wsRole === "admin" || input.wsRole === "editor";
}

export function canCreateShare(input: {
  actor: Actor;
  notebook: NotebookAcl;
  wsRole: WsRole | null;
  nbMemberRole: NbMemberRole | null;
}): boolean {
  if (input.actor.kind === "guest" || !input.wsRole || input.wsRole === "viewer") return false;
  if (input.notebook.frozenWorkspace) return false;
  if (input.notebook.visibility === "private") return input.actor.userId === input.notebook.createdBy;
  if (input.notebook.visibility === "restricted") {
    return input.actor.userId === input.notebook.createdBy || input.nbMemberRole === "edit";
  }
  return input.wsRole === "owner" || input.wsRole === "admin" || input.wsRole === "editor";
}

export function canPublishNotebook(wsRole: WsRole | null): boolean {
  return wsRole === "owner" || wsRole === "admin";
}

/** 对本有编辑权、但不是当场发布的人：只能提交申请。 */
export function canRequestSitePublish(input: Parameters<typeof canCreateShare>[0]): boolean {
  return canCreateShare(input) && !canPublishNotebook(input.wsRole);
}

export function canAiReadNote(input: Parameters<typeof canReadNote>[0] & { aiIndex: boolean; aiEnabled: boolean }): boolean {
  return input.aiEnabled && input.aiIndex && canReadNote(input) && !input.note.trashed;
}
