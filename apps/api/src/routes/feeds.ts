import { Hono } from "hono";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { fail, normalizeTitle } from "@kb/shared";
import { db } from "../db/client.ts";
import { auditLogs, instanceSettings, moderationReviews, notebooks, notes, noteVersions, postReactions, posts, users, workspaceMembers, workspaces } from "../db/schema.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";
import { memberRole } from "../lib/workspace.ts";
import { moderate, pendingMessage, recordReview } from "../lib/moderation.ts";
import { notebookAccess } from "../lib/notebook-access.ts";
import { parseWikiLinks, rebuildLinks } from "../lib/links.ts";
import { writeNoteFile } from "../lib/files.ts";
import { assertUserStorage, textBytes } from "../lib/quota.ts";
import { limit } from "../lib/rate-limit.ts";
export const feedRoutes=new Hono();
async function user(c:Parameters<typeof currentUser>[0]){const u=await currentUser(c);if(!u)throw fail("UNAUTHENTICATED","未登录");return u;}
/** 只有作者本人能在时间线里看到自己待审 / 被驳回的帖子，别人看不见。 */
function readable(viewer?:string){return viewer?or(eq(posts.status,"visible"),and(eq(posts.authorUserId,viewer),inArray(posts.status,["pending_review","rejected"]))):eq(posts.status,"visible");}
/**
 * 给一页动态补上作者、点赞数、关联笔记标题。
 *
 * 这三样以前是 `select * from users` + `select * from post_reactions` +
 * `select * from notes`（含全部正文）——而 `/feed/public` 是匿名可达的，
 * 一个 curl 循环就能把整库读进内存。现在一律按这一页涉及到的 id 取。
 */
async function hydrate(rows:typeof posts.$inferSelect[], viewer?:string){
  const pickIds=<T,>(ids:string[],run:(ids:string[])=>Promise<T[]>)=>ids.length?run(ids):Promise.resolve([] as T[]);
  const postIds=rows.map(p=>p.id);
  const authorIds=[...new Set(rows.map(p=>p.authorUserId).filter((x):x is string=>!!x))];
  const noteIds=[...new Set(rows.map(p=>p.noteId).filter((x):x is string=>!!x))];
  const [authors,reactions,ns]=await Promise.all([
    pickIds(authorIds,ids=>db.select({id:users.id,handle:users.handle,displayName:users.displayName}).from(users).where(inArray(users.id,ids))),
    pickIds(postIds,ids=>db.select({postId:postReactions.postId,userId:postReactions.userId,kind:postReactions.kind}).from(postReactions).where(inArray(postReactions.postId,ids))),
    pickIds(noteIds,ids=>db.select({id:notes.id,title:notes.title}).from(notes).where(inArray(notes.id,ids))),
  ]);
  const held=rows.filter(p=>p.status!=="visible").map(p=>p.id);const reviews=held.length?await db.select().from(moderationReviews).where(and(eq(moderationReviews.targetType,"post"),inArray(moderationReviews.targetId,held))).orderBy(desc(moderationReviews.createdAt)):[];return rows.map(p=>({id:p.id,status:p.status,moderationReason:p.status==="visible"?null:(()=>{const r=reviews.find(r=>r.targetId===p.id);return r?(r.reviewNote??r.aiReason??null):null;})(),body:p.body,visibility:p.visibility,workspaceId:p.workspaceId,createdAt:p.createdAt,author:(()=>{const a=authors.find(u=>u.id===p.authorUserId);return a?{handle:a.handle,displayName:a.displayName}:null;})(),note:p.noteId?(()=>{const n=ns.find(n=>n.id===p.noteId);return n?{id:n.id,title:n.title}:null})():null,likes:reactions.filter(r=>r.postId===p.id&&r.kind==="like").length,liked:!!viewer&&reactions.some(r=>r.postId===p.id&&r.userId===viewer&&r.kind==="like"),editedAt:p.editedAt,mine:!!viewer&&p.authorUserId===viewer}));}
