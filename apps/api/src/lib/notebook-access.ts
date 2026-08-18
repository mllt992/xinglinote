import { and,eq } from "drizzle-orm";
import { canCreateShare,canReadNote,type WsRole } from "@kb/core";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { notebookMembers,notebooks,users,workspaces } from "../db/schema.ts";
import { memberRole } from "./workspace.ts";
export async function notebookAccess(notebookId:string,userId:string,mode:"read"|"edit"="read"){
 const[notebook]=await db.select().from(notebooks).where(eq(notebooks.id,notebookId));if(!notebook||notebook.trashedAt)throw fail("NOT_FOUND","笔记本不存在");const[workspace]=await db.select().from(workspaces).where(eq(workspaces.id,notebook.workspaceId));if(!workspace)throw fail("NOT_FOUND","工作区不存在");const role=await memberRole(workspace.id,userId);const[m]=await db.select().from(notebookMembers).where(and(eq(notebookMembers.notebookId,notebook.id),eq(notebookMembers.userId,userId)));const acl={actor:{kind:"user" as const,userId},notebook:{id:notebook.id,workspaceId:workspace.id,visibility:notebook.visibility as "open"|"private"|"restricted",createdBy:notebook.createdBy,frozenWorkspace:workspace.frozen},wsRole:role as WsRole|null,nbMemberRole:(m?.role as "edit"|"view"|undefined)??null};const[user]=await db.select({status:users.status}).from(users).where(eq(users.id,userId));const allowed=mode==="edit"?!(user?.status==="pending_deletion"&&workspace.kind==="personal")&&canCreateShare(acl):canReadNote({...acl,note:{id:"probe",workspaceId:workspace.id,notebookId:notebook.id,trashed:false},canSeeTrash:false});if(!allowed)throw fail("NOT_FOUND","笔记本不存在");return{notebook,workspace,role,notebookRole:acl.nbMemberRole};
}
