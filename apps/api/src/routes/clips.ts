import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { fail } from '@kb/shared';
import { db } from '../db/client.ts';
import { folders, notebooks, workspaces } from '../db/schema.ts';
import { currentUser } from '../lib/session.ts';
import { notebookAccess } from '../lib/notebook-access.ts';
import { memberRole } from '../lib/workspace.ts';
import { limit } from '../lib/rate-limit.ts';
import { CLIP_LIMITS } from '../lib/clip-extract.ts';
import { clipRequestHash, existingClip, saveClip } from '../lib/clip-save.ts';
import { prepareClip } from '../lib/clip-prepare.ts';
import { clipBridgeDocument } from '../lib/clip-bridge.ts';
import { err, ok } from '../http.ts';

export const clipRoutes=new Hono();
for(const path of ['/clips/*','/notebooks/:id/clips','/me/clip-inbox','/workspaces/:id/clip-targets','/notebooks/:id/clip-folders'])clipRoutes.use(path,async(c,next)=>{c.header('Cache-Control','private, no-store');await next();});
for(const path of ['/clips/preview','/notebooks/:id/clips'])clipRoutes.use(path,bodyLimit({maxSize:1_200_000,onError:c=>err(c,fail('PAYLOAD_TOO_LARGE','剪藏请求过大，请选择较短的正文片段'))}));
clipRoutes.use('/clips/bridge',bodyLimit({maxSize:3_200_000,onError:c=>err(c,fail('PAYLOAD_TOO_LARGE','剪藏请求过大'))}));
clipRoutes.post('/clips/bridge',async c=>{const form=await c.req.parseBody();const packet=z.string().max(1_100_000).parse(form.packet);return c.html(clipBridgeDocument(packet));});
const inputSchema=z.object({expectedUserId:z.string().uuid(),url:z.string().max(4096),html:z.string().max(CLIP_LIMITS.htmlBytes).optional(),title:z.string().max(160).optional(),selection:z.boolean().default(false),mode:z.enum(['article','link']).default('article')});
let active=0;const userActive=new Map<string,number>();
async function actor(c:Parameters<typeof currentUser>[0]){const user=await currentUser(c);if(!user)throw fail('UNAUTHENTICATED','请登录后保存剪藏');return user;}
async function work<T>(userId:string,run:()=>Promise<T>):Promise<T>{
 if(active>=8||(userActive.get(userId)??0)>=2)throw fail('RATE_LIMIT','已有剪藏正在处理，请稍后重试');
 active++;userActive.set(userId,(userActive.get(userId)??0)+1);
 try{return await run();}finally{active--;const n=(userActive.get(userId)??1)-1;n?userActive.set(userId,n):userActive.delete(userId);}
}
clipRoutes.get('/workspaces/:id/clip-targets',async c=>{
 c.header('Cache-Control','private, no-store');const user=await actor(c),workspaceId=z.string().uuid().parse(c.req.param('id'));
 if(!await memberRole(workspaceId,user.id))throw fail('NOT_FOUND','工作区不存在');
 const candidates=await db.select({id:notebooks.id,title:notebooks.title}).from(notebooks).where(and(eq(notebooks.workspaceId,workspaceId),isNull(notebooks.trashedAt)));
 const targets:typeof candidates=[];for(const nb of candidates){try{await notebookAccess(nb.id,user.id,'edit');targets.push(nb);}catch{}}
 return ok(c,{notebooks:targets});
});
clipRoutes.get('/notebooks/:id/clip-folders',async c=>{
 c.header('Cache-Control','private, no-store');const user=await actor(c),id=z.string().uuid().parse(c.req.param('id'));await notebookAccess(id,user.id,'edit');
 return ok(c,{folders:await db.select({id:folders.id,title:folders.title,parentId:folders.parentId}).from(folders).where(and(eq(folders.notebookId,id),isNull(folders.trashedAt)))});
});
clipRoutes.post('/me/clip-inbox',async c=>{
 const user=await actor(c);const request=z.object({expectedUserId:z.string().uuid()}).parse(await c.req.json());if(request.expectedUserId!==user.id)throw fail('FORBIDDEN','登录账号已变化，请回到当前账号重新确认剪藏');if(user.status==='pending_deletion')throw fail('FORBIDDEN','账号待注销，不能新建剪藏');
 const notebook=await db.transaction(async tx=>{
  const [workspace]=await tx.select().from(workspaces).where(eq(workspaces.personalUserId,user.id)).for('update');if(!workspace||workspace.frozen)throw fail('FORBIDDEN','个人工作区暂不可写');
  const slug=`clip-inbox-${user.id.slice(0,8)}`;
  const [existing]=await tx.select().from(notebooks).where(and(eq(notebooks.workspaceId,workspace.id),eq(notebooks.slug,slug)));
  if(existing){if(existing.trashedAt||existing.createdBy!==user.id)throw fail('VALIDATION','收件箱已删除或不可用，请手动选择笔记本');return existing;}
  const [made]=await tx.insert(notebooks).values({workspaceId:workspace.id,title:'收件箱',slug,visibility:'private',defaultAiIndex:false,createdBy:user.id}).returning();return made!;
 });return ok(c,{id:notebook.id,title:notebook.title,workspaceId:notebook.workspaceId},201);
});
clipRoutes.post('/clips/preview',async c=>{
 const user=await actor(c);limit(`clip:${user.id}`,120,600000);const input=inputSchema.parse(await c.req.json());if(input.expectedUserId!==user.id)throw fail('FORBIDDEN','登录账号已变化，请重新确认剪藏');
 return work(user.id,async()=>ok(c,await prepareClip(input)));
});
clipRoutes.post('/notebooks/:id/clips',async c=>{
 const user=await actor(c);limit(`clip:${user.id}`,120,600000);const notebookId=z.string().uuid().parse(c.req.param('id'));
 const body=inputSchema.extend({captureId:z.string().uuid(),folderId:z.string().uuid().nullable().optional(),selectedImages:z.array(z.string().max(4096)).max(CLIP_LIMITS.images).default([])}).parse(await c.req.json());
 if(body.expectedUserId!==user.id)throw fail('FORBIDDEN','登录账号已变化，请重新确认剪藏');
 await notebookAccess(notebookId,user.id,'edit');
 const requestHash=clipRequestHash({...body,selectedImages:[...new Set(body.selectedImages)].sort()});
 const replay=await existingClip(user.id,notebookId,body.captureId,requestHash);if(replay)return ok(c,replay);
 return work(user.id,async()=>{const deadline=Date.now()+9000,clip=await prepareClip(body);return ok(c,await saveClip({userId:user.id,notebookId,folderId:body.folderId,captureId:body.captureId,requestHash,clip,selectedImages:body.selectedImages,deadline}),201);});
});