feedRoutes.get("/feed/public",async c=>{const [settings]=await db.select().from(instanceSettings);if(!settings?.squareEnabled)throw fail("NOT_FOUND","广场已关闭");const viewer=await currentUser(c);const rows=await db.select().from(posts).where(and(eq(posts.visibility,"public"),readable(viewer?.id))).orderBy(desc(posts.createdAt)).limit(50);return ok(c,{posts:await hydrate(rows,viewer?.id)});});
feedRoutes.get("/feed/workspaces/:id",async c=>{const u=await user(c);const wsId=c.req.param("id");if(!(await memberRole(wsId,u.id)))throw fail("FORBIDDEN","不是工作区成员");const rows=await db.select().from(posts).where(and(eq(posts.workspaceId,wsId),readable(u.id))).orderBy(desc(posts.createdAt)).limit(50);return ok(c,{posts:await hydrate(rows,u.id)});});
feedRoutes.post("/posts",async c=>{const u=await user(c);const body=z.object({body:z.string().min(1).max(5000),visibility:z.enum(["public","workspace"]),workspaceId:z.string().uuid().nullable().optional(),noteId:z.string().uuid().nullable().optional()}).parse(await c.req.json());if(body.visibility==="workspace"){if(!body.workspaceId)throw fail("VALIDATION","缺少工作区");const role=await memberRole(body.workspaceId,u.id);if(!role||role==="viewer")throw fail("FORBIDDEN","无权发布工作区动态");const[ws]=await db.select().from(workspaces).where(eq(workspaces.id,body.workspaceId));if(ws?.frozen)throw fail("FORBIDDEN","工作区已冻结，暂时只读");}if(body.visibility==="public"&&body.workspaceId)throw fail("VALIDATION","公开动态不能指定工作区");if(body.noteId){const [n]=await db.select().from(notes).where(eq(notes.id,body.noteId));if(!n||n.trashedAt||!n.published)throw fail("VALIDATION","只能附加已发布笔记");if(body.visibility==="workspace"&&n.workspaceId!==body.workspaceId)throw fail("FORBIDDEN","不能附加其他工作区的笔记");if(body.visibility==="public"&&!(await memberRole(n.workspaceId,u.id)))throw fail("FORBIDDEN","不能附加无权访问的笔记");}const scope=body.visibility==="public"?"square":"circle";const verdict=await moderate(body.body,scope);const held=verdict.decision==="review";const [p]=await db.insert(posts).values({authorUserId:u.id,workspaceId:body.workspaceId,visibility:body.visibility,body:body.body,noteId:body.noteId,status:held?"pending_review":"visible"}).returning();await recordReview({targetType:"post",targetId:p.id,scope,workspaceId:p.workspaceId,authorUserId:u.id,snapshot:body.body,verdict});return ok(c,{...p,moderation:{held,message:held?pendingMessage(verdict):null}},201);});
feedRoutes.delete("/posts/:id",async c=>{const u=await user(c);const [p]=await db.select().from(posts).where(eq(posts.id,c.req.param("id")));if(!p)throw fail("NOT_FOUND","动态不存在");if(p.authorUserId!==u.id&&u.roleInstance!=="admin")throw fail("FORBIDDEN","无权删除");await db.update(posts).set({status:"deleted",updatedAt:new Date()}).where(eq(posts.id,p.id));return ok(c,{});});
feedRoutes.post("/posts/:id/like",async c=>{const u=await user(c);const postId=c.req.param("id");const [post]=await db.select().from(posts).where(eq(posts.id,postId));if(!post||post.status!=="visible")throw fail("NOT_FOUND","动态不存在");if(post.visibility==="workspace"&&(!post.workspaceId||!(await memberRole(post.workspaceId,u.id))))throw fail("FORBIDDEN","无权操作此动态");const existing=await db.select().from(postReactions).where(and(eq(postReactions.postId,postId),eq(postReactions.userId,u.id),eq(postReactions.kind,"like")));if(existing.length)await db.delete(postReactions).where(and(eq(postReactions.postId,postId),eq(postReactions.userId,u.id),eq(postReactions.kind,"like")));else await db.insert(postReactions).values({postId,userId:u.id,kind:"like"});return ok(c,{liked:!existing.length});});

