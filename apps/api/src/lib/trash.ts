import { rm } from "node:fs/promises";
import { join } from "node:path";
import { and,eq,inArray,isNull,or } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  aiChunks,attachments,calendarItems,calendarReminders,comments,corrections,folders,links,
  noteFavorites,notebooks,notes,noteVersions,noteVisits,posts,projectMilestones,projectTasks,projectTimeEntries,projects,
} from "../db/schema.ts";
import { projectColumns } from "../db/project-columns.ts";
import { env } from "../env.ts";
import { releaseStoredFile } from "./blobs.ts";
export async function descendantFolderIds(rootId:string){const all=await db.select({id:folders.id,parentId:folders.parentId}).from(folders);const ids=[rootId];for(let i=0;i<ids.length;i++)for(const f of all)if(f.parentId===ids[i]&&!ids.includes(f.id))ids.push(f.id);return ids;}
export async function trashNotebook(notebookId:string,userId:string){const at=new Date(),batch=crypto.randomUUID();await db.transaction(async tx=>{await tx.update(notebooks).set({trashedAt:at,trashedBy:userId,trashBatchId:batch}).where(eq(notebooks.id,notebookId));await tx.update(folders).set({trashedAt:at,trashedBy:userId,trashBatchId:batch}).where(and(eq(folders.notebookId,notebookId),isNull(folders.trashedAt)));await tx.update(notes).set({trashedAt:at,trashedBy:userId,trashBatchId:batch}).where(and(eq(notes.notebookId,notebookId),isNull(notes.trashedAt)));});return batch;}
export async function trashFolder(folderId:string,userId:string){const ids=await descendantFolderIds(folderId),at=new Date(),batch=crypto.randomUUID();await db.transaction(async tx=>{await tx.update(folders).set({trashedAt:at,trashedBy:userId,trashBatchId:batch}).where(and(inArray(folders.id,ids),isNull(folders.trashedAt)));await tx.update(notes).set({trashedAt:at,trashedBy:userId,trashBatchId:batch}).where(and(inArray(notes.folderId,ids),isNull(notes.trashedAt)));});return batch;}
export async function restoreNotebook(id:string,batch:string){await db.transaction(async tx=>{await tx.update(notebooks).set({trashedAt:null,trashedBy:null,trashBatchId:null}).where(and(eq(notebooks.id,id),eq(notebooks.trashBatchId,batch)));await tx.update(folders).set({trashedAt:null,trashedBy:null,trashBatchId:null}).where(eq(folders.trashBatchId,batch));await tx.update(notes).set({trashedAt:null,trashedBy:null,trashBatchId:null}).where(eq(notes.trashBatchId,batch));});}
export async function restoreFolder(id:string,batch:string){await db.transaction(async tx=>{await tx.update(folders).set({trashedAt:null,trashedBy:null,trashBatchId:null}).where(eq(folders.trashBatchId,batch));await tx.update(notes).set({trashedAt:null,trashedBy:null,trashBatchId:null}).where(eq(notes.trashBatchId,batch));});}

// —— 立即销毁与恢复时的重名处理（规格 12 的 4.4 与 5.2）——

/**
 * 物理销毁若干笔记：文件、附件行、双链、版本、评论纠错、向量块、收藏、访问记录、
 * 以及挂在这篇笔记上的日历条目，一并清掉。
 *
 * **销毁笔记只有这一个入口。** 以前 worker 的 purge_trash 和 delete_workspace
 * 各自抄了一份，而且已经抄漏了：那两份都不删 ai_chunks，30 天自动清盘之后
 * 留下一堆孤儿向量块。
 */
