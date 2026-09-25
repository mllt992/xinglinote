import { and,asc,desc,eq,inArray,lte,lt,or,sql } from "drizzle-orm";
import { db } from "../../api/src/db/client.ts";
import { aiChunks,aiUsage,attachments,backupRestoreRuns,backupRuns,backupTargets,auditLogs,authTokens,backgroundJobs,calendarFeedTokens,comments,calendarItems,calendarOverrides,calendarReminders,calendarSubscriptions,calendarTemplates,folders,mcpTokens,notebookMembers,notebooks,notes,notifications,posts,pushSubscriptions,savedShares,sessions,shareLinks,users,workspaceInvites,workspaceMembers,workspaces } from "../../api/src/db/schema.ts";
import { nextOccurrence,reminderFireAt,rescheduleReminders,syncNoteTasks } from "../../api/src/lib/calendar.ts";
import { pushToUser } from "../../api/src/lib/push.ts";
import { syncSubscription } from "../../api/src/lib/ics.ts";
import { sendMail } from "../../api/src/lib/mail.ts";
import { env } from "../../api/src/env.ts";
import { aiEmbeddingProvider,embed,vector } from "../../api/src/lib/ai.ts";
import { noteIndexPieces } from "../../api/src/lib/ai-index-content.ts";
import { backupDue, executeBackupRun } from "../../api/src/lib/backup.ts";
import { upload,remove } from "../../api/src/lib/backup-transfer.ts";
import { open } from "../../api/src/lib/secrets.ts";
import { pruneNoteVersions } from "../../api/src/lib/versions.ts";
import { purgeNotes, purgeWorkspaceProjects } from "../../api/src/lib/trash.ts";
import { pruneBoardVersions, purgeTrashedBoards } from "../../api/src/lib/mindmaps.ts";
import { dropWorkspaceFromMcpTokens } from "../../api/src/lib/mcp-workspaces.ts";
import { dropWorkspaceFromAiProviders } from "../../api/src/lib/ai-provider-workspaces.ts";
import { enqueueIndexNote, shouldRunIndexNoteJob } from "../../api/src/lib/ai-index.ts";
import { extractPdfText } from "../../api/src/lib/pdf-text.ts";
import { readStoredFile, releaseBlob, releaseStoredFile } from "../../api/src/lib/blobs.ts";
import { applyModeration } from "../../api/src/lib/moderation.ts";
import { executeAgentReply } from "../../api/src/lib/agents.ts";
import { cleanupExpiredMcpUploads } from "../../api/src/lib/mcp-upload.ts";
import { AppError } from "@kb/shared";
function shouldRetry(e:unknown){
  const msg=e instanceof Error?e.message:String(e);
  if(/实例关了 AI|智能体已停用|密文解不开|模型没有返回文字|找不到这个模型|请检查 Key/.test(msg))return false;
  if(e instanceof AppError&&e.status>=400&&e.status<500&&e.status!==429)return false;
  const code=/\((\d{3})\)/.exec(msg)?.[1];
  if(code&&["400","401","403","404","422"].includes(code))return false;
  return true;
}
const interval=Number(process.env.WORKER_INTERVAL_MS??5000); // durable worker cadence
async function restoring(workspaceId:string|null){const active=inArray(backupRestoreRuns.status,["restoring","verifying"]);const rows=workspaceId?await db.select({id:backupRestoreRuns.id}).from(backupRestoreRuns).where(and(eq(backupRestoreRuns.workspaceId,workspaceId),active)).limit(1):await db.select({id:backupRestoreRuns.id}).from(backupRestoreRuns).where(and(sql`${backupRestoreRuns.workspaceId} IS NULL`,active)).limit(1);return rows.length>0;}
async function claim(){return db.transaction(async tx=>{const[job]=await tx.select().from(backgroundJobs).where(and(or(eq(backgroundJobs.status,"pending"),and(eq(backgroundJobs.status,"running"),lt(backgroundJobs.lockedAt,new Date(Date.now()-300000)))),lte(backgroundJobs.runAfter,new Date()))).orderBy(asc(backgroundJobs.createdAt)).limit(1).for("update",{skipLocked:true});if(!job)return null;const[claimed]=await tx.update(backgroundJobs).set({status:"running",lockedAt:new Date(),attempts:job.attempts+1}).where(eq(backgroundJobs.id,job.id)).returning();return claimed;});}
async function execute(job:typeof backgroundJobs.$inferSelect){
  if(job.type==="extract_pdf"){const[a]=await db.select().from(attachments).where(eq(attachments.id,(job.payload as {attachmentId:string}).attachmentId));if(!a)return;
  try{const bytes=await readStoredFile(a);const text=await extractPdfText(new Uint8Array(bytes));
   await db.update(attachments).set({extractedText:text||null,extractStatus:text?"ok":"failed"}).where(eq(attachments.id,a.id));
   if(text)await enqueueIndexNote(db,a.noteId);}
  catch{await db.update(attachments).set({extractStatus:"failed"}).where(eq(attachments.id,a.id));}   // 抽不出来就只留文件
  return;}
 if(job.type==="prune_versions"){await pruneNoteVersions();await pruneBoardVersions();return;}
 if(job.type==="purge_trash"){
   const cutoff=new Date(Date.now()-30*86400000);
   // 单独被删掉的附件（笔记还在）
   const orphanFiles=await db.select().from(attachments).where(lt(attachments.trashedAt,cutoff));
   for(const a of orphanFiles){await releaseStoredFile(a);await db.delete(attachments).where(eq(attachments.id,a.id));}
   // 笔记走 purgeNotes 这唯一一个入口，别在这儿再抄一份删表清单
   const oldNotes=await db.select({id:notes.id}).from(notes).where(lt(notes.trashedAt,cutoff));
   await purgeNotes(oldNotes.map(n=>n.id));
   // 思维导图 / 画板（设计 25）：版本与关联随外键级联
   await purgeTrashedBoards(cutoff);
   return;}
 if(job.type==="cleanup_tokens"){await db.delete(authTokens).where(lt(authTokens.expiresAt,new Date(Date.now()-86400000)));return;}
 if(job.type==="cleanup_mcp_uploads"){await cleanupExpiredMcpUploads();await db.insert(backgroundJobs).values({type:"cleanup_mcp_uploads",payload:{},runAfter:new Date(Date.now()+15*60000)});return;}
 if(job.type==="expire_shares"){await db.update(shareLinks).set({status:"expired"}).where(and(eq(shareLinks.status,"active"),lt(shareLinks.expiresAt,new Date())));await db.delete(savedShares).where(and(eq(savedShares.status,"dismissed"),lt(savedShares.dismissedAt,new Date(Date.now()-180*86400000))));return;}
 if(job.type==="test_backup_target"){const targetId=String((job.payload as {targetId?:string}).targetId??''),[t]=await db.select().from(backupTargets).where(eq(backupTargets.id,targetId));if(!t)throw new Error('backup target missing');const credentials=JSON.parse(open(t.credentials)),path=`connection-test-${crypto.randomUUID()}.txt`;await upload(t,credentials,path,Buffer.from('knowledge backup target test'));await remove(t,credentials,path);return;}
  if(job.type==="backup_workspace"||job.type==="backup_instance"||job.type==="backup_run"){const{targetId,runId}=job.payload as {targetId:string;runId:string};const[t]=await db.select().from(backupTargets).where(eq(backupTargets.id,targetId));if(!t)throw new Error('backup target missing');await executeBackupRun(t,runId);return;}
 if(job.type==="index_note"){const payload=job.payload as {noteId?:string;force?:boolean;includeExcluded?:boolean},noteId=String(payload.noteId??"");const[n]=await db.select().from(notes).where(eq(notes.id,noteId));if(!n||(!n.aiIndex&&!payload.includeExcluded)||n.trashedAt){await db.delete(aiChunks).where(eq(aiChunks.noteId,noteId));return;}if(await restoring(n.workspaceId))throw new Error("workspace restore in progress");const p=await aiEmbeddingProvider(n.workspaceId);if(!shouldRunIndexNoteJob({embeddingModel:p?.embeddingModel,autoEmbed:p?.autoEmbed,force:payload.force}))return;   /* 自动任务遵守开关；设置页手动重建带 force，关闭自动更新时仍要执行。 */const pieces=await noteIndexPieces(n),vectors=await embed(p!,pieces.map(x=>x.input));if(vectors.length!==pieces.length)throw new Error("embedding result count mismatch");await db.transaction(async tx=>{await tx.delete(aiChunks).where(eq(aiChunks.noteId,n.id));for(let i=0;i<pieces.length;i++)await tx.insert(aiChunks).values({noteId:n.id,workspaceId:n.workspaceId,notebookId:n.notebookId,chunkIndex:i,content:pieces[i]!.content,embedding:vector(vectors[i]!)});});return;}
 if(job.type==="delete_workspace"){
   const workspaceId=String((job.payload as {workspaceId?:string}).workspaceId??"");
   const[ws]=await db.select().from(workspaces).where(eq(workspaces.id,workspaceId));
   if(!ws||ws.kind==="personal"||!ws.deletionScheduledAt||ws.deletionScheduledAt.getTime()>Date.now())return;
   const ns=await db.select({id:notes.id}).from(notes).where(eq(notes.workspaceId,workspaceId));
   await purgeNotes(ns.map(n=>n.id));
   await purgeWorkspaceProjects(workspaceId);
   const nbs=await db.select({id:notebooks.id}).from(notebooks).where(eq(notebooks.workspaceId,workspaceId));
   const items=await db.select({id:calendarItems.id}).from(calendarItems).where(eq(calendarItems.workspaceId,workspaceId));
   const targets=await db.select({id:backupTargets.id}).from(backupTargets).where(eq(backupTargets.workspaceId,workspaceId));
   await db.transaction(async tx=>{
     if(nbs.length)await tx.delete(notebookMembers).where(inArray(notebookMembers.notebookId,nbs.map(nb=>nb.id)));
     // 这几张表以前是漏掉的，工作区删完还留着一堆孤儿行
     if(items.length){
       await tx.delete(calendarReminders).where(inArray(calendarReminders.itemId,items.map(i=>i.id)));
       await tx.delete(calendarOverrides).where(inArray(calendarOverrides.itemId,items.map(i=>i.id)));
     }
     await tx.delete(calendarItems).where(eq(calendarItems.workspaceId,workspaceId));
     await tx.delete(calendarTemplates).where(eq(calendarTemplates.workspaceId,workspaceId));
     await tx.delete(calendarFeedTokens).where(eq(calendarFeedTokens.workspaceId,workspaceId));
     await tx.delete(calendarSubscriptions).where(eq(calendarSubscriptions.workspaceId,workspaceId));
     if(targets.length)await tx.delete(backupRuns).where(inArray(backupRuns.targetId,targets.map(t=>t.id)));
     await tx.delete(backupRuns).where(eq(backupRuns.workspaceId,workspaceId));
     await tx.delete(backupTargets).where(eq(backupTargets.workspaceId,workspaceId));
     await tx.delete(auditLogs).where(eq(auditLogs.workspaceId,workspaceId));
     await tx.delete(folders).where(eq(folders.workspaceId,workspaceId));
     await tx.delete(notebooks).where(eq(notebooks.workspaceId,workspaceId));
     await tx.delete(shareLinks).where(eq(shareLinks.workspaceId,workspaceId));
     await dropWorkspaceFromMcpTokens(tx,{workspaceId,empty:"delete"});
     await dropWorkspaceFromAiProviders(tx,workspaceId);
     await tx.delete(aiUsage).where(eq(aiUsage.workspaceId,workspaceId));
     await tx.delete(workspaceInvites).where(eq(workspaceInvites.workspaceId,workspaceId));
     await tx.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId,workspaceId));
     await tx.update(posts).set({workspaceId:null,status:"deleted"}).where(eq(posts.workspaceId,workspaceId));
     await tx.delete(workspaces).where(eq(workspaces.id,workspaceId));
   });
   return;}
 if(job.type==="delete_user"){const userId=String((job.payload as {userId?:string}).userId??"");const[u]=await db.select().from(users).where(eq(users.id,userId));if(!u||u.status!=="pending_deletion"||!u.deletionScheduledAt||u.deletionScheduledAt.getTime()>Date.now())return;const[pws]=await db.select().from(workspaces).where(eq(workspaces.personalUserId,userId));await db.transaction(async tx=>{if(pws)await tx.update(notes).set({trashedAt:new Date()}).where(eq(notes.workspaceId,pws.id));await tx.update(posts).set({status:"deleted",updatedAt:new Date()}).where(eq(posts.authorUserId,userId));await tx.update(comments).set({authorUserId:null}).where(eq(comments.authorUserId,userId));await tx.update(mcpTokens).set({status:"revoked"}).where(eq(mcpTokens.userId,userId));await tx.delete(savedShares).where(eq(savedShares.userId,userId));await tx.delete(sessions).where(eq(sessions.userId,userId));await tx.update(users).set({status:"deleted",email:`deleted-${userId}@invalid.local`,displayName:"已注销用户",bio:null,avatarSha256:null,avatarMime:null,deletionScheduledAt:null,updatedAt:new Date()}).where(eq(users.id,userId));});if(u.avatarSha256)await releaseBlob(u.avatarSha256).catch(()=>{});return;}
 if(job.type==="sync_note_tasks"){await syncNoteTasks(String((job.payload as {noteId?:string}).noteId??""));return;}
 if(job.type==="calendar_reminder"){
   const{itemId,reminderId,occurrenceStart}=job.payload as {itemId?:string;reminderId?:string;occurrenceStart?:string|null};
   const[item]=await db.select().from(calendarItems).where(eq(calendarItems.id,String(itemId??"")));
   const[reminder]=await db.select().from(calendarReminders).where(eq(calendarReminders.id,String(reminderId??"")));
   if(!item||!reminder)return;if(await restoring(item.workspaceId))throw new Error("workspace restore in progress");
   // 条目已完成/取消/删除：不发，置 skipped
   if(item.trashedAt||item.status!=="open"){await db.update(calendarReminders).set({status:"skipped"}).where(eq(calendarReminders.id,reminder.id));return;}
   const occurrence=occurrenceStart?new Date(occurrenceStart):undefined;
   const fireAt=reminderFireAt(item,reminder,occurrence);
   // 条目改期后旧 job 会滞留，新 job 已入队：时间对不上就丢掉这条
   if(!fireAt||Math.abs(fireAt.getTime()-Date.now())>15*60000&&fireAt.getTime()>Date.now())return;
   // 同条目同渠道 10 分钟内只发一次，防 worker 重试轰炸
   if(reminder.firedAt&&Date.now()-reminder.firedAt.getTime()<600000)return;
   const target=item.assigneeUserId??item.createdBy;
   const when=new Intl.DateTimeFormat("zh-CN",{timeZone:item.timezone,dateStyle:"short",timeStyle:"short"}).format(occurrence??item.startsAt??item.dueAt??new Date());
   const href=`/w/${item.workspaceId}/calendar?item=${item.id}`;
   // 推送发不出去（实例没开、这人没设备、全掉线）就落回站内。提醒宁可重也不能凭空消失。
   if(reminder.channel==="push"){const r=await pushToUser(target,{title:`提醒：${item.title}`,body:when,href,tag:`calendar-${item.id}`});if(!r.sent)await db.insert(notifications).values({userId:target,type:"calendar_reminder",title:item.title,body:when,href});}
   else if(reminder.channel==="email"){const[u]=await db.select().from(users).where(eq(users.id,target));if(u?.email&&!u.email.endsWith("@invalid.local"))await sendMail(u.email,`提醒：${item.title}`,`${when}

${env.publicUrl}/w/${item.workspaceId}/calendar?item=${item.id}`);}
   else await db.insert(notifications).values({userId:target,type:"calendar_reminder",title:item.title,body:when,href});
   await db.update(calendarReminders).set({status:"fired",firedAt:new Date()}).where(eq(calendarReminders.id,reminder.id));
   // 重复条目：触发后才排下一个实例，避免往 jobs 表灌几千行
   if(item.rrule&&nextOccurrence(item,new Date(Date.now()+60000)))await rescheduleReminders(item.id);
   return;
 }
 if(job.type==="calendar_ics_sync"){
   const subscriptionId=String((job.payload as {subscriptionId?:string}).subscriptionId??"");
   if(subscriptionId){const[sub]=await db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.id,subscriptionId));if(sub&&await restoring(sub.workspaceId))throw new Error("workspace restore in progress");await syncSubscription(subscriptionId);return;}
   // 不带 id 的是定时轮询：只拉「距上次同步超过 30 分钟」的启用订阅（设计 16 §4.6）
   const subs=await db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.enabled,true));
   for(const s of subs){
     if(s.lastSyncAt&&Date.now()-s.lastSyncAt.getTime()<30*60000)continue;
     // 一个订阅炸了不能带走整批：各自记 last_error，继续拉下一个
     try{await syncSubscription(s.id);}catch{}
   }
   // 轮询自续：每轮结束排下一轮，schedule() 一天只跑一次，撑不起 30 分钟的节奏
   await db.insert(backgroundJobs).values({type:"calendar_ics_sync",payload:{},runAfter:new Date(Date.now()+30*60000)});
   return;
 }
 if(job.type==="calendar_rollover"){
   // 逾期不自动搬家，只把过期未触发的提醒收尾，避免重启后补发一整天的历史提醒
   // 失效的推送端点每天清一次：留一天是为了让人在设备列表里看见它挂了，再久就只是垃圾了
   await db.delete(pushSubscriptions).where(eq(pushSubscriptions.status,"gone"));
   const stale=await db.select().from(calendarReminders).where(eq(calendarReminders.status,"scheduled"));
   for(const r of stale){const[item]=await db.select().from(calendarItems).where(eq(calendarItems.id,r.itemId));if(!item||item.trashedAt||item.status!=="open"){await db.update(calendarReminders).set({status:"skipped"}).where(eq(calendarReminders.id,r.id));continue;}const at=reminderFireAt(item,r,nextOccurrence(item)??undefined);if(at&&at.getTime()<Date.now()-2*3600000)await db.update(calendarReminders).set({status:"skipped"}).where(eq(calendarReminders.id,r.id));}
   return;
 }
 if(job.type==="moderate_content"){
    const reviewId=String((job.payload as {reviewId?:string}).reviewId??"");
    await applyModeration(reviewId,{lastAttempt:job.attempts>=5});
    return;
  }
 if(job.type==="agent_reply"){
   await executeAgentReply(job.payload as {agentId:string;sourceType:"post"|"comment";sourceId:string;postId:string;parentCommentId:string|null});
   return;
 }
 throw new Error(`unknown job type: ${job.type}`);
}
const BATCH=10;                                        // 队列一堆积，一轮只干一件事会等好几小时，所以一轮抽一小批
async function tick(){for(let i=0;i<BATCH;i++)if(!await one())return;}
async function one(){const job=await claim();if(!job)return false;try{await execute(job);await db.update(backgroundJobs).set({status:"done",finishedAt:new Date(),lastError:null}).where(eq(backgroundJobs.id,job.id));}catch(e){const retry=job.attempts<5&&shouldRetry(e);await db.update(backgroundJobs).set({status:retry?"pending":"failed",runAfter:new Date(Date.now()+Math.min(3600000,1000*2**job.attempts)),lastError:e instanceof Error?e.message:String(e)}).where(eq(backgroundJobs.id,job.id));}
 return true;}
