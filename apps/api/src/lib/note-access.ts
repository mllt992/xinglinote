import { and, eq } from "drizzle-orm";
import { canEditNote, canReadNote, type WsRole } from "@kb/core";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { notebookMembers, notebooks, notes, users, workspaces } from "../db/schema.ts";
import { memberRole } from "./workspace.ts";

export async function noteAccess(noteId:string,userId:string,mode:"read"|"edit"="read",includeTrashed=false){
  const [note]=await db.select().from(notes).where(eq(notes.id,noteId));
  if(!note||(!includeTrashed&&note.trashedAt))throw fail("NOT_FOUND","笔记不存在");
  const [notebook]=await db.select().from(notebooks).where(eq(notebooks.id,note.notebookId));
  const [workspace]=await db.select().from(workspaces).where(eq(workspaces.id,note.workspaceId));
  if(!notebook||!workspace||notebook.trashedAt)throw fail("NOT_FOUND","笔记不存在");
  const role=await memberRole(note.workspaceId,userId);
  const [nbMember]=await db.select().from(notebookMembers).where(and(eq(notebookMembers.notebookId,notebook.id),eq(notebookMembers.userId,userId)));
  const context={actor:{kind:"user" as const,userId},note:{id:note.id,workspaceId:note.workspaceId,notebookId:note.notebookId,trashed:!!note.trashedAt},notebook:{id:notebook.id,workspaceId:notebook.workspaceId,visibility:notebook.visibility as "open"|"restricted"|"private",createdBy:notebook.createdBy,frozenWorkspace:workspace.frozen},wsRole:role as WsRole|null,nbMemberRole:(nbMember?.role as "edit"|"view"|undefined)??null,canSeeTrash:includeTrashed};
  const [user]=await db.select({status:users.status}).from(users).where(eq(users.id,userId));
  const allowed=mode==="edit"?!(user?.status==="pending_deletion"&&workspace.kind==="personal")&&canEditNote(context):canReadNote(context);
  if(!allowed)throw fail("NOT_FOUND","笔记不存在");
  return{note,notebook,workspace,role};
}
