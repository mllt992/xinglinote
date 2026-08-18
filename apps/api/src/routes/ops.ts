import { mkdir,readFile,writeFile } from "node:fs/promises";import { join } from "node:path";import { Hono } from "hono";import { and,desc,eq,inArray,isNull } from "drizzle-orm";import { z } from "zod";import { fail } from "@kb/shared";import { db } from "../db/client.ts";import { auditLogs,folders,notebooks,notes,workspaceMembers,workspaces } from "../db/schema.ts";import { env } from "../env.ts";import { ok } from "../http.ts";import { currentUser } from "../lib/session.ts";import { memberRole } from "../lib/workspace.ts";import { writeNoteFile } from "../lib/files.ts";import { rebuildLinks } from "../lib/links.ts";import { assertUserStorage,textBytes } from "../lib/quota.ts";
export const opsRoutes=new Hono();async function owner(c:any,wsId:string){const u=await currentUser(c);if(!u)throw fail("UNAUTHENTICATED","未登录");const r=await memberRole(wsId,u.id);if(r!=="owner"&&r!=="admin")throw fail("FORBIDDEN","只有管理员可操作");return u;}
opsRoutes.get("/workspaces/:id/export",async c=>{const id=c.req.param("id");await owner(c,id);const [ws]=await db.select().from(workspaces).where(eq(workspaces.id,id));if(!ws)throw fail("NOT_FOUND","工作区不存在");const nbs=await db.select().from(notebooks).where(eq(notebooks.workspaceId,id));const fs=await db.select().from(folders).where(eq(folders.workspaceId,id));const ns=await db.select().from(notes).where(eq(notes.workspaceId,id));c.header("Content-Disposition",`attachment; filename="${ws.slug}-backup.json"`);return c.json({format:"knowledge-backup",version:1,exportedAt:new Date(),workspace:{id:ws.id,slug:ws.slug,name:ws.name},notebooks:nbs,folders:fs,notes:ns});});
opsRoutes.post("/workspaces/:id/restore",async c=>{const wsId=c.req.param("id");const u=await owner(c,wsId);const b=z.object({format:z.literal("knowledge-backup"),version:z.literal(1),notebooks:z.array(z.any()),folders:z.array(z.any()),notes:z.array(z.any())}).parse(await c.req.json());const required=b.notes.reduce((sum:any,n:any)=>sum+textBytes(n.title??"未命名",n.bodyMd??""),0);await assertUserStorage(u.id,required);let count=0;for(const old of b.notebooks){let [nb]=await db.select().from(notebooks).where(eq(notebooks.id,old.id));if(!nb){[nb]=await db.insert(notebooks).values({id:old.id,workspaceId:wsId,slug:`restored-${old.id.slice(0,8)}`,title:old.title,visibility:"open",defaultAiIndex:old.defaultAiIndex??true,createdBy:u.id}).returning();}for(const oldNote of b.notes.filter((n:any)=>n.notebookId===old.id)){const exists=await db.select().from(notes).where(eq(notes.id,oldNote.id));if(exists.length)continue;const [n]=await db.insert(notes).values({id:oldNote.id,workspaceId:wsId,notebookId:nb.id,title:oldNote.title,bodyMd:oldNote.bodyMd??"",published:false,aiIndex:oldNote.aiIndex??true,createdBy:u.id,updatedBy:u.id}).returning();await writeNoteFile({...n,noteId:n.id});await rebuildLinks(n.id,n.workspaceId,n.bodyMd);count++;}}await db.insert(auditLogs).values({userId:u.id,workspaceId:wsId,actorType:"user",action:"workspace.restore",result:"ok",details:{notes:count}});return ok(c,{restoredNotes:count});});
opsRoutes.get("/workspaces/:id/audit",async c=>{await owner(c,c.req.param("id"));const rows=await db.select().from(auditLogs).where(eq(auditLogs.workspaceId,c.req.param("id"))).orderBy(desc(auditLogs.createdAt));return ok(c,{logs:rows.slice(0,200)});});
opsRoutes.patch("/workspaces/:id/freeze",async c=>{const u=await owner(c,c.req.param("id"));const[ws]=await db.select().from(workspaces).where(eq(workspaces.id,c.req.param("id")));if(ws?.deletionScheduledAt)throw fail("FORBIDDEN","注销宽限期内不能改冻结状态");const b=z.object({frozen:z.boolean()}).parse(await c.req.json());await db.update(workspaces).set({frozen:b.frozen}).where(eq(workspaces.id,c.req.param("id")));await db.insert(auditLogs).values({userId:u.id,workspaceId:c.req.param("id"),actorType:"user",action:b.frozen?"workspace.freeze":"workspace.unfreeze",result:"ok"});return ok(c,{});});

