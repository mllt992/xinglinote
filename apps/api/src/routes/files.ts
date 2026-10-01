import { Hono } from "hono";import { and,eq,isNull } from "drizzle-orm";import { fail } from "@kb/shared";import { db } from "../db/client.ts";import { attachments } from "../db/schema.ts";import { ok } from "../http.ts";import { currentUser } from "../lib/session.ts";import { noteAccess } from "../lib/note-access.ts";import { notebookAccess } from "../lib/notebook-access.ts";import { importInput,planImport } from "../lib/import-plan.ts";
import { enqueueIndexNote } from "../lib/ai-index.ts";
import { saveNoteAttachment } from "../lib/attachments.ts";
import { readStoredFile } from "../lib/blobs.ts";
import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { prepareMigration, type MigrationSource } from "../lib/migration-source.ts";
import { executeMigration, migrationFingerprint, migrationPreview } from "../lib/migration-import.ts";
import type { Context } from "hono";
export const fileRoutes=new Hono();
async function u(c:Context){const x=await currentUser(c);if(!x)throw fail("UNAUTHENTICATED","未登录");return x;}
fileRoutes.post("/notes/:id/attachments",async c=>{const user=await u(c);const {note:n}=await noteAccess(c.req.param("id"),user.id,"edit");const form=await c.req.formData();const f=form.get("file");if(!(f instanceof File))throw fail("VALIDATION","请选择文件");const saved=await saveNoteAttachment({note:n,userId:user.id,filename:f.name,declaredMime:f.type,bytes:Buffer.from(await f.arrayBuffer())});return ok(c,saved,201);});
fileRoutes.get("/notes/:id/attachments",async c=>{const user=await u(c);const {note:n}=await noteAccess(c.req.param("id"),user.id,"read");const rows=await db.select().from(attachments).where(and(eq(attachments.noteId,n.id),isNull(attachments.trashedAt)));return ok(c,{attachments:rows.map(a=>({id:a.id,filename:a.filename,mime:a.mime,bytes:a.bytes,url:`/api/v1/attachments/${a.id}`,extractStatus:a.extractStatus}))});});
fileRoutes.get("/attachments/:id",async c=>{const user=await u(c);const [a]=await db.select().from(attachments).where(eq(attachments.id,c.req.param("id")));if(!a||a.trashedAt)throw fail("NOT_FOUND","附件不存在");await noteAccess(a.noteId,user.id,"read");const data=await readStoredFile(a);c.header("Content-Type",a.mime);c.header("Content-Disposition",`${a.mime.startsWith("image/")?"inline":"attachment"}; filename*=UTF-8''${encodeURIComponent(a.filename)}`);c.header("X-Content-Type-Options","nosniff");return c.body(data);});
fileRoutes.delete("/attachments/:id",async c=>{const user=await u(c);const [a]=await db.select().from(attachments).where(eq(attachments.id,c.req.param("id")));if(!a)throw fail("NOT_FOUND","附件不存在");await noteAccess(a.noteId,user.id,"edit");await db.update(attachments).set({trashedAt:new Date()}).where(eq(attachments.id,a.id));await enqueueIndexNote(db,a.noteId);return ok(c,{});});

// 老 Markdown API 保持兼容，也使用相同的逐篇事务与错误报告。
fileRoutes.post("/notebooks/:id/import-preview",async c=>{
  const user=await u(c);const{notebook:nb}=await notebookAccess(c.req.param("id"),user.id,"edit");
  const input=importInput.parse(await c.req.json());
  const source:MigrationSource={files:input.files.map(f=>({...f,sourcePath:f.path,assets:[],warnings:[]})),source:"generic",report:[]};
  const plan=await planImport(nb,input);
  return ok(c,migrationPreview(source,plan,migrationFingerprint(nb.id,input,source,plan)));
});
fileRoutes.post("/notebooks/:id/import-markdown",async c=>{
  const user=await u(c);const{notebook:nb}=await notebookAccess(c.req.param("id"),user.id,"edit");
  const input=importInput.parse(await c.req.json());
  const source:MigrationSource={files:input.files.map(f=>({...f,sourcePath:f.path,assets:[],warnings:[]})),source:"generic",report:[]};
  return ok(c,await executeMigration(nb,user.id,source,await planImport(nb,input)),201);
});
const migrationOptions=importInput.omit({files:true}).extend({source:z.enum(["auto","notion","yuque","generic"]).default("auto")});
const migrationBodyLimit=bodyLimit({maxSize:102*1024*1024,onError:()=>{throw fail("QUOTA","导入请求不能超过 100 MB");}});
async function migrationRequest(c:Context){
  const user=await u(c);const{notebook:nb}=await notebookAccess(c.req.param("id")!,user.id,"edit");
  const form=await c.req.formData();
  const rawOptions=form.get("options");
  let json:unknown;
  try{json=JSON.parse(typeof rawOptions==="string"?rawOptions:"{}");}catch{throw fail("VALIDATION","导入选项格式错误");}
  const checkedOptions=migrationOptions.safeParse(json);
  if(!checkedOptions.success)throw fail("VALIDATION","导入选项不合法");
  const options=checkedOptions.data;
  const uploads=form.getAll("files");
  if(!uploads.length||uploads.length>2000||uploads.some(f=>!(f instanceof File)))throw fail("VALIDATION","请选择 1–2000 个导入文件");
  const rawPaths=form.get("paths");
  let paths:string[]|undefined;
  if(typeof rawPaths==="string"){try{paths=z.array(z.string().max(500)).length(uploads.length).parse(JSON.parse(rawPaths));}catch{throw fail("VALIDATION","导入路径列表格式错误");}}
  const source=await prepareMigration(await Promise.all((uploads as File[]).map(async (f,i)=>({path:paths?.[i]??f.name,bytes:Buffer.from(await f.arrayBuffer())}))),options.source);
  const input={...options,files:source.files.map(f=>({path:f.path,content:f.content}))};
  const plan=await planImport(nb,input),fingerprint=migrationFingerprint(nb.id,input,source,plan);
  return{user,nb,source,plan,fingerprint,expected:form.get("fingerprint")};
}
fileRoutes.post("/notebooks/:id/import-files-preview",migrationBodyLimit,async c=>{
  const {source,plan,fingerprint}=await migrationRequest(c);
  return ok(c,migrationPreview(source,plan,fingerprint));
});
fileRoutes.post("/notebooks/:id/import-files",migrationBodyLimit,async c=>{
  const {user,nb,source,plan,fingerprint,expected}=await migrationRequest(c);
  if(expected!==fingerprint)throw fail("CONFLICT_VERSION","文件或目标树已变化，请重新预览再确认");
  return ok(c,await executeMigration(nb,user.id,source,plan),201);
});
