import { and,eq } from "drizzle-orm";
import type { WsRole } from "@kb/core";
import { db } from "../db/client.ts";
import { attachments,folders,notebooks,notes,shareLinks,workspaceMembers,workspaces } from "../db/schema.ts";

export async function createPersonalWorkspace(userId: string, displayName: string) {
  const slug = `u-${userId.replace(/-/g, "").slice(0, 12)}`;
  const [ws] = await db
    .insert(workspaces)
    .values({
      slug,
      name: `${displayName}的库`,
      kind: "personal",
      ownerId: userId,
      personalUserId: userId,
    })
    .returning();
  await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId, role: "owner" });
  await db.insert(notebooks).values({
    workspaceId: ws.id,
    slug: "notes",
    title: "笔记",
    visibility: "open",
    defaultAiIndex: true,
    createdBy: userId,
  });
  return ws;
}

export async function migratePrivateNotebooks(userId:string,fromWorkspaceId:string){const[personal]=await db.select().from(workspaces).where(eq(workspaces.personalUserId,userId));if(!personal)return[];const owned=(await db.select().from(notebooks).where(eq(notebooks.workspaceId,fromWorkspaceId))).filter(n=>n.visibility==="private"&&n.createdBy===userId);for(const nb of owned){const movedNotes=await db.select({id:notes.id}).from(notes).where(eq(notes.notebookId,nb.id));await db.transaction(async tx=>{await tx.update(notebooks).set({workspaceId:personal.id,slug:`migrated-${nb.id.slice(0,8)}`,title:`从工作区迁回 · ${nb.title}`}).where(eq(notebooks.id,nb.id));await tx.update(folders).set({workspaceId:personal.id}).where(eq(folders.notebookId,nb.id));await tx.update(notes).set({workspaceId:personal.id}).where(eq(notes.notebookId,nb.id));for(const n of movedNotes){await tx.update(attachments).set({workspaceId:personal.id}).where(eq(attachments.noteId,n.id));await tx.update(shareLinks).set({workspaceId:personal.id}).where(and(eq(shareLinks.targetType,"note"),eq(shareLinks.targetId,n.id)));}});}return owned.map(n=>n.id);}

export async function memberRole(workspaceId: string, userId: string): Promise<WsRole | null> {
  const rows = await db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  const m = rows.find((r) => r.userId === userId);
  return (m?.role as WsRole) ?? null;
}
