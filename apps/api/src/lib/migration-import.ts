import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { AppError, fail } from '@kb/shared';
import { db } from '../db/client.ts';
import { attachments, backgroundJobs, folders, notebooks, notes, noteVersions, users } from '../db/schema.ts';
import { putBlob, hashBytes, cleanupUnreferencedBlob } from './blobs.ts';
import { assertAttachmentType } from './file-type.ts';
import { assertUserStorage, textBytes } from './quota.ts';
import { writeNoteFile } from './files.ts';
import { rebuildLinks, noteCandidates } from './links.ts';
import { enqueueIndexNote } from './ai-index.ts';
import { nextNoteSavedAt } from './note-save.ts';
import { norm, planImport, type ImportInput } from './import-plan.ts';
import { migrationNoteToken, type MigrationSource, type MigrationReportItem } from './migration-source.ts';

export type MigrationPlan = Awaited<ReturnType<typeof planImport>>;
export function migrationFingerprint(nbId: string, input: ImportInput, source: MigrationSource, plan: MigrationPlan) {
  return createHash('sha256').update(JSON.stringify({nbId,input,source:source.source,assets:source.files.map(f=>f.assets.map(a=>[a.path,a.mime,hashBytes(a.bytes)])),items:plan.items,folders:plan.newFolders})).digest('hex');
}
export function migrationPreview(source: MigrationSource, plan: MigrationPlan, fingerprint: string) {
  return {
    fingerprint,source:source.source,targetFolder:plan.targetFolderPath.join('/')||null,
    newFolders:plan.newFolders.map(f=>f.path.join('/')),
    items:plan.items.map((item,index)=>({sourcePath:source.files[index]!.sourcePath,folder:item.folderPath.join('/'),title:item.title,originalTitle:item.originalTitle,action:item.action,attachments:source.files[index]!.assets.length,warnings:source.files[index]!.warnings})),
    summary:{create:plan.items.filter(i=>i.action==='create').length,rename:plan.items.filter(i=>i.action==='rename').length,overwrite:plan.items.filter(i=>i.action==='overwrite').length,skip:plan.items.filter(i=>i.action==='skip').length},
    report:source.report,
  };
}

