import { createHash } from "node:crypto";import { mkdir,readFile,writeFile } from "node:fs/promises";import { join } from "node:path";import { Hono } from "hono";import { and,eq,isNull } from "drizzle-orm";import { z } from "zod";import { fail } from "@kb/shared";import { db } from "../db/client.ts";import { attachments,backgroundJobs,folders,notebooks,notes,noteVersions } from "../db/schema.ts";import { env } from "../env.ts";import { ok } from "../http.ts";import { currentUser } from "../lib/session.ts";import { memberRole } from "../lib/workspace.ts";import { writeNoteFile } from "../lib/files.ts";import { rebuildLinks } from "../lib/links.ts";import { assertUserStorage, textBytes } from "../lib/quota.ts";import { noteAccess } from "../lib/note-access.ts";import { notebookAccess } from "../lib/notebook-access.ts";import { importInput,norm,planImport } from "../lib/import-plan.ts";
export const fileRoutes=new Hono();const allowed=new Set(["image/png","image/jpeg","image/webp","image/gif","application/pdf","text/plain","text/markdown","application/zip"]);async function u(c:any){const x=await currentUser(c);if(!x)throw fail("UNAUTHENTICATED","未登录");return x;}
fileRoutes.post("/notes/:id/attachments",async c=>{const user=await u(c);const {note:n}=await noteAccess(c.req.param("id"),user.id,"edit");const form=await c.req.formData();const f=form.get("file");if(!(f instanceof File))throw fail("VALIDATION","请选择文件");if(f.size>25*1024*1024)throw fail("QUOTA","单个文件不能超过 25MB");if(!allowed.has(f.type))throw fail("VALIDATION","不支持此文件类型");await assertUserStorage(user.id,f.size);const bytes=Buffer.from(await f.arrayBuffer());const sha=createHash("sha256").update(bytes).digest("hex");const stored=`${crypto.randomUUID()}-${f.name.replace(/[^a-zA-Z0-9._-]/g,"_")}`;const dir=join(env.dataDir,"attachments",n.workspaceId);await mkdir(dir,{recursive:true});await writeFile(join(dir,stored),bytes);const [a]=await db.insert(attachments).values({workspaceId:n.workspaceId,noteId:n.id,filename:f.name,storedName:stored,mime:f.type,bytes:f.size,sha256:sha,createdBy:user.id}).returning();if(f.type==="application/pdf"){await db.update(attachments).set({extractStatus:"pending"}).where(eq(attachments.id,a.id));await db.insert(backgroundJobs).values({type:"extract_pdf",payload:{attachmentId:a.id}});}
return ok(c,{id:a.id,filename:a.filename,mime:a.mime,bytes:a.bytes,url:`/api/v1/attachments/${a.id}`,extractStatus:f.type==="application/pdf"?"pending":"none"},201);});
fileRoutes.get("/notes/:id/attachments",async c=>{const user=await u(c);const {note:n}=await noteAccess(c.req.param("id"),user.id,"read");const rows=await db.select().from(attachments).where(and(eq(attachments.noteId,n.id),isNull(attachments.trashedAt)));return ok(c,{attachments:rows.map(a=>({id:a.id,filename:a.filename,mime:a.mime,bytes:a.bytes,url:`/api/v1/attachments/${a.id}`,extractStatus:a.extractStatus}))});});
fileRoutes.get("/attachments/:id",async c=>{const user=await u(c);const [a]=await db.select().from(attachments).where(eq(attachments.id,c.req.param("id")));if(!a||a.trashedAt)throw fail("NOT_FOUND","附件不存在");await noteAccess(a.noteId,user.id,"read");const data=await readFile(join(env.dataDir,"attachments",a.workspaceId,a.storedName));c.header("Content-Type",a.mime);c.header("Content-Disposition",`${a.mime.startsWith("image/")?"inline":"attachment"}; filename*=UTF-8''${encodeURIComponent(a.filename)}`);c.header("X-Content-Type-Options","nosniff");return c.body(data);});
fileRoutes.delete("/attachments/:id",async c=>{const user=await u(c);const [a]=await db.select().from(attachments).where(eq(attachments.id,c.req.param("id")));if(!a)throw fail("NOT_FOUND","附件不存在");await noteAccess(a.noteId,user.id,"edit");await db.update(attachments).set({trashedAt:new Date()}).where(eq(attachments.id,a.id));return ok(c,{});});
fileRoutes.post("/notebooks/:id/import-preview",async c=>{
  const user=await u(c);const{notebook:nb}=await notebookAccess(c.req.param("id"),user.id,"edit");
  const input=importInput.parse(await c.req.json());
  const{items,newFolders}=await planImport(nb,input);
  return ok(c,{
    newFolders:newFolders.map(f=>f.path.join("/")),
    items:items.map(({sourcePath,folderPath,title,originalTitle,action})=>({sourcePath,folder:folderPath.join("/"),title,originalTitle,action})),
    summary:{create:items.filter(i=>i.action==="create").length,rename:items.filter(i=>i.action==="rename").length,overwrite:items.filter(i=>i.action==="overwrite").length,skip:items.filter(i=>i.action==="skip").length},
  });
});
fileRoutes.post("/notebooks/:id/import-markdown",async c=>{
  const user=await u(c);const{notebook:nb}=await notebookAccess(c.req.param("id"),user.id,"edit");
  const input=importInput.parse(await c.req.json());
  const{items,newFolders,existingKey}=await planImport(nb,input);
  await assertUserStorage(user.id,items.filter(i=>i.action!=="skip").reduce((sum,i)=>sum+textBytes(i.title,i.body),0));
  for(const f of newFolders.sort((a,b)=>a.path.length-b.path.length)){
    const[row]=await db.insert(folders).values({workspaceId:nb.workspaceId,notebookId:nb.id,parentId:f.parentKey?existingKey.get(f.parentKey)??null:null,title:f.path[f.path.length-1]}).returning();
    existingKey.set(f.key,row.id);
  }
  const liveNotes=await db.select().from(notes).where(and(eq(notes.notebookId,nb.id),isNull(notes.trashedAt)));
  const created=[],overwritten=[],skipped=[];
  for(const item of items){
    const folderId=item.folderKey?existingKey.get(item.folderKey)??null:null;
    if(item.action==="skip"){skipped.push({path:item.sourcePath,title:item.title});continue;}
    if(item.action==="overwrite"){
      const target=liveNotes.find(n=>(n.folderId??null)===folderId&&norm(n.title)===norm(item.title));
      if(target){
        const[saved]=await db.update(notes).set({bodyMd:item.body,version:target.version+1,updatedBy:user.id,updatedAt:new Date()}).where(eq(notes.id,target.id)).returning();
        await db.insert(noteVersions).values({noteId:saved.id,version:saved.version,title:saved.title,bodyMd:saved.bodyMd,editorId:user.id,source:"import"});
        await writeNoteFile({...saved,noteId:saved.id});await rebuildLinks(saved.id,saved.workspaceId,saved.bodyMd);
        overwritten.push({id:saved.id,title:saved.title,path:item.sourcePath});continue;
      }
    }
    const[n]=await db.insert(notes).values({workspaceId:nb.workspaceId,notebookId:nb.id,folderId,title:item.title,bodyMd:item.body,aiIndex:nb.defaultAiIndex,createdBy:user.id,updatedBy:user.id}).returning();
    await db.insert(noteVersions).values({noteId:n.id,version:1,title:n.title,bodyMd:n.bodyMd,editorId:user.id,source:"import"});
    await writeNoteFile({...n,noteId:n.id});await rebuildLinks(n.id,n.workspaceId,n.bodyMd);
    created.push({id:n.id,title:n.title,path:item.sourcePath});
  }
  return ok(c,{created,overwritten,skipped,foldersCreated:newFolders.map(f=>f.path.join("/"))},201);
});