async function scheduleBackups(){
  const now=new Date();
  const instanceRestoring=await restoring(null);
  for(const t of await db.select().from(backupTargets).where(eq(backupTargets.enabled,true))){
    if(instanceRestoring||(t.workspaceId&&await restoring(t.workspaceId)))continue;
    const[latest]=await db.select({status:backupRuns.status,finishedAt:backupRuns.finishedAt}).from(backupRuns).where(eq(backupRuns.targetId,t.id)).orderBy(desc(backupRuns.createdAt)).limit(1);
    if(!backupDue({schedule:t.schedule,lastRunAt:t.lastRunAt,latest:latest??null},now))continue;
    const[r]=await db.insert(backupRuns).values({targetId:t.id,workspaceId:t.workspaceId}).returning();
    const type=t.scope==="instance"||!t.workspaceId?"backup_instance":"backup_workspace";
    await db.insert(backgroundJobs).values({type,payload:{targetId:t.id,runId:r.id}});
  }
}
async function schedule(){await scheduleBackups();for(const type of["purge_trash","cleanup_tokens","cleanup_mcp_uploads","expire_shares","prune_versions","calendar_rollover"]){const rows=await db.select().from(backgroundJobs).where(and(eq(backgroundJobs.type,type),or(eq(backgroundJobs.status,"pending"),eq(backgroundJobs.status,"running"))));if(!rows.length)await db.insert(backgroundJobs).values({type,payload:{},runAfter:new Date()});}
 // ICS 轮询自己续期，这里只负责点火：认「不带 subscriptionId」的那条才是轮询job，否则一条手动同步就能把轮询挡住
 const polls=await db.select().from(backgroundJobs).where(and(eq(backgroundJobs.type,"calendar_ics_sync"),or(eq(backgroundJobs.status,"pending"),eq(backgroundJobs.status,"running")),sql`payload->>'subscriptionId' IS NULL`));
 if(!polls.length)await db.insert(backgroundJobs).values({type:"calendar_ics_sync",payload:{},runAfter:new Date()});}
// 一轮没跑完就不排下一轮：备份、索引这类任务远超 interval，
// 重叠进来只会让并发无上限地堆（claim() 的 SKIP LOCKED 保证不会重复执行，
// 但拦不住连接数被吃光）。
let ticking = false;
async function safeTick(){
  if(ticking)return;
  ticking=true;
  try{await tick();}catch(e){console.error("tick failed:",e);}finally{ticking=false;}
}
console.log(`knowledge worker started (${interval}ms)`);
await schedule();
setInterval(()=>void safeTick(),interval);
setInterval(()=>void scheduleBackups().catch(e=>console.error("backup schedule failed:",e)),5*60*1000);
setInterval(()=>void schedule().catch(e=>console.error("schedule failed:",e)),86400000);
void safeTick();
