import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { and, eq, inArray, sql as query } from 'drizzle-orm';
import { Hono } from 'hono';
import { AppError, fail } from '@kb/shared';
import { ZodError } from 'zod';
import { db, sql } from '../db/client.ts';
import { attachments, backgroundJobs, blobStore, folders, links, notebooks, notes, noteVersions, sessions, users, workspaceMembers, workspaces } from '../db/schema.ts';
import { clipRoutes } from '../routes/clips.ts';
import { fileRoutes } from '../routes/files.ts';
import { onError } from '../http.ts';
import { hashSecret } from './tokens.ts';
import { captureTargetId } from './capture-id.ts';
import { clipRequestHash, saveClip } from './clip-save.ts';
import { extractClip } from './clip-extract.ts';
import { blobRelPath, hashBytes, releaseBlob } from './blobs.ts';
import { FIXTURE_PNG } from './__fixtures__/migration-export.ts';
import { env } from '../env.ts';

test('网页剪藏真实数据库：ACL/配额、图片原子提交、失败兜底和并发幂等',{skip:!process.env.KB_TEST_DATABASE_URL},async()=>{
 assert.equal(process.env.DATABASE_URL,process.env.KB_TEST_DATABASE_URL);assert.ok(new URL(process.env.KB_TEST_DATABASE_URL!).pathname.endsWith('_test'));
 const id={owner:randomUUID(),viewer:randomUUID(),ws:randomUUID(),nb:randomUUID(),private:randomUUID(),folder:randomUUID()},token=randomUUID(),viewerToken=randomUUID(),suffix=randomUUID().replaceAll('-','');
 const app=new Hono();app.onError((e,c)=>onError(e instanceof ZodError?fail('VALIDATION','参数错误'):e,c));app.route('/api/v1',clipRoutes);app.route('/api/v1',fileRoutes);
 const call=async(path:string,body?:unknown,auth:string|null=token)=>app.request(`http://test/api/v1${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(auth?{cookie:`kb_session=${auth}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const input={expectedUserId:id.owner,url:'https://example.com/article',title:'剪藏验收',html:'<article><h1>剪藏正文</h1><p>正文应该完整保存到所选择的知识库，图片与链接也应该能找到，未公开笔记不会因为剪藏自动发布。</p><img src="https://example.com/photo.png" alt="图片"/></article>',selection:false,mode:'article',selectedImages:[],folderId:id.folder};
 let fault=false;
 try{
  await db.insert(users).values([id.owner,id.viewer].map((user,i)=>({id:user,email:`clip-${user}@example.invalid`,handle:`clip${user.replaceAll('-','').slice(0,20)}`,displayName:`剪藏${i}`,passwordHash:'not-a-login'})));
  await db.insert(workspaces).values({id:id.ws,slug:`clip-${suffix}`,name:'剪藏验收',kind:'normal',ownerId:id.owner});await db.insert(workspaceMembers).values([{workspaceId:id.ws,userId:id.owner,role:'owner'},{workspaceId:id.ws,userId:id.viewer,role:'viewer'}]);
  await db.insert(notebooks).values([{id:id.nb,title:'收件箱',slug:'inbox',createdBy:id.owner},{id:id.private,title:'他人的私密',slug:'private',createdBy:id.viewer,visibility:'private'}].map(nb=>({...nb,workspaceId:id.ws})));
  await db.insert(folders).values({id:id.folder,workspaceId:id.ws,notebookId:id.nb,title:'待整理'});
  await db.insert(sessions).values([{userId:id.owner,tokenHash:hashSecret(token)},{userId:id.viewer,tokenHash:hashSecret(viewerToken)}].map(s=>({...s,expiresAt:new Date(Date.now()+60000)})));
  assert.equal((await call('/clips/preview',input,null)).status,401);
  assert.equal((await call('/clips/preview',input,viewerToken)).status,403);assert.equal((await call('/me/clip-inbox',{expectedUserId:id.owner},viewerToken)).status,403);assert.equal((await call(`/notebooks/${id.nb}/clips`,{...input,captureId:randomUUID()},viewerToken)).status,403);
  const preview=await call('/clips/preview',input);assert.equal(preview.status,200);assert.match(preview.headers.get('cache-control')!,/no-store/);assert.equal((await db.select().from(notes).where(eq(notes.workspaceId,id.ws))).length,0);
  assert.equal((await call(`/notebooks/${id.nb}/clips`,{...input,expectedUserId:id.viewer,captureId:randomUUID()},viewerToken)).status,404);
  assert.equal((await call(`/notebooks/${id.private}/clips`,{...input,captureId:randomUUID()})).status,404);
  const captureId=randomUUID(),payload={...input,captureId};
  const responses=await Promise.all(Array.from({length:4},()=>call(`/notebooks/${id.nb}/clips`,payload)));
  const success=responses.filter(r=>r.status===201||r.status===200);assert.ok(success.length>=1);for(const r of responses)assert.ok([200,201,429].includes(r.status));
  const result=await success[0]!.json() as {data:{id:string}};const [saved]=await db.select().from(notes).where(eq(notes.id,result.data.id));assert.ok(saved);assert.equal(saved!.folderId,id.folder);assert.equal(saved!.published,false);assert.deepEqual(saved!.tags,['待整理']);assert.match(saved!.bodyMd,/原始网页/);assert.ok(!saved!.bodyMd.includes('__clip_asset_'));assert.ok(!saved!.bodyMd.includes('![图片]'),'未选/失败图片只能留下普通链接');
  assert.equal((await db.select().from(notes).where(eq(notes.workspaceId,id.ws))).length,1);
  assert.equal((await call(`/notebooks/${id.nb}/clips`,{...payload,title:'已修改内容'})).status,409);
  await db.update(users).set({storageQuotaBytes:1}).where(eq(users.id,id.owner));const quota=await call(`/notebooks/${id.nb}/clips`,{...input,captureId:randomUUID()});assert.equal(quota.status,413);assert.equal((await db.select().from(notes).where(eq(notes.workspaceId,id.ws))).length,1);await db.update(users).set({storageQuotaBytes:1_000_000}).where(eq(users.id,id.owner));
  const clip=extractClip(input),imageId=randomUUID();
  const image=await saveClip({userId:id.owner,notebookId:id.nb,captureId:imageId,requestHash:clipRequestHash('image'),clip,selectedImages:[clip.images[0]!.url],deadline:Date.now()+9000},async()=>({body:FIXTURE_PNG,contentType:'image/png'}));
  const imageNotes=await db.select().from(notes).where(eq(notes.id,image.id));const assets=await db.select().from(attachments).where(eq(attachments.noteId,image.id));assert.equal(assets.length,1);assert.ok(imageNotes[0]!.bodyMd.includes(`/api/v1/attachments/${assets[0]!.id}`));
  const download=await call(`/attachments/${assets[0]!.id}`);assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),FIXTURE_PNG);
  const failedImage=await saveClip({userId:id.owner,notebookId:id.nb,captureId:randomUUID(),requestHash:clipRequestHash('failed image'),clip,selectedImages:[clip.images[0]!.url],deadline:Date.now()+9000},async()=>{throw new AppError('VALIDATION','fixture fetch failure',422);});assert.ok(failedImage.warnings.length);const [fallback]=await db.select().from(notes).where(eq(notes.id,failedImage.id));assert.ok(!fallback!.bodyMd.includes('__clip_asset_'));assert.ok(!fallback!.bodyMd.includes('![图片]'));
  const rollbackId=randomUUID(),noteId=captureTargetId(id.owner,id.nb,'clip',rollbackId),uniqueImage=Buffer.concat([FIXTURE_PNG,Buffer.from(suffix)]);
  await db.execute(query.raw(`CREATE FUNCTION clip_fail_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.note_id = '${noteId}' THEN RAISE EXCEPTION 'synthetic clip attachment failure'; END IF; RETURN NEW; END $$`));fault=true;await db.execute(query.raw(`CREATE TRIGGER clip_fail_${suffix} BEFORE INSERT ON attachments FOR EACH ROW EXECUTE FUNCTION clip_fail_${suffix}()`));
  await assert.rejects(saveClip({userId:id.owner,notebookId:id.nb,captureId:rollbackId,requestHash:'fault',clip,selectedImages:[clip.images[0]!.url],deadline:Date.now()+9000},async()=>({body:uniqueImage,contentType:'image/png'})),/synthetic/);
  assert.equal((await db.select().from(notes).where(eq(notes.id,noteId))).length,0);assert.equal((await db.select().from(blobStore).where(eq(blobStore.sha256,hashBytes(uniqueImage)))).length,0);assert.equal(await stat(join(env.dataDir,blobRelPath(hashBytes(uniqueImage)))).then(()=>true,()=>false),false);
  const publicTargets=await (await call(`/workspaces/${id.ws}/clip-targets`)).text();assert.ok(!publicTargets.includes('他人的私密'));
 }finally{
  try{
   if(fault){await db.execute(query.raw(`DROP TRIGGER IF EXISTS clip_fail_${suffix} ON attachments`));await db.execute(query.raw(`DROP FUNCTION IF EXISTS clip_fail_${suffix}()`));}
   const all=(await db.select({id:notes.id}).from(notes).where(eq(notes.workspaceId,id.ws))).map(n=>n.id),assets=await db.select().from(attachments).where(eq(attachments.workspaceId,id.ws));await db.delete(attachments).where(eq(attachments.workspaceId,id.ws));for(const a of assets)await releaseBlob(a.sha256);
   if(all.length){await db.delete(links).where(inArray(links.fromNoteId,all));await db.delete(noteVersions).where(inArray(noteVersions.noteId,all));await db.delete(backgroundJobs).where(query`${backgroundJobs.payload}->>'noteId' in (${query.join(all.map(noteId=>query`${noteId}`),query`,`)})`);}
   await db.delete(notes).where(eq(notes.workspaceId,id.ws));await db.delete(folders).where(eq(folders.workspaceId,id.ws));await db.delete(notebooks).where(eq(notebooks.workspaceId,id.ws));await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId,id.ws));await db.delete(workspaces).where(eq(workspaces.id,id.ws));await db.delete(sessions).where(inArray(sessions.userId,[id.owner,id.viewer]));await db.delete(users).where(inArray(users.id,[id.owner,id.viewer]));
  }finally{await sql.end();}
 }
});