export async function purgeNotes(ids:string[]){
  for(const id of ids){
    const files=await db.select().from(attachments).where(eq(attachments.noteId,id));
    for(const a of files)await releaseStoredFile(a);
    const [note]=await db.select().from(notes).where(eq(notes.id,id));
    if(note)await rm(join(env.dataDir,"workspaces",note.workspaceId,"notes",note.notebookId,`${note.id}.md`),{force:true});
    const doomedItems=await db.select({id:calendarItems.id}).from(calendarItems).where(eq(calendarItems.sourceNoteId,id));
    await db.transaction(async tx=>{
      await tx.delete(attachments).where(eq(attachments.noteId,id));
      await tx.delete(links).where(or(eq(links.fromNoteId,id),eq(links.targetNoteId,id)));
      await tx.delete(noteVersions).where(eq(noteVersions.noteId,id));
      await tx.delete(comments).where(eq(comments.targetId,id));
      await tx.delete(corrections).where(eq(corrections.noteId,id));
      await tx.delete(aiChunks).where(eq(aiChunks.noteId,id));
      await tx.delete(noteFavorites).where(eq(noteFavorites.noteId,id));
      await tx.delete(noteVisits).where(eq(noteVisits.noteId,id));
      if(doomedItems.length){
        await tx.delete(calendarReminders).where(inArray(calendarReminders.itemId,doomedItems.map(x=>x.id)));
        await tx.delete(calendarItems).where(eq(calendarItems.sourceNoteId,id));
      }
      await tx.update(posts).set({noteId:null}).where(eq(posts.noteId,id));
      await tx.update(projectTasks).set({sourceNoteId:null}).where(eq(projectTasks.sourceNoteId,id));
      await tx.delete(notes).where(eq(notes.id,id));
    });
  }
}
export async function purgeFolder(folderId:string){
  const ids=await descendantFolderIds(folderId);
  const doomed=await db.select({id:notes.id}).from(notes).where(inArray(notes.folderId,ids));
  await purgeNotes(doomed.map(n=>n.id));
  await db.delete(folders).where(inArray(folders.id,ids));
}
/** 工作区销毁 / 替换恢复前先卸项目，否则外键会卡住 workspaces 那一行。 */
export async function purgeWorkspaceProjects(workspaceId:string, tx: Pick<typeof db,"select"|"delete"> = db){
  const rows=await tx.select({id:projects.id}).from(projects).where(eq(projects.workspaceId,workspaceId));
  if(!rows.length)return;
  const ids=rows.map(r=>r.id);
  await tx.delete(projectTimeEntries).where(inArray(projectTimeEntries.projectId,ids));
  await tx.delete(projectMilestones).where(inArray(projectMilestones.projectId,ids));
  await tx.delete(projectColumns).where(inArray(projectColumns.projectId,ids));
  await tx.delete(projectTasks).where(eq(projectTasks.workspaceId,workspaceId));
  await tx.delete(projects).where(eq(projects.workspaceId,workspaceId));
}

export async function purgeNotebook(notebookId:string){
  const doomed=await db.select({id:notes.id}).from(notes).where(eq(notes.notebookId,notebookId));
  await purgeNotes(doomed.map(n=>n.id));
  await db.delete(folders).where(eq(folders.notebookId,notebookId));
  await db.delete(notebooks).where(eq(notebooks.id,notebookId));
}
const norm=(s:string)=>s.normalize("NFKC").trim().replace(/\s+/g," ").toLowerCase();
/** 恢复时原位被同名占了就加后缀，不覆盖活着的内容。 */
export async function restoreTitle(note:typeof notes.$inferSelect){
  const siblings=await db.select().from(notes).where(and(eq(notes.notebookId,note.notebookId),isNull(notes.trashedAt)));
  const taken=new Set(siblings.filter(n=>n.id!==note.id&&(n.folderId??null)===(note.folderId??null)).map(n=>norm(n.title)));
  if(!taken.has(norm(note.title)))return note.title;
  for(let i=0;;i++){const candidate=i?`${note.title}（恢复 ${i+1}）`:`${note.title}（恢复）`;if(!taken.has(norm(candidate)))return candidate;}
}
/** 原目录也在回收站里没被一起恢复时，落回笔记本根目录。 */
export async function restoreFolderId(note:typeof notes.$inferSelect){
  if(!note.folderId)return null;
  const [parent]=await db.select().from(folders).where(eq(folders.id,note.folderId));
  return parent&&!parent.trashedAt?note.folderId:null;
}