// —— 泄漏检查、编辑、圈子转广场、转正为笔记、公开主页（规格 09）——

/** 公开可见 = 所在笔记本已发布成文档站，且这篇自己也 published。只有分享链接不算。 */
async function leakScan(body:string,viewerId:string){
  const titles=[...new Set(parseWikiLinks(body).map(l=>l.title))];
  if(!titles.length)return[];
  const mine=await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId,viewerId));
  if(!mine.length)return titles.map(title=>({title,publiclyVisible:false}));
  const rows=await db.select().from(notes).where(and(inArray(notes.workspaceId,mine.map(m=>m.workspaceId)),isNull(notes.trashedAt)));
  const books=await db.select().from(notebooks);
  return titles.map(title=>{
    const hit=rows.find(n=>normalizeTitle(n.title)===normalizeTitle(title));
    const nb=hit?books.find(b=>b.id===hit.notebookId):undefined;
    return{title,publiclyVisible:!!hit&&hit.published&&!!nb?.sitePublished&&!nb?.trashedAt};
  });
}
/** 发广场前把不公开的 [[链接]] 打回纯文本，避免把私密标题漏出去。 */
function stripLeaks(body:string,leaked:string[]){
  let out=body;
  for(const l of parseWikiLinks(body))if(leaked.includes(l.title))out=out.split(l.raw).join(l.display??l.title);
  return out;
}

feedRoutes.post("/posts/leak-check",async c=>{const u=await user(c);const b=z.object({body:z.string().max(5000)}).parse(await c.req.json());return ok(c,{links:await leakScan(b.body,u.id)});});

feedRoutes.patch("/posts/:id",async c=>{
  const u=await user(c);const[p]=await db.select().from(posts).where(eq(posts.id,c.req.param("id")));
  if(!p||p.status==="deleted")throw fail("NOT_FOUND","动态不存在");
  if(p.authorUserId!==u.id)throw fail("FORBIDDEN","只有作者能编辑");
  const b=z.object({body:z.string().min(1).max(5000)}).parse(await c.req.json());
  // 改完要重新过一遍审核，否则先发一句人畜无害的再编辑成违规内容就绕过去了。
  const scope=p.visibility==="public"?"square":"circle";const verdict=await moderate(b.body,scope);const held=verdict.decision==="review";
  const[saved]=await db.update(posts).set({body:b.body,status:held?"pending_review":"visible",editedAt:new Date(),updatedAt:new Date()}).where(eq(posts.id,p.id)).returning();
  await recordReview({targetType:"post",targetId:saved.id,scope,workspaceId:saved.workspaceId,authorUserId:u.id,snapshot:b.body,verdict});
  return ok(c,{id:saved.id,editedAt:saved.editedAt,status:saved.status,moderation:{held,message:held?pendingMessage(verdict):null}});
});

/** 圈子公开到广场是复制一条新的，圈子里那条不动。 */
feedRoutes.post("/posts/:id/publish-to-square",async c=>{
  const u=await user(c);const[p]=await db.select().from(posts).where(eq(posts.id,c.req.param("id")));
  if(!p||p.status!=="visible")throw fail("NOT_FOUND","动态不存在");
  if(p.visibility!=="workspace")throw fail("VALIDATION","这条已经是广场动态");
  if(p.authorUserId!==u.id)throw fail("FORBIDDEN","只有作者能公开自己的动态");
  const[settings]=await db.select().from(instanceSettings);
  if(!settings?.squareEnabled)throw fail("NOT_FOUND","广场已关闭");
  const scan=await leakScan(p.body,u.id);
  const leaked=scan.filter(x=>!x.publiclyVisible).map(x=>x.title);
  const b=z.object({confirmStripLinks:z.boolean().default(false)}).parse(await c.req.json().catch(()=>({})));
  if(leaked.length&&!b.confirmStripLinks)throw fail("VALIDATION",`这些链接对外看不到，确认后会写成纯文本：${leaked.join("、")}`);
  const text=stripLeaks(p.body,leaked);
  // 圈子可能没开审核而广场开了，所以复制到广场要按广场的规矩重审一次。
  const verdict=await moderate(text,"square");const held=verdict.decision==="review";
  const[copy]=await db.insert(posts).values({authorUserId:u.id,workspaceId:null,visibility:"public",body:text,noteId:null,status:held?"pending_review":"visible"}).returning();
  await recordReview({targetType:"post",targetId:copy.id,scope:"square",workspaceId:null,authorUserId:u.id,snapshot:text,verdict});
  return ok(c,{id:copy.id,strippedLinks:leaked,moderation:{held,message:held?pendingMessage(verdict):null}},201);
});

