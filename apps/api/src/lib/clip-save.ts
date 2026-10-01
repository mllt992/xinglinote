import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { fail, nextSortKey } from '@kb/shared';
import { db } from '../db/client.ts';
import { attachments, folders, notebooks, notes, noteVersions, users } from '../db/schema.ts';
import { notebookAccess } from './notebook-access.ts';
import { captureTargetId } from './capture-id.ts';
import { assertUserStorage, textBytes } from './quota.ts';
import { putBlob, hashBytes, cleanupUnreferencedBlob } from './blobs.ts';
import { assertAttachmentType, imageDimensions } from './file-type.ts';
import { enqueueIndexNote } from './ai-index.ts';
import { writeNoteFile } from './files.ts';
import { rebuildLinks } from './links.ts';
import { fetchPublicResource } from './public-fetch.ts';
import { CLIP_LIMITS, type ClipExtraction } from './clip-extract.ts';

export function clipRequestHash(input:unknown){return createHash('sha256').update(JSON.stringify(input)).digest('hex');}
export type ClipSaved={id:string;workspaceId:string;notebookId:string;title:string;warnings:string[];replayed:boolean};
export async function existingClip(userId:string,notebookId:string,captureId:string,hash:string,reader:Pick<typeof db,'select'>=db){
 const id=captureTargetId(userId,notebookId,'clip',captureId);
 const [note]=await reader.select().from(notes).where(eq(notes.id,id));
 if(!note)return null;
 if(note.notebookId!==notebookId||note.createdBy!==userId||note.trashedAt)throw fail('NOT_FOUND','该次剪藏目标已不存在，请新建一次剪藏');
 if(note.captureHash!==hash)throw fail('IDEMPOTENCY_KEY_REUSED','这次剪藏 ID 已用于不同内容，请保留当前草稿并重新创建');
 return{id:note.id,workspaceId:note.workspaceId,notebookId:note.notebookId,title:note.title,warnings:['这次剪藏此前已保存，未重复抓取；请打开笔记查看附件'],replayed:true} satisfies ClipSaved;
}
type ImageAsset={bytes:Buffer;mime:string;filename:string;placeholder:string};
export type ImageDownloader=(url:string,remaining:number,timeoutMs:number)=>Promise<{body:Buffer;contentType:string}>;
const downloadImage:ImageDownloader=(url,remaining,timeoutMs)=>fetchPublicResource(url,{maxBytes:Math.min(CLIP_LIMITS.imageBytes,remaining),timeoutMs,accept:'image/png,image/jpeg,image/webp,image/gif'});