/** 每篇事务是回滚边界，磁盘正文和链接作为可重建副本在提交后更新。 */
export async function executeMigration(nb: typeof notebooks.$inferSelect, userId: string, source: MigrationSource, plan: MigrationPlan) {
  const report: MigrationReportItem[]=[...source.report];
  const created: Array<{id:string;title:string;path:string}>=[], overwritten:typeof created=[], skipped:Array<{path:string;title:string}>=[], foldersCreated:string[]=[];
  const savedNotes: Array<typeof notes.$inferSelect>=[];
  const savedByIndex=new Map<number,typeof notes.$inferSelect>();
  const titleByToken = new Map(source.files.map((page,i)=>[migrationNoteToken(page.sourcePath),plan.items[i]!.title]));
  for(let index=0;index<plan.items.length;index++) {
    const item=plan.items[index]!,page=source.files[index]!;
    const warnings=[...page.warnings];
    if(item.folderPath.length===8&&page.path.split('/').length-1+plan.targetFolderPath.length>8)warnings.push('目录超过 8 层，较深目录已合并到第 8 层');
    if(item.action==='skip'){skipped.push({path:page.sourcePath,title:item.title});report.push({path:page.sourcePath,title:item.title,status:'skipped',message:'同目录已存在同名笔记'});continue;}
    const attemptedBlobs=new Set<string>();
    try {
      const committed=await db.transaction(async tx=>{
        // 同一本的导入互斥；锁定配额归属用户，使本导入每篇之间可正确累计。
        await tx.select({id:notebooks.id}).from(notebooks).where(eq(notebooks.id,nb.id)).for('update');
        const [liveNotebook]=await tx.select().from(notebooks).where(and(eq(notebooks.id,nb.id),isNull(notebooks.trashedAt)));
        if(!liveNotebook)throw fail('NOT_FOUND','目标笔记本已删除');
        let folderId:string|null=null;
        const newPaths:string[]=[];
        for(let depth=0;depth<item.folderPath.length;depth++){
          const title=item.folderPath[depth]!;
          const rows=await tx.select().from(folders).where(and(eq(folders.notebookId,nb.id),isNull(folders.trashedAt),folderId?eq(folders.parentId,folderId):isNull(folders.parentId)));
          let folder=rows.find(f=>norm(f.title)===norm(title));
          if(!folder){[folder]=await tx.insert(folders).values({workspaceId:nb.workspaceId,notebookId:nb.id,parentId:folderId,title}).returning();newPaths.push(item.folderPath.slice(0,depth+1).join('/'));}
          folderId=folder!.id;
        }
        const sameTitle=await tx.select().from(notes).where(and(eq(notes.notebookId,nb.id),isNull(notes.trashedAt),folderId?eq(notes.folderId,folderId):isNull(notes.folderId)));
        const existing=sameTitle.find(n=>norm(n.title)===norm(item.title));
        const earlier=item.targetIndex===undefined?undefined:savedByIndex.get(item.targetIndex);
        if(item.action==='overwrite'&&(!existing||existing.id!==(earlier?.id??item.targetId)||existing.version!==(earlier?.version??item.targetVersion)))throw fail('CONFLICT_VERSION','同名笔记已变化，请重新预览');
        if(item.action!=='overwrite'&&existing)throw fail('CONFLICT_VERSION','导入期间出现同名笔记，请重新预览');
        const owner=existing?.createdBy??userId;
        for(const id of [...new Set([userId,owner])].sort())await tx.select({id:users.id}).from(users).where(eq(users.id,id)).for('update');
        const noteId=existing?.id??crypto.randomUUID();
        let body=item.body;
        // 以最终标题生成双链；整批完成后统一解析，因此前向引用也能连接。
        body=body.replace(/\[([^\]\n]*)\]\((\/__migration_note\/[a-f\d]{64})\)/g,(_raw,label:string,token:string)=>{
          const title=titleByToken.get(token);return title?`[[${title.replace(/[\[\]|#]/g,'')}|${label.replace(/[\[\]|]/g,'')||title}]]`:label;
        });
        const currentAttachments=existing?await tx.select().from(attachments).where(and(eq(attachments.noteId,noteId),isNull(attachments.trashedAt))):[];
        const usedNames=new Set(currentAttachments.map(a=>a.filename));
        const pending:Array<{id:string;base:string;filename:string;mime:string;bytes:Buffer;sha:string;existing?:typeof attachments.$inferSelect}>=[];
        for(const asset of page.assets){
          assertAttachmentType(asset.mime,asset.bytes);
          const sha=hashBytes(asset.bytes),base=asset.filename.replace(/[^\w.\u4e00-\u9fff-]+/g,'_').slice(0,180)||'attachment';
          const planned=pending.find(a=>a.sha===sha&&a.base===base);
          if(planned){body=body.replaceAll(asset.placeholder,`/api/v1/attachments/${planned.id}`);continue;}
          let same=currentAttachments.find(a=>a.sha256===sha&&a.filename===base);
          let filename=base;
          if(!same){
            for(let n=2;usedNames.has(filename);n++){
              const candidate=currentAttachments.find(a=>a.filename===filename&&a.sha256===sha);
              if(candidate){same=candidate;break;}
              const dot=base.lastIndexOf('.');filename=dot>0?`${base.slice(0,dot)}-${n}${base.slice(dot)}`:`${base}-${n}`;
            }
            if(!same)usedNames.add(filename);
          }
          const id=same?.id??crypto.randomUUID();
          pending.push({id,base,filename,mime:asset.mime,bytes:asset.bytes,sha,existing:same});
          body=body.replaceAll(asset.placeholder,`/api/v1/attachments/${id}`);
        }
        const fileBytes=pending.reduce((n,a)=>n+(!a.existing||a.existing.trashedAt?a.bytes.length:0),0);
        const noteDelta=textBytes(item.title,body)-(existing?textBytes(existing.title,existing.bodyMd):0);
        if(owner===userId)await assertUserStorage(userId,Math.max(0,noteDelta)+fileBytes,tx);
        else {await assertUserStorage(owner,Math.max(0,noteDelta),tx);await assertUserStorage(userId,fileBytes,tx);}
        let note: typeof notes.$inferSelect;
        if(existing){
          const changed=existing.bodyMd!==body;
          [note]=await tx.update(notes).set({bodyMd:body,version:existing.version+(changed?1:0),updatedBy:userId,updatedAt:nextNoteSavedAt(existing.updatedAt)}).where(and(eq(notes.id,existing.id),eq(notes.version,existing.version))).returning();
          if(!note!)throw fail('CONFLICT_VERSION','导入期间笔记已被修改，请重新预览');
          if(changed){
            // 老库可能缺当前快照，覆盖前补齐，确保旧正文可恢复。
            const [version]=await tx.select({id:noteVersions.id}).from(noteVersions).where(and(eq(noteVersions.noteId,existing.id),eq(noteVersions.version,existing.version)));
            if(!version)await tx.insert(noteVersions).values({noteId:existing.id,version:existing.version,title:existing.title,bodyMd:existing.bodyMd,editorId:existing.updatedBy,source:'import'});
            await tx.insert(noteVersions).values({noteId:note.id,version:note.version,title:note.title,bodyMd:note.bodyMd,editorId:userId,source:'import'});
          }
        }else{
          [note]=await tx.insert(notes).values({id:noteId,workspaceId:nb.workspaceId,notebookId:nb.id,folderId,title:item.title,bodyMd:body,aiIndex:nb.defaultAiIndex,createdBy:userId,updatedBy:userId}).returning();
          await tx.insert(noteVersions).values({noteId:note.id,version:1,title:note.title,bodyMd:body,editorId:userId,source:'import'});
        }
        // 多个哈希按固定顺序取锁，跨笔记本导入不会因相反附件顺序互相等待。
        for(const asset of [...pending].sort((a,b)=>a.sha.localeCompare(b.sha))){
          if(asset.existing){if(asset.existing.trashedAt)await tx.update(attachments).set({trashedAt:null}).where(eq(attachments.id,asset.id));continue;}
          attemptedBlobs.add(asset.sha);
          const blob=await putBlob(asset.bytes,tx);
          await tx.insert(attachments).values({id:asset.id,workspaceId:nb.workspaceId,noteId,filename:asset.filename,storedName:blob.path,mime:asset.mime,bytes:asset.bytes.length,sha256:blob.sha256,createdBy:userId,extractStatus:asset.mime==='application/pdf'?'pending':'none'});
          if(asset.mime==='application/pdf')await tx.insert(backgroundJobs).values({type:'extract_pdf',payload:{attachmentId:asset.id}});
        }
        await enqueueIndexNote(tx,note.id);
        return {note,newPaths};
      });
      const result={id:committed.note.id,title:committed.note.title,path:page.sourcePath};
      (item.action==='overwrite'?overwritten:created).push(result);foldersCreated.push(...committed.newPaths);savedNotes.push(committed.note);savedByIndex.set(index,committed.note);
      report.push({...result,status:'success',message:item.action==='overwrite'?'已覆盖，旧正文保留在版本历史':'已导入'});
      for(const warning of warnings)report.push({...result,status:'degraded',message:warning});
      try {await writeNoteFile({...committed.note,noteId:committed.note.id});}
      catch {report.push({...result,status:'degraded',message:'正文已安全入库，磁盘镜像写入失败，可重新保存笔记修复'});}
    } catch(e) {
      if(!(e instanceof AppError))console.error("迁移单篇失败",page.sourcePath,e);
      // 此时事务已回滚、连接/行锁已释放；清理只删除没有任何已提交引用的物理文件。
      // 清理失败则终止本批，不能继续放大磁盘占用或隐瞒运维错误。
      for(const sha of attemptedBlobs)await cleanupUnreferencedBlob(sha);
      report.push({path:page.sourcePath,title:item.title,status:'failed',message:e instanceof AppError?e.message:'导入失败，本篇已回滚，请重试或检查服务器日志'});
    }
  }
  if(savedNotes.length){
    let candidates:Awaited<ReturnType<typeof noteCandidates>>|undefined;
    try{candidates=await noteCandidates(nb.workspaceId);}catch{/* 正文已提交；索引失败仍应返回准确的成功报告。 */}
    for(const note of savedNotes){
      try{if(!candidates)throw new Error('链接候选读取失败');await rebuildLinks(note.id,note.workspaceId,note.bodyMd,candidates,{skipIncomingSync:true});}
      catch{report.push({path:created.concat(overwritten).find(n=>n.id===note.id)?.path??note.title,title:note.title,id:note.id,status:'degraded',message:'正文已入库，双链索引稍后重新保存可修复'});}
    }
  }
  return {created,overwritten,skipped,foldersCreated:[...new Set(foldersCreated)],report};
}
