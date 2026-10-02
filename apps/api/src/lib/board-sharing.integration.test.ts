import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { db,sql } from '../db/client.ts';
import { users,workspaces,workspaceMembers,notebooks,notes,sessions,mindMaps,shareLinks } from '../db/schema.ts';
import { mindMapRoutes } from '../routes/mindmaps.ts';
import { shareRoutes } from '../routes/shares.ts';
import { hashSecret } from './tokens.ts';
import { onError } from '../http.ts';

test('公开画板投影：能力密码、原始源隔离、发布与版本生命周期', {skip:!process.env.KB_TEST_DATABASE_URL},async()=>{
 assert.equal(process.env.DATABASE_URL,process.env.KB_TEST_DATABASE_URL);assert.ok(new URL(process.env.KB_TEST_DATABASE_URL!).pathname.endsWith('_test'));
 const id={user:randomUUID(),editor:randomUUID(),ws:randomUUID(),nb:randomUUID(),pub:randomUUID(),private:randomUUID()};const token=randomUUID(),editorToken=randomUUID();
 try{
  await db.insert(users).values([id.user,id.editor].map(user=>({id:user,email:`${user}@example.invalid`,handle:`b${user.replaceAll('-','').slice(0,20)}`,displayName:'画板验收',passwordHash:'not-a-login'})));
  await db.insert(workspaces).values({id:id.ws,slug:`boards-${id.ws}`,name:'画板测试',kind:'normal',ownerId:id.user});
  await db.insert(workspaceMembers).values([{workspaceId:id.ws,userId:id.user,role:'owner'},{workspaceId:id.ws,userId:id.editor,role:'editor'}]);
  await db.insert(notebooks).values({id:id.nb,workspaceId:id.ws,slug:'boards',title:'图文站',createdBy:id.user,sitePublished:true});
  await db.insert(notes).values([{id:id.pub,workspaceId:id.ws,notebookId:id.nb,title:'公开来源',bodyMd:'公开',createdBy:id.user,updatedBy:id.user,published:true},{id:id.private,workspaceId:id.ws,notebookId:id.nb,title:'不能泄漏的私有来源',bodyMd:'私人正文',createdBy:id.user,updatedBy:id.user,published:false}]);
  await db.insert(sessions).values([{userId:id.user,tokenHash:hashSecret(token),expiresAt:new Date(Date.now()+60000)},{userId:id.editor,tokenHash:hashSecret(editorToken),expiresAt:new Date(Date.now()+60000)}]);
  const app=new Hono();app.onError(onError);app.route('/api/v1',mindMapRoutes);app.route('/api/v1',shareRoutes);
  const req=async(path:string,body?:unknown,method=body?'POST':'GET',credential:string|null=token)=>app.request(`http://local/api/v1${path}`,{method,headers:{...(credential?{cookie:`kb_session=${credential}`}:{ }),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const xml='<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="原始XML不可公开" vertex="1" parent="1"><mxGeometry x="-100000" y="100000" width="160" height="80" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>';
  const create=await req(`/notebooks/${id.nb}/mindmaps`,{kind:'drawio',title:'无限画板验收',data:{format:'drawio',xml,noteIds:[id.pub,id.private]}});
  assert.equal(create.status,201);const made=await create.json() as {data:{mindMap:{id:string;version:number}}};const board=made.data.mindMap;
  // 两个账号都有编辑权，旧账号的待保存内容仍不能借新会话提交。
  assert.equal((await req(`/mindmaps/${board.id}`,{expectedUserId:id.user,expectedVersion:1,title:'旧账号迟到保存'},'PATCH',editorToken)).status,403);
  const [unchanged]=await db.select().from(mindMaps).where(eq(mindMaps.id,board.id));
  assert.equal(unchanged.version,1);assert.equal(unchanged.title,'无限画板验收');
  const editable=await (await req(`/mindmaps/${board.id}`)).json() as {data:{mindMap:{data:{xml:string;noteIds:string[]}}}};
  assert.ok(editable.data.mindMap.data.xml.includes('x="-100000"'));assert.ok(editable.data.mindMap.data.xml.includes('y="100000"'));assert.deepEqual(editable.data.mindMap.data.noteIds,[id.pub,id.private]);
  const svg='<svg viewBox="0 0 300 100"><metadata>secret-source</metadata><rect width="300" height="100" fill="#fff"/><text x="10" y="40">只读可视节点</text><script>evil()</script><image href="https://private.invalid/pixel"/></svg>';
  assert.equal((await req(`/mindmaps/${board.id}/public-preview`,{expectedVersion:1,svg},'PUT')).status,200);
  const shared=await (await req(`/mindmaps/${board.id}/shares`,{password:'fixture-password'})).json() as {data:{id:string;token:string}};
  const url=`/public/shares/${shared.data.token}`;
  const locked=await (await req(url,undefined,'GET',null)).text();assert.ok(locked.includes('requiresPassword'));assert.ok(!locked.includes('无限画板'));
  const unlock=await req(`${url}/unlock`,{password:'fixture-password'});assert.equal(unlock.status,200);const cookie=unlock.headers.get('set-cookie')!.split(';')[0];
  const publicReq=()=>app.request(`http://local/api/v1${url}`,{headers:{cookie}});
  let response=await publicReq();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
  let raw=await response.text();for(const bad of ['原始XML不可公开','secret-source','evil()','private.invalid','不能泄漏',id.private])assert.ok(!raw.includes(bad),bad);assert.ok(raw.includes('公开来源'));
  await db.update(mindMaps).set({trashedAt:new Date()}).where(eq(mindMaps.id,board.id));assert.equal((await publicReq()).status,404);
  await db.update(mindMaps).set({trashedAt:null}).where(eq(mindMaps.id,board.id));assert.equal((await publicReq()).status,200);
  assert.equal((await req(`/mindmaps/${board.id}`,{expectedVersion:1,data:{format:'drawio',xml:xml.replace('原始XML不可公开','源已更新'),noteIds:[id.pub,id.private]}},'PATCH')).status,200);
  assert.equal((await publicReq()).status,404,'旧版本预览立即不可用');
  assert.equal((await req(`/mindmaps/${board.id}/public-preview`,{expectedVersion:1,svg},'PUT')).status,409);
  assert.equal((await req(`/mindmaps/${board.id}/public-preview`,{expectedVersion:2,svg},'PUT')).status,200);
  assert.equal((await req(`/mindmaps/${board.id}/publish`,{published:true},'POST',editorToken)).status,403);
  assert.equal((await req(`/mindmaps/${board.id}/publish`,{published:true})).status,200);
  const site=`/public/sites/boards-${id.ws}/boards`;
  assert.equal((await req(`${site}/boards/${board.id}`,undefined,'GET',null)).status,200);
  raw=await (await req(`${site}/notes/${id.pub}/boards`,undefined,'GET',null)).text();assert.ok(raw.includes(board.id));
  await db.update(notebooks).set({sitePublished:false}).where(eq(notebooks.id,id.nb));assert.equal((await req(`${site}/boards/${board.id}`,undefined,'GET',null)).status,404);assert.equal((await publicReq()).status,200,'站下线不撤销独立分享');
  await db.update(shareLinks).set({expiresAt:new Date(0)}).where(eq(shareLinks.id,shared.data.id));assert.equal((await publicReq()).status,404);
  await db.update(shareLinks).set({expiresAt:null,status:'revoked'}).where(and(eq(shareLinks.id,shared.data.id),eq(shareLinks.createdBy,id.user)));assert.equal((await publicReq()).status,404);
 }finally{
  try {
  const boards=await db.select({id:mindMaps.id}).from(mindMaps).where(eq(mindMaps.notebookId,id.nb));
  if(boards.length)await db.delete(shareLinks).where(inArray(shareLinks.targetId,boards.map(b=>b.id)));
  await db.delete(mindMaps).where(eq(mindMaps.notebookId,id.nb));await db.delete(notes).where(eq(notes.workspaceId,id.ws));await db.delete(notebooks).where(eq(notebooks.id,id.nb));await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId,id.ws));await db.delete(workspaces).where(eq(workspaces.id,id.ws));await db.delete(sessions).where(inArray(sessions.userId,[id.user,id.editor]));await db.delete(users).where(inArray(users.id,[id.user,id.editor]));
  }catch(e){console.error("fixture cleanup failed",e);throw e;}finally{await sql.end();}
 }
});