// —— 给人看的导出：笔记本/目录/标题.md + 附件（规格 06 的 3.3）——
import { attachments } from "../db/schema.ts";
import { makeZip,safeSegment,uniquePath,type ZipEntry } from "../lib/zip.ts";
import { noteAccess } from "../lib/note-access.ts";
import { notebookAccess } from "../lib/notebook-access.ts";

const MAX_EXPORT_BYTES=200*1024*1024;
const frontmatter=(n:typeof notes.$inferSelect)=>[
  "---",`id: ${n.id}`,`title: ${JSON.stringify(n.title)}`,
  `tags: [${((n.tags as string[])??[]).map(t=>JSON.stringify(t)).join(", ")}]`,
  `published: ${n.published}`,`ai_index: ${n.aiIndex}`,
  `created_at: ${new Date(n.createdAt).toISOString()}`,`updated_at: ${new Date(n.updatedAt).toISOString()}`,
  "---","",
].join("\n");

/** 把一批笔记打成 zip：正文里的附件链接改成 zip 内的相对路径，离线也能看。 */
async function packNotes(rows:typeof notes.$inferSelect[],label:(n:typeof notes.$inferSelect)=>string[]){
  const used=new Set<string>();const entries:ZipEntry[]=[];let total=0;
  const files=rows.length?await db.select().from(attachments).where(inArray(attachments.noteId,rows.map(n=>n.id))):[];
  for(const n of rows){
    const dir=label(n).map(seg=>safeSegment(seg)).join("/");
    const notePath=uniquePath(used,`${dir}/${safeSegment(n.title)}.md`);
    const mine=files.filter(a=>a.noteId===n.id&&!a.trashedAt);
    let body=n.bodyMd;
    const bag=notePath.replace(/\.md$/,".附件");
    for(const a of mine){
      const rel=uniquePath(used,`${bag}/${safeSegment(a.filename,"附件")}`);
      try{
        const data=await readFile(join(env.dataDir,"attachments",a.workspaceId,a.storedName));
        total+=data.length;if(total>MAX_EXPORT_BYTES)throw fail("QUOTA","导出内容超过 200MB，请按笔记本分批导出");
        entries.push({path:rel,data});
        body=body.split(`/api/v1/attachments/${a.id}`).join(`./${rel.slice(dir.length+1)}`);
      }catch(e){if((e as {code?:string}).code==="QUOTA")throw e;/* 文件丢了就只导正文 */}
    }
    const md=Buffer.from(frontmatter(n)+body,"utf8");
    total+=md.length;if(total>MAX_EXPORT_BYTES)throw fail("QUOTA","导出内容超过 200MB，请按笔记本分批导出");
    entries.push({path:notePath,data:md});
  }
  return entries;
}
function sendZip(c:any,name:string,entries:ZipEntry[]){
  if(!entries.length)throw fail("NOT_FOUND","没有可导出的内容");
  const zip=makeZip(entries);
  c.header("Content-Type","application/zip");
  c.header("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  return c.body(zip);
}
/** 逐篇过一遍 ACL，别人不可读的不进包。 */
async function readable(rows:typeof notes.$inferSelect[],userId:string){
  const out=[];for(const n of rows){try{await noteAccess(n.id,userId,"read");out.push(n);}catch{/* 跳过 */}}
  return out;
}

opsRoutes.get("/workspaces/:id/export.zip",async c=>{
  const user=await currentUser(c);if(!user)throw fail("UNAUTHENTICATED","未登录");
  const id=c.req.param("id");if(!(await memberRole(id,user.id)))throw fail("FORBIDDEN","不是工作区成员");
  const [ws]=await db.select().from(workspaces).where(eq(workspaces.id,id));
  if(!ws)throw fail("NOT_FOUND","工作区不存在");
  const nbs=await db.select().from(notebooks).where(and(eq(notebooks.workspaceId,id),isNull(notebooks.trashedAt)));
  const fs2=await db.select().from(folders).where(eq(folders.workspaceId,id));
  const rows=await readable(await db.select().from(notes).where(and(eq(notes.workspaceId,id),isNull(notes.trashedAt))),user.id);
  const path=(n:typeof notes.$inferSelect)=>{
    const parts=[nbs.find(b=>b.id===n.notebookId)?.title??"未知笔记本"];
    let cur=n.folderId?fs2.find(f=>f.id===n.folderId):undefined;const seen=new Set<string>();
    while(cur&&!seen.has(cur.id)){seen.add(cur.id);parts.splice(1,0,cur.title);cur=cur.parentId?fs2.find(f=>f.id===cur!.parentId):undefined;}
    return parts;
  };
  return sendZip(c,`${ws.name}.zip`,await packNotes(rows,path));
});

opsRoutes.get("/notebooks/:id/export.zip",async c=>{
  const user=await currentUser(c);if(!user)throw fail("UNAUTHENTICATED","未登录");
  const {notebook:nb}=await notebookAccess(c.req.param("id"),user.id,"read");
  const fs2=await db.select().from(folders).where(eq(folders.notebookId,nb.id));
  const rows=await readable(await db.select().from(notes).where(and(eq(notes.notebookId,nb.id),isNull(notes.trashedAt))),user.id);
  const path=(n:typeof notes.$inferSelect)=>{
    const parts:string[]=[];let cur=n.folderId?fs2.find(f=>f.id===n.folderId):undefined;const seen=new Set<string>();
    while(cur&&!seen.has(cur.id)){seen.add(cur.id);parts.unshift(cur.title);cur=cur.parentId?fs2.find(f=>f.id===cur!.parentId):undefined;}
    return [nb.title,...parts];
  };
  return sendZip(c,`${nb.title}.zip`,await packNotes(rows,path));
});

opsRoutes.get("/notes/:id/export.zip",async c=>{
  const user=await currentUser(c);if(!user)throw fail("UNAUTHENTICATED","未登录");
  const {note}=await noteAccess(c.req.param("id"),user.id,"read");
  return sendZip(c,`${note.title}.zip`,await packNotes([note],()=>[]));
});

// —— 工作区设置页的两块地基：改名 + 概览统计 ——
import { count,gte,isNotNull } from "drizzle-orm";
import { backupRuns,backupTargets,mcpTokens,shareLinks,users,workspaceInvites } from "../db/schema.ts";

/** 改工作区名字。个人工作区也能改（它就是「我的库」的标题）；权限同其它管理动作：owner 或 admin。 */
opsRoutes.patch("/workspaces/:id",async c=>{
  const id=c.req.param("id");const u=await owner(c,id);
  const b=z.object({name:z.string().trim().min(1,"名字不能为空").max(40,"名字最多 40 个字")}).parse(await c.req.json());
  const[ws]=await db.select().from(workspaces).where(eq(workspaces.id,id));
  if(!ws)throw fail("NOT_FOUND","工作区不存在");
  if(ws.deletionScheduledAt)throw fail("FORBIDDEN","注销宽限期内不能改名");
  if(ws.name===b.name)return ok(c,{name:ws.name});
  await db.update(workspaces).set({name:b.name}).where(eq(workspaces.id,id));
  await db.insert(auditLogs).values({userId:u.id,workspaceId:id,actorType:"user",action:"workspace.rename",targetType:"workspace",targetId:id,result:"ok",details:{from:ws.name,to:b.name}});
  return ok(c,{name:b.name});
});

/**
 * 设置页概览：把散在成员 / 分享 / 备份 / 回收站各处的数字一次算完。
 * 前端据此渲染统计卡和「该处理什么」的体检清单，不用开六个请求各拉一遍。
 */
opsRoutes.get("/workspaces/:id/overview",async c=>{
  const u=await currentUser(c);if(!u)throw fail("UNAUTHENTICATED","未登录");
  const id=c.req.param("id");const role=await memberRole(id,u.id);
  if(!role)throw fail("FORBIDDEN","不是工作区成员");
  const[ws]=await db.select().from(workspaces).where(eq(workspaces.id,id));
  if(!ws)throw fail("NOT_FOUND","工作区不存在");
  const canManage=role==="owner"||role==="admin";
  const week=new Date(Date.now()-7*86400000);
  const n=async(q:Promise<{value:number}[]>)=>(await q)[0]?.value??0;

  const memberRows=await db.select({role:workspaceMembers.role}).from(workspaceMembers).where(eq(workspaceMembers.workspaceId,id));
  const roles={owner:0,admin:0,editor:0,viewer:0} as Record<string,number>;
  for(const m of memberRows)roles[m.role]=(roles[m.role]??0)+1;

  const[notebookCount,noteCount,trashedNotes,activeNotes7d]=await Promise.all([
    n(db.select({value:count()}).from(notebooks).where(and(eq(notebooks.workspaceId,id),isNull(notebooks.trashedAt)))),
    n(db.select({value:count()}).from(notes).where(and(eq(notes.workspaceId,id),isNull(notes.trashedAt)))),
    n(db.select({value:count()}).from(notes).where(and(eq(notes.workspaceId,id),isNotNull(notes.trashedAt)))),
    n(db.select({value:count()}).from(notes).where(and(eq(notes.workspaceId,id),isNull(notes.trashedAt),gte(notes.updatedAt,week)))),
  ]);

  const attachRows=await db.select({bytes:attachments.bytes}).from(attachments).where(and(eq(attachments.workspaceId,id),isNull(attachments.trashedAt)));
  const attachBytes=attachRows.reduce((s,a)=>s+(a.bytes??0),0);

  const shareRows=await db.select({expiresAt:shareLinks.expiresAt,passwordHash:shareLinks.passwordHash}).from(shareLinks).where(and(eq(shareLinks.workspaceId,id),eq(shareLinks.status,"active")));
  const soon=Date.now()+7*86400000;
  const shares={active:shareRows.length,expiringSoon:shareRows.filter(s=>s.expiresAt&&s.expiresAt.getTime()<=soon).length,noPassword:shareRows.filter(s=>!s.passwordHash).length};

  const inviteRows=canManage?await db.select({expiresAt:workspaceInvites.expiresAt,status:workspaceInvites.status}).from(workspaceInvites).where(and(eq(workspaceInvites.workspaceId,id),eq(workspaceInvites.status,"active"))):[];
  const activeInvites=inviteRows.filter(i=>i.expiresAt.getTime()>Date.now()).length;

  const mcpActive=await n(db.select({value:count()}).from(mcpTokens).where(and(eq(mcpTokens.workspaceId,id),eq(mcpTokens.status,"active"))));

  let backup:{targets:number;lastRunAt:string|null;lastStatus:string|null;scheduled:number}|null=null;
  if(canManage){
    const targets=await db.select({id:backupTargets.id,schedule:backupTargets.schedule,enabled:backupTargets.enabled}).from(backupTargets).where(eq(backupTargets.workspaceId,id));
    const[lastRun]=await db.select({status:backupRuns.status,createdAt:backupRuns.createdAt}).from(backupRuns).where(eq(backupRuns.workspaceId,id)).orderBy(desc(backupRuns.createdAt)).limit(1);
    backup={targets:targets.length,scheduled:targets.filter(t=>t.enabled&&t.schedule!=="manual").length,lastRunAt:lastRun?new Date(lastRun.createdAt).toISOString():null,lastStatus:lastRun?.status??null};
  }

  const recentAudit=canManage?await db.select({id:auditLogs.id,action:auditLogs.action,result:auditLogs.result,actorType:auditLogs.actorType,createdAt:auditLogs.createdAt,actorName:users.displayName}).from(auditLogs).leftJoin(users,eq(users.id,auditLogs.userId)).where(eq(auditLogs.workspaceId,id)).orderBy(desc(auditLogs.createdAt)).limit(6):[];

  const[ownerRow]=await db.select({displayName:users.displayName,handle:users.handle}).from(users).where(eq(users.id,ws.ownerId));
  return ok(c,{
    workspace:{id:ws.id,name:ws.name,slug:ws.slug,kind:ws.kind,frozen:ws.frozen,deletionScheduledAt:ws.deletionScheduledAt,createdAt:ws.createdAt,ownerName:ownerRow?.displayName??"",ownerHandle:ownerRow?.handle??""},
    myRole:role,canManage,
    roles,
    stats:{members:memberRows.length,notebooks:notebookCount,notes:noteCount,notesActive7d:activeNotes7d,attachments:attachRows.length,attachmentBytes:attachBytes,mcpActive,activeInvites,trashedNotes},
    shares,backup,recentAudit,
  });
});