/** 网络与解码在事务外，事务内只用同一个连接做 ACL、配额、正文/附件/版本写入。 */
export async function saveClip(input:{userId:string;notebookId:string;folderId?:string|null;captureId:string;requestHash:string;clip:ClipExtraction;selectedImages:string[];deadline:number},download:ImageDownloader=downloadImage):Promise<ClipSaved>{
 const {notebook}=await notebookAccess(input.notebookId,input.userId,'edit');
 const replay=await existingClip(input.userId,notebook.id,input.captureId,input.requestHash);if(replay)return replay;
 const assets:ImageAsset[]=[],warnings=[...input.clip.warnings];let bytesLeft=CLIP_LIMITS.totalImageBytes,pixelsLeft=16_000_000,body=input.clip.bodyMd;
 for(const image of input.clip.images){
  let downloaded=false;
  if(input.selectedImages.includes(image.url))try{
   const timeLeft=input.deadline-Date.now();if(timeLeft<200||bytesLeft<1)throw Error('已到下载时间或体积上限');
   const allowance=Math.min(CLIP_LIMITS.imageBytes,bytesLeft);bytesLeft-=allowance;
   const response=await download(image.url,allowance,Math.min(2500,timeLeft)),mime=response.contentType.split(';')[0]!.trim().toLowerCase();
   if(response.body.length>allowance)throw Error('图片过大');bytesLeft+=allowance-response.body.length;assertAttachmentType(mime,response.body);
   if(!mime.startsWith('image/'))throw Error('不是支持的图片');const dimensions=imageDimensions(mime,response.body)!;const pixels=dimensions.width*dimensions.height;if(pixels>pixelsLeft)throw Error('图片总像素过大');pixelsLeft-=pixels;
   assets.push({bytes:response.body,mime,filename:`clip-image-${assets.length+1}.${mime==='image/jpeg'?'jpg':mime.split('/')[1]}`,placeholder:image.placeholder});downloaded=true;
  }catch{warnings.push(`图片未保存，保留来源链接：${image.url.slice(0,180)}`);}
  if(!downloaded){
   body=body.replace(/!\[([^\]]*)\]\(<(__clip_asset_[a-f0-9]{64}\.png)>\)/g,(raw,label:string,placeholder:string)=>placeholder===image.placeholder?`[${label}](<${image.url}>)`:raw);
  }
 }
 const attempted=new Set<string>(),id=captureTargetId(input.userId,notebook.id,'clip',input.captureId);
 let result:typeof notes.$inferSelect|undefined;
 try{
  const saved=await db.transaction(async tx=>{
   await tx.select({id:notebooks.id}).from(notebooks).where(eq(notebooks.id,notebook.id)).for('update');
   await tx.select({id:users.id}).from(users).where(eq(users.id,input.userId)).for('update');
   const access=await notebookAccess(notebook.id,input.userId,'edit',tx);
   const again=await existingClip(input.userId,notebook.id,input.captureId,input.requestHash,tx);if(again)return{replay:again};
   if(input.folderId){const [folder]=await tx.select({id:folders.id}).from(folders).where(and(eq(folders.id,input.folderId),eq(folders.notebookId,notebook.id),isNull(folders.trashedAt)));if(!folder)throw fail('NOT_FOUND','目标目录不存在');}
   const planned=assets.map(asset=>({...asset,id:crypto.randomUUID(),sha:hashBytes(asset.bytes)}));
   for(const asset of planned)body=body.replaceAll(asset.placeholder,`/api/v1/attachments/${asset.id}`);
   await assertUserStorage(input.userId,textBytes(input.clip.title,body)+planned.reduce((n,a)=>n+a.bytes.length,0),tx);
   const keys=await tx.select({sortKey:notes.sortKey}).from(notes).where(and(eq(notes.notebookId,notebook.id),isNull(notes.trashedAt)));
   const [note]=await tx.insert(notes).values({id,notebookId:notebook.id,workspaceId:access.workspace.id,folderId:input.folderId??null,sortKey:nextSortKey(keys.map(n=>n.sortKey)),title:input.clip.title,bodyMd:body,tags:['待整理'],published:false,aiIndex:access.notebook.defaultAiIndex,captureHash:input.requestHash,createdBy:input.userId,updatedBy:input.userId}).returning();
   await tx.insert(noteVersions).values({noteId:note!.id,version:1,title:note!.title,bodyMd:body,editorId:input.userId,source:'clip'});
   for(const asset of planned.sort((a,b)=>a.sha.localeCompare(b.sha))){attempted.add(asset.sha);const blob=await putBlob(asset.bytes,tx);await tx.insert(attachments).values({id:asset.id,workspaceId:access.workspace.id,noteId:note!.id,filename:asset.filename,mime:asset.mime,bytes:asset.bytes.length,sha256:asset.sha,storedName:blob.path,createdBy:input.userId});}
   await enqueueIndexNote(tx,note!.id);return{note};
  });
  if(saved.replay)return saved.replay;result=saved.note;
 }catch(error){for(const sha of attempted)await cleanupUnreferencedBlob(sha);throw error;}
 try{await writeNoteFile({...result!,noteId:id});await rebuildLinks(id,result!.workspaceId,body);}catch{warnings.push('正文和附件已入库；磁盘镜像或双链索引可在重新保存后修复');}
 return{id,workspaceId:result!.workspaceId,notebookId:notebook.id,title:result!.title,warnings,replayed:false};
}
