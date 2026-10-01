import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { and, eq, inArray, sql as query } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, sql } from '../db/client.ts';
import { attachments, backgroundJobs, blobStore, folders, links, notebooks, notes, noteVersions, sessions, users, workspaceMembers, workspaces } from '../db/schema.ts';
import { env } from '../env.ts';
import { onError } from '../http.ts';
import { fileRoutes } from '../routes/files.ts';
import { hashToken } from './session.ts';
import { hashBytes, putBlob, releaseBlob, retainBlob, cleanupUnreferencedBlob, blobRelPath } from './blobs.ts';
import { userStorage } from './quota.ts';
import { notionExportFixture, FIXTURE_PNG, wordExportFixture } from './__fixtures__/migration-export.ts';
import { makeZip } from './zip.ts';
import type { executeMigration, migrationPreview } from './migration-import.ts';
import { readMigrationZip } from './migration-zip.ts';

// 仅允许隔离的 *_test 数据库；注入数据库失败也只作用于本测试的工作区。
test('迁移真实数据库：57 页预览/确认、附件去重下载、冲突版本、配额与事务回滚', { skip: !process.env.KB_TEST_DATABASE_URL }, async () => {
  assert.equal(process.env.DATABASE_URL,process.env.KB_TEST_DATABASE_URL);assert.ok(new URL(process.env.KB_TEST_DATABASE_URL!).pathname.endsWith('_test'));
  const id={user:randomUUID(),ws:randomUUID(),nb:randomUUID()},token=randomUUID(),suffix=token.replaceAll('-','');
  const app=new Hono();app.onError(onError);app.route('/api/v1',fileRoutes);
  const call=async(endpoint:string,files:Array<{path:string;bytes:Buffer}>,options:Record<string,unknown>={},fingerprint?:string)=>{
    const form=new FormData();for(const file of files)form.append('files',new File([new Uint8Array(file.bytes)],file.path.split('/').at(-1)!));
    form.set('paths',JSON.stringify(files.map(f=>f.path)));form.set('options',JSON.stringify({mode:'rename',createFolders:true,source:'auto',...options}));if(fingerprint)form.set('fingerprint',fingerprint);
    const response=await app.request(`http://test/api/v1/notebooks/${id.nb}/${endpoint}`,{method:'POST',headers:{cookie:`kb_session=${token}`},body:form});
    return{status:response.status,json:await response.json() as { data:ReturnType<typeof migrationPreview>&Awaited<ReturnType<typeof executeMigration>>; error?:{message:string} }};
  };
  const importedIds=async()=> (await db.select({id:notes.id}).from(notes).where(eq(notes.workspaceId,id.ws))).map(n=>n.id);
  const archive=[{path:'合成 Notion.zip',bytes:notionExportFixture()}];
  let faultFunction=false;
  try{
    await db.insert(users).values({id:id.user,email:`migration-${suffix}@example.invalid`,handle:`m${suffix.slice(0,20)}`,displayName:'合成迁移验收',passwordHash:'test-only',storageQuotaBytes:10*1024*1024});
    await db.insert(workspaces).values({id:id.ws,slug:`migration-${suffix}`,name:'合成验收',ownerId:id.user,kind:'normal'});
    await db.insert(workspaceMembers).values({workspaceId:id.ws,userId:id.user,role:'owner'});
    await db.insert(notebooks).values({id:id.nb,workspaceId:id.ws,slug:'migration',title:'迁移',createdBy:id.user});
    await db.insert(sessions).values({userId:id.user,tokenHash:hashToken(token),expiresAt:new Date(Date.now()+60_000)});
    const unauthenticated=await app.request(`http://test/api/v1/notebooks/${id.nb}/import-files-preview`,{method:'POST'});assert.equal(unauthenticated.status,401);
    const preview=await call('import-files-preview',archive);assert.equal(preview.status,200,JSON.stringify(preview.json));assert.equal(preview.json.data.items.length,57);
    assert.equal((await importedIds()).length,0);assert.equal((await db.select().from(folders).where(eq(folders.workspaceId,id.ws))).length,0);assert.equal((await db.select().from(attachments).where(eq(attachments.workspaceId,id.ws))).length,0);
    const badConfirm=await call('import-files',archive,{},'stale');assert.equal(badConfirm.status,409);assert.equal((await importedIds()).length,0);
    const imported=await call('import-files',archive,{},preview.json.data.fingerprint);assert.equal(imported.status,201,JSON.stringify(imported.json));assert.equal(imported.json.data.created.length,57,JSON.stringify(imported.json.data.report.filter((r:{status:string})=>r.status==='failed')));
    const importedNotes=await db.select().from(notes).where(eq(notes.workspaceId,id.ws));assert.equal(importedNotes.length,57);assert.ok(importedNotes.every(n=>!/[a-f\d]{32}/i.test(n.title)));
    const allAttachments=await db.select().from(attachments).where(eq(attachments.workspaceId,id.ws));assert.equal(allAttachments.length,110);
    const images=allAttachments.filter(a=>a.mime==='image/png');assert.equal(images.length,55);assert.equal(new Set(images.map(a=>a.storedName)).size,1);
    const [blob]=await db.select().from(blobStore).where(eq(blobStore.sha256,hashBytes(FIXTURE_PNG)));assert.ok(blob.refcount>=55);
    const imageResponse=await app.request(`http://test/api/v1/attachments/${images[0]!.id}`,{headers:{cookie:`kb_session=${token}`}});assert.equal(imageResponse.status,200);assert.equal(imageResponse.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()),FIXTURE_PNG);
    const skipPreview=await call('import-files-preview',archive,{mode:'skip'});assert.equal(skipPreview.json.data.summary.skip,57);
    const skipped=await call('import-files',archive,{mode:'skip'},skipPreview.json.data.fingerprint);assert.equal(skipped.json.data.skipped.length,57);assert.equal((await importedIds()).length,57);
    assert.equal((await db.select().from(attachments).where(eq(attachments.workspaceId,id.ws))).length,110);
    const decoded=readMigrationZip(archive[0]!.bytes),sourcePage=decoded.find(f=>f.path.includes('页面 01 '))!;
    const sameSource=[sourcePage,...decoded.filter(f=>f.path.startsWith('assets/'))];
    const old=importedNotes.find(n=>n.title==='页面 01')!;
    const overwritePreview=await call('import-files-preview',sameSource,{mode:'overwrite'});assert.equal(overwritePreview.json.data.summary.overwrite,1);
    const overwrite=await call('import-files',sameSource,{mode:'overwrite'},overwritePreview.json.data.fingerprint);assert.equal(overwrite.json.data.overwritten.length,1,JSON.stringify(overwrite.json));
    assert.equal((await db.select().from(attachments).where(eq(attachments.noteId,old.id))).length,2);
    const changed=[{...sourcePage,bytes:Buffer.from(sourcePage.bytes.toString()+'\n新增正文')},...sameSource.slice(1)];
    const changedPreview=await call('import-files-preview',changed,{mode:'overwrite'});const changedResult=await call('import-files',changed,{mode:'overwrite'},changedPreview.json.data.fingerprint);assert.equal(changedResult.json.data.overwritten.length,1);
    const versions=await db.select().from(noteVersions).where(eq(noteVersions.noteId,old.id));assert.ok(versions.some(v=>v.bodyMd===old.bodyMd));assert.ok(versions.some(v=>v.bodyMd.includes('新增正文')));
    const stalePreview=await call('import-files-preview',changed,{mode:'overwrite'});await db.update(notes).set({version:3,bodyMd:'别人最新编辑'}).where(eq(notes.id,old.id));
    const stale=await call('import-files',changed,{mode:'overwrite'},stalePreview.json.data.fingerprint);assert.equal(stale.status,409);
    assert.equal((await db.select().from(notes).where(eq(notes.id,old.id)))[0]!.bodyMd,'别人最新编辑');
    const renamePreview=await call('import-files-preview',sameSource,{mode:'rename'});assert.equal(renamePreview.json.data.items[0].title,'页面 01 2');
    const rename=await call('import-files',sameSource,{mode:'rename'},renamePreview.json.data.fingerprint);assert.equal(rename.json.data.created.length,1);
    const usage=await userStorage(id.user);assert.ok(usage.attachmentBytes>=110*FIXTURE_PNG.length/2);
    await db.update(users).set({storageQuotaBytes:usage.usedBytes+20}).where(eq(users.id,id.user));
    const tooLarge=[{path:'不应残留/超额.md',bytes:Buffer.from('大正文'.repeat(1000))}];const quotaPreview=await call('import-files-preview',tooLarge);const quota=await call('import-files',tooLarge,{},quotaPreview.json.data.fingerprint);
    assert.equal(quota.json.data.created.length,0);assert.equal(quota.json.data.report[0].status,'failed');assert.match(quota.json.data.report[0].message,/存储空间不足/);
    assert.equal((await db.select().from(folders).where(and(eq(folders.workspaceId,id.ws),eq(folders.title,'不应残留')))).length,0);
    await db.update(users).set({storageQuotaBytes:10*1024*1024}).where(eq(users.id,id.user));
    await db.execute(query.raw(`CREATE FUNCTION migration_fail_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id = '${id.ws}' AND NEW.filename = 'fail.txt' THEN RAISE EXCEPTION 'synthetic attachment failure'; END IF; RETURN NEW; END $$`));faultFunction=true;
    await db.execute(query.raw(`CREATE TRIGGER migration_fail_${suffix} BEFORE INSERT ON attachments FOR EACH ROW EXECUTE FUNCTION migration_fail_${suffix}()`));
    const faultBytes=Buffer.from(`synthetic rollback ${suffix}`),fault=[{path:'事务回滚/坏页.md',bytes:Buffer.from('[附件](fail.txt)')},{path:'事务回滚/fail.txt',bytes:faultBytes},{path:'好页.md',bytes:Buffer.from('另一篇应当成功')}];
    const faultPreview=await call('import-files-preview',fault);const failed=await call('import-files',fault,{},faultPreview.json.data.fingerprint);
    assert.equal(failed.json.data.created.length,1);assert.ok(failed.json.data.report.some((r:{path:string;status:string})=>r.path==='事务回滚/坏页.md'&&r.status==='failed'));
    assert.equal((await db.select().from(blobStore).where(eq(blobStore.sha256,hashBytes(faultBytes)))).length,0);
    assert.equal(await stat(join(env.dataDir,blobRelPath(hashBytes(faultBytes)))).then(()=>true,()=>false),false,'回滚的唯一哈希不能留在磁盘');
    assert.equal((await db.select().from(folders).where(and(eq(folders.workspaceId,id.ws),eq(folders.title,'事务回滚')))).length,0);
    assert.equal((await db.select().from(notes).where(and(eq(notes.workspaceId,id.ws),eq(notes.title,'坏页')))).length,0);
    // 反复唯一内容失败、且失败发生在后一个附件：先落盘的文件也必须被清理。
    for(let iteration=0;iteration<4;iteration++){
      const later=Buffer.from(`fail later ${suffix} ${iteration}`);
      let earlier=Buffer.from('');
      for(let candidate=0;candidate<10000;candidate++){earlier=Buffer.from(`first ${suffix} ${iteration} ${candidate}`);if(hashBytes(earlier)<hashBytes(later))break;}
      assert.ok(hashBytes(earlier)<hashBytes(later));
      const payload=[{path:`回滚-${iteration}.md`,bytes:Buffer.from('[先写](first.txt) [后失败](fail.txt)')},{path:'first.txt',bytes:earlier},{path:'fail.txt',bytes:later}];
      const pre=await call('import-files-preview',payload);const result=await call('import-files',payload,{},pre.json.data.fingerprint);
      assert.equal(result.json.data.created.length,0);
      for(const bytes of [earlier,later]){
        assert.equal((await db.select().from(blobStore).where(eq(blobStore.sha256,hashBytes(bytes)))).length,0);
        assert.equal(await stat(join(env.dataDir,blobRelPath(hashBytes(bytes)))).then(()=>true,()=>false),false,'每次失败都应归还物理磁盘占用');
      }
    }
    // 回滚释放哈希锁后，清理与另一个成功上传者竞争同一哈希；不能删掉胜出的引用。
    const racingBytes=Buffer.from(`concurrent committed hash ${suffix}`),racingSha=hashBytes(racingBytes);
    let written!:()=>void,finish!:()=>void;
    const isWritten=new Promise<void>(resolve=>{written=resolve;}),canFinish=new Promise<void>(resolve=>{finish=resolve;});
    const failingTransaction=db.transaction(async tx=>{await putBlob(racingBytes,tx);written();await canFinish;throw new Error('intentional rollback');});
    const rolledBack=assert.rejects(failingTransaction,/intentional rollback/);
    await isWritten;
    const successfulUpload=putBlob(racingBytes);
    finish();await rolledBack;
    await Promise.all([successfulUpload,cleanupUnreferencedBlob(racingSha)]);
    assert.equal((await db.select().from(blobStore).where(eq(blobStore.sha256,racingSha)))[0]!.refcount,1);
    assert.deepEqual(await readFile(join(env.dataDir,blobRelPath(racingSha))),racingBytes);
    await releaseBlob(racingSha);
    // refcount=0 墓碑不能被 retain 复活；模拟物理回收后、删墓碑前进程退出。
    await putBlob(racingBytes);
    await db.update(blobStore).set({refcount:0}).where(eq(blobStore.sha256,racingSha));
    await rm(join(env.dataDir,blobRelPath(racingSha)),{force:true});
    assert.equal(await retainBlob(racingSha),false);
    await putBlob(racingBytes);
    assert.deepEqual(await readFile(join(env.dataDir,blobRelPath(racingSha))),racingBytes);
    await releaseBlob(racingSha);
    const otherFormats=[{path:'word.docx',bytes:wordExportFixture()},{path:'文章.html',bytes:Buffer.from('<title>文章</title><h1>你好</h1><script>bad()</script><p>导入正文</p>')}];
    const otherPreview=await call('import-files-preview',otherFormats);const other=await call('import-files',otherFormats,{},otherPreview.json.data.fingerprint);assert.equal(other.json.data.created.length,2,JSON.stringify(other.json));
    const rootNote=importedNotes.find(n=>n.title==='合成知识库')!;
    const rootLinks=await db.select().from(links).where(eq(links.fromNoteId,rootNote.id));assert.ok(rootLinks.some(link=>link.targetNoteId===old.id&&link.state==='resolved'));
    const nested=[{path:'新目录/好页.md',bytes:Buffer.from('根目录的同名不应影响新目录')}];const nestedPreview=await call('import-files-preview',nested);assert.equal(nestedPreview.json.data.items[0]!.action,'create');
    const twins=[{path:'甲.md',bytes:Buffer.from('---\ntitle: 同批同名\n---\n第一篇')},{path:'乙.md',bytes:Buffer.from('---\ntitle: 同批同名\n---\n第二篇')}];
    const twinsPreview=await call('import-files-preview',twins,{mode:'overwrite'});const twinsResult=await call('import-files',twins,{mode:'overwrite'},twinsPreview.json.data.fingerprint);
    assert.equal(twinsResult.json.data.created.length,1);assert.equal(twinsResult.json.data.overwritten.length,1);assert.equal(twinsResult.json.data.created[0]!.id,twinsResult.json.data.overwritten[0]!.id);
    const [twin]=await db.select().from(notes).where(eq(notes.id,twinsResult.json.data.created[0]!.id));assert.equal(twin!.bodyMd,'第二篇');
    const collisions=[{path:'附件碰撞.md',bytes:Buffer.from('[A](a/file.txt) [B](b/file.txt) [C](c/file.txt)')},{path:'a/file.txt',bytes:Buffer.from('内容 A')},{path:'b/file.txt',bytes:Buffer.from('内容 B')},{path:'c/file.txt',bytes:Buffer.from('内容 B')}];
    const collisionPreview=await call('import-files-preview',collisions);const collisionResult=await call('import-files',collisions,{},collisionPreview.json.data.fingerprint);assert.equal(collisionResult.json.data.created.length,1);
    const collisionId=collisionResult.json.data.created[0]!.id;const collisionAssets=()=>db.select().from(attachments).where(eq(attachments.noteId,collisionId));assert.equal((await collisionAssets()).length,2);
    const collisionOverwrite=await call('import-files-preview',collisions,{mode:'overwrite'});const collisionAgain=await call('import-files',collisions,{mode:'overwrite'},collisionOverwrite.json.data.fingerprint);assert.equal(collisionAgain.json.data.overwritten.length,1);assert.equal((await collisionAssets()).length,2);
    const concurrent=await Promise.all(Array.from({length:12},async(_,i)=>{
      const payload=[{path:`并发-${i}.md`,bytes:Buffer.from(`并发正文 ${i} [附件](并发.txt)`)},{path:'并发.txt',bytes:Buffer.from('共享并发附件')}];
      const preview=await call('import-files-preview',payload);return{payload,fingerprint:preview.json.data.fingerprint};
    }));
    const concurrentResults=await Promise.race([
      Promise.all(concurrent.map(({payload,fingerprint})=>call('import-files',payload,{},fingerprint))),
      new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('12个并发导入不应耗尽连接池')),10000);timer.unref();}),
    ]);
    assert.ok(concurrentResults.every(r=>r.json.data.created.length===1));
    const [sharedBlob]=await db.select().from(blobStore).where(eq(blobStore.sha256,hashBytes(Buffer.from('共享并发附件'))));assert.equal(sharedBlob!.refcount,12);
    // putBlob 写盘失败时，已经登记的引用要被补偿释放。
    let diskData=Buffer.from('');let prefix='';
    for(let n=0;n<1000;n++){diskData=Buffer.from(`disk failure ${suffix} ${n}`);prefix=join(env.dataDir,'blobs',hashBytes(diskData).slice(0,2));if(!await stat(prefix).then(()=>true,()=>false))break;}
    await mkdir(join(env.dataDir,'blobs'),{recursive:true});await writeFile(prefix,'not a directory');
    try{await assert.rejects(putBlob(diskData));assert.equal((await db.select().from(blobStore).where(eq(blobStore.sha256,hashBytes(diskData)))).length,0);}finally{await rm(prefix,{force:true});}
    const diskImage=await readFile(join(env.dataDir,images[0]!.storedName));assert.deepEqual(diskImage,FIXTURE_PNG);
    // 安全失败的 ZIP 在确认前拒绝，不会影响已成功数据。
    const traversal=await call('import-files-preview',[{path:'bad.zip',bytes:makeZip([{path:'../escape.md',data:Buffer.from('bad')}])}]);assert.equal(traversal.status,422);
  }finally{
    if(faultFunction){await db.execute(query.raw(`DROP TRIGGER IF EXISTS migration_fail_${suffix} ON attachments`));await db.execute(query.raw(`DROP FUNCTION IF EXISTS migration_fail_${suffix}()`));}
    const ids=await importedIds();
    const assets=await db.select().from(attachments).where(eq(attachments.workspaceId,id.ws));await db.delete(attachments).where(eq(attachments.workspaceId,id.ws));for(const asset of assets)await releaseBlob(asset.sha256);
    if(ids.length){await db.delete(links).where(inArray(links.fromNoteId,ids));await db.delete(noteVersions).where(inArray(noteVersions.noteId,ids));await db.delete(backgroundJobs).where(query`${backgroundJobs.payload}->>'noteId' in (${query.join(ids.map(noteId=>query`${noteId}`),query`,`)})`);}
    await db.delete(notes).where(eq(notes.workspaceId,id.ws));await db.delete(folders).where(eq(folders.workspaceId,id.ws));await db.delete(notebooks).where(eq(notebooks.id,id.nb));await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId,id.ws));await db.delete(workspaces).where(eq(workspaces.id,id.ws));await db.delete(sessions).where(eq(sessions.userId,id.user));await db.delete(users).where(eq(users.id,id.user));await rm(join(env.dataDir,'workspaces',id.ws),{recursive:true,force:true});await sql.end();
  }
});