/** 转正：把一条动态存成笔记，文首留一句出处。 */
feedRoutes.post("/posts/:id/promote",async c=>{
  const u=await user(c);const[p]=await db.select().from(posts).where(eq(posts.id,c.req.param("id")));
  if(!p||p.status!=="visible")throw fail("NOT_FOUND","动态不存在");
  if(p.visibility==="workspace"&&(!p.workspaceId||!(await memberRole(p.workspaceId,u.id))))throw fail("FORBIDDEN","无权访问此动态");
  const b=z.object({notebookId:z.string().uuid(),folderId:z.string().uuid().nullish(),title:z.string().min(1).max(200).optional()}).parse(await c.req.json());
  const{notebook:nb,workspace:ws}=await notebookAccess(b.notebookId,u.id,"edit");
  const[author]=await db.select().from(users).where(eq(users.id,p.authorUserId));
  const title=(b.title??p.body.split("\n")[0].replace(/^#+\s*/,"").slice(0,60)).trim()||"未命名";
  const bodyMd=`> 来自${p.visibility==="public"?"广场":"圈子"}动态 · ${author?.displayName??"已注销用户"} · ${new Date(p.createdAt).toLocaleDateString("zh-CN")}\n\n${p.body}`;
  await assertUserStorage(u.id,textBytes(title,bodyMd));
  const[note]=await db.insert(notes).values({workspaceId:ws.id,notebookId:nb.id,folderId:b.folderId??null,title,bodyMd,aiIndex:nb.defaultAiIndex,createdBy:u.id,updatedBy:u.id}).returning();
  await db.insert(noteVersions).values({noteId:note.id,version:1,title:note.title,bodyMd:note.bodyMd,editorId:u.id,source:"import"});
  await writeNoteFile({...note,noteId:note.id});
  await rebuildLinks(note.id,note.workspaceId,note.bodyMd);
  await db.insert(auditLogs).values({userId:u.id,workspaceId:ws.id,actorType:"user",action:"post.promote",result:"ok",targetType:"note",targetId:note.id});
  return ok(c,{noteId:note.id,workspaceId:ws.id,title:note.title},201);
});

/** 公开主页：广场帖 + 已发布的文档站。封禁或注销的人直接 404。 */
feedRoutes.get("/public/users/:handle",async c=>{
  limit(`profile:${c.req.header("x-forwarded-for")??"local"}`,120,60000);
  const[person]=await db.select().from(users).where(eq(users.handle,c.req.param("handle").toLowerCase()));
  if(!person||person.status!=="active")throw fail("NOT_FOUND","用户不存在");
  const[settings]=await db.select().from(instanceSettings);
  const rows=settings?.squareEnabled?await db.select().from(posts).where(and(eq(posts.authorUserId,person.id),eq(posts.visibility,"public"),eq(posts.status,"visible"))).orderBy(desc(posts.createdAt)):[];
  const viewer=await currentUser(c);
  const books=await db.select().from(notebooks).where(and(eq(notebooks.createdBy,person.id),eq(notebooks.sitePublished,true),isNull(notebooks.trashedAt)));
  const spaces=await db.select().from(workspaces);
  return ok(c,{
    handle:person.handle,displayName:person.displayName,bio:person.bio,joinedAt:person.createdAt,
    posts:await hydrate(rows.slice(0,50),viewer?.id),
    sites:books.map(nb=>({title:nb.title,url:`/s/${spaces.find(w=>w.id===nb.workspaceId)?.slug}/${nb.slug}`})),
  });
});
