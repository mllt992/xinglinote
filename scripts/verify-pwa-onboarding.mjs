// CI 真浏览器 + 合成数据库：PWA 离线阅读、弱网草稿、登出隔离与管理员首小时。
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { db, sql } from '../apps/api/src/db/client.ts';
import { users, workspaces, workspaceMembers, notebooks, notes, noteVersions, noteVisits, backgroundJobs, sessions } from '../apps/api/src/db/schema.ts';
import { hashSecret } from '../apps/api/src/lib/tokens.ts';
const { eq, inArray, sql: query } = createRequire(new URL('../apps/api/package.json', import.meta.url))('drizzle-orm');
assert.equal(process.env.DATABASE_URL,process.env.KB_TEST_DATABASE_URL);
assert.ok(process.env.KB_TEST_DATABASE_URL && new URL(process.env.KB_TEST_DATABASE_URL).pathname.endsWith('_test'));
const ids={user:randomUUID(),ws:randomUUID(),nb:randomUUID(),note:randomUUID()};
const token=randomBytes(32).toString('base64url'),suffix=randomUUID().slice(0,8),base='http://127.0.0.1:12099';
await db.insert(users).values({id:ids.user,email:`pwa-${suffix}@example.invalid`,handle:`pwa${suffix}`,displayName:'离线验收',passwordHash:'not-a-login',roleInstance:'admin'});
await db.insert(workspaces).values({id:ids.ws,slug:`pwa-${suffix}`,name:'离线验收',kind:'personal',personalUserId:ids.user,ownerId:ids.user});
await db.insert(workspaceMembers).values({workspaceId:ids.ws,userId:ids.user,role:'owner'});
await db.insert(notebooks).values({id:ids.nb,workspaceId:ids.ws,slug:'offline',title:'离线笔记本',createdBy:ids.user});
await db.insert(notes).values({id:ids.note,workspaceId:ids.ws,notebookId:ids.nb,title:'地铁上的星璃',bodyMd:'只读快照正文',createdBy:ids.user,updatedBy:ids.user});
await db.insert(sessions).values({userId:ids.user,tokenHash:hashSecret(token),expiresAt:new Date(Date.now()+3600000)});
const server=spawn(process.execPath,['--import','./apps/api/node_modules/tsx/dist/loader.mjs','apps/api/src/index.ts'],{env:{...process.env,PUBLIC_URL:base,API_PORT:'12099'},stdio:['ignore','ignore','pipe']});
const noteWriteTrace=[];
let failed=false,page,phase='startup';let errors='';server.stderr.on('data',d=>{errors+=d;});let browser;
try {
 let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/healthz')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,errors);
 browser=await chromium.launch({executablePath:process.env.KB_CHROMIUM_EXECUTABLE,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true});
 await context.addCookies([{name:'kb_session',value:token,url:base}]);
 context.on('request',request=>{if(request.url()!==`${base}/api/v1/notes/${ids.note}`||request.method()!=='PATCH')return;try{const body=request.postDataJSON();if(noteWriteTrace.length<30)noteWriteTrace.push({event:'request',title:body.title,expectedVersion:body.expectedVersion,force:body.force===true});}catch{}});
 context.on('response',response=>{if(response.url()===`${base}/api/v1/notes/${ids.note}`&&response.request().method()==='PATCH'&&noteWriteTrace.length<30)noteWriteTrace.push({event:'response',status:response.status()});});
 page=await context.newPage();await context.routeWebSocket('**/*',socket=>socket.close());
 phase='admin checklist';await page.goto(base+'/admin');await page.getByRole('heading',{name:'第一小时清单'}).waitFor();await page.getByRole('heading',{name:'实例健康检查'}).waitFor();
 assert.ok(await page.getByText('尚未开启备份',{exact:false}).count());
 await page.screenshot({path:'/tmp/xingli-pwa-admin-375.png',fullPage:true});
 phase='trusted device consent';await page.goto(base+'/settings/account');await page.getByRole('button',{name:'开启可信设备暂存',exact:true}).click();await page.getByRole('button',{name:'这是我的设备，开启',exact:true}).click();
 phase='read note snapshot';await page.goto(`${base}/w/${ids.ws}/n/${ids.note}`);
 await page.getByRole('textbox',{name:'笔记标题',exact:true}).waitFor();assert.equal(await page.getByPlaceholder('无标题').count(),1,'不能保留第二个旧标题输入');
 await page.waitForFunction(id=>JSON.parse(localStorage.getItem(`xingli.device.v1:snapshots:${id}`)||'[]').some(x=>x.title==='地铁上的星璃'),ids.user);
 phase='Today snapshot';await page.goto(`${base}/w/${ids.ws}/today`);
 await page.waitForFunction(id=>JSON.parse(localStorage.getItem(`xingli.device.v1:snapshots:${id}`)||'[]').some(x=>x.kind==='today'),ids.user);
 phase='service worker';await page.evaluate(async()=>{await navigator.serviceWorker.ready;});await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
 phase='offline snapshots';await context.setOffline(true);await page.goto(base+'/app');await page.getByRole('button',{name:'笔记 · 地铁上的星璃',exact:true}).click();
 assert.equal(await page.locator('#body').textContent(),'只读快照正文');await page.getByRole('button',{name:/^今天 · 今天/}).click();await page.locator('#body').waitFor();
 await page.screenshot({path:'/tmp/xingli-pwa-offline-375.png',fullPage:true});
 await context.setOffline(false);await page.goto(`${base}/w/${ids.ws}/n/${ids.note}`);await page.getByRole('textbox',{name:'笔记标题',exact:true}).waitFor();
 phase='offline draft recovery';await context.setOffline(true);await page.getByRole('textbox',{name:'笔记标题',exact:true}).fill('断网时的新标题');
 await page.waitForFunction(({user,note})=>Object.keys(localStorage).filter(k=>k.startsWith(`xingli.device.v1:draft:${user}:${note}:`)).some(k=>JSON.parse(localStorage.getItem(k)||'null')?.title==='断网时的新标题'),ids);
 await page.reload();await page.getByRole('heading',{name:'星璃笔记',exact:true}).waitFor();
 await context.setOffline(false);await page.goto(`${base}/w/${ids.ws}/n/${ids.note}`);await page.getByText('有本机未同步草稿',{exact:true}).waitFor();
 await page.getByRole('button',{name:'恢复到编辑器',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'笔记标题',exact:true}).inputValue(),'断网时的新标题');
 await page.getByRole('textbox',{name:'笔记标题',exact:true}).press('Control+s');
 await page.waitForFunction(({user,note})=>!Object.keys(localStorage).some(k=>k.startsWith(`xingli.device.v1:draft:${user}:${note}:`)),ids);
 const cached=await page.evaluate(async()=>{const keys=[];for(const name of await caches.keys())for(const req of await (await caches.open(name)).keys())keys.push(new URL(req.url).pathname);return keys;});
 assert.ok(cached.includes('/offline.html'));assert.ok(cached.every(path=>!path.startsWith('/api/')&&!path.startsWith('/w/')&&!path.startsWith('/p/')));
 // 同一篇的两个独有分支；明确控制并行服务端写入，不能假定所有自动保存都无冲突。
 phase='two-tab unsynced branches';
 const noteApi=async(method='GET',body)=>{const response=await fetch(`${base}/api/v1/notes/${ids.note}`,{method,headers:{cookie:`kb_session=${token}`,'content-type':'application/json','x-requested-with':'fetch'},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result.data;};
 const readBranches=()=>page.evaluate(({user,note})=>Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith(`xingli.device.v1:draft:${user}:${note}:`)).sort().map(k=>[k,JSON.parse(localStorage.getItem(k))])),ids);
 const second=await context.newPage();
 // B 的正文只留本机；连关闭标签页触发的 flush 也必须失败，不能在恢复网络瞬间晚提交。
 await second.route(`**/api/v1/notes/${ids.note}`,route=>route.request().method()==='PATCH'?route.abort('internetdisconnected'):route.continue());
 await second.goto(`${base}/w/${ids.ws}/n/${ids.note}`);await second.getByRole('textbox',{name:'笔记标题',exact:true}).waitFor();
 await context.setOffline(true);await second.getByRole('textbox',{name:'笔记标题',exact:true}).fill('标签 B 不应丢失');await page.getByRole('textbox',{name:'笔记标题',exact:true}).fill('标签 A 已保存');
 await page.waitForFunction(({user,note})=>{const rows=Object.keys(localStorage).filter(k=>k.startsWith(`xingli.device.v1:draft:${user}:${note}:`)).map(k=>JSON.parse(localStorage.getItem(k)));return rows.length===2&&rows.some(x=>x.title==='标签 B 不应丢失')&&rows.some(x=>x.title==='标签 A 已保存');},ids);
 const beforeConflict=await readBranches();for(const branch of Object.values(beforeConflict))assert.equal(branch.bodyMd,'只读快照正文');
 await second.close();
 phase='deterministic version conflict';
 const beforeRemote=await noteApi(),parallel=await noteApi('PATCH',{expectedVersion:beforeRemote.version,title:'并行服务端版本',bodyMd:beforeRemote.bodyMd});assert.equal(parallel.title,'并行服务端版本');
 await context.setOffline(false);await page.getByRole('textbox',{name:'笔记标题',exact:true}).press('Control+s');
 await page.getByRole('button',{name:'加载对方版本',exact:true}).waitFor();
 assert.deepEqual(await readBranches(),beforeConflict,'409 不能确认、覆盖或清除任一未同步分支');
 assert.equal((await noteApi()).title,'并行服务端版本','冲突期间不能静默覆盖服务端版本');
 assert.equal(await page.getByRole('textbox',{name:'笔记标题',exact:true}).inputValue(),'标签 A 已保存');
 phase='intentional conflict resolution preserves other branch';
 const resolvedResponse=page.waitForResponse(r=>r.url().endsWith(`/api/v1/notes/${ids.note}`)&&r.request().method()==='PATCH');
 await page.getByRole('button',{name:'强制覆盖',exact:true}).click();assert.equal((await resolvedResponse).status(),200);
 await page.waitForFunction(({user,note})=>{const rows=Object.keys(localStorage).filter(k=>k.startsWith(`xingli.device.v1:draft:${user}:${note}:`)).map(k=>JSON.parse(localStorage.getItem(k)));return rows.length===1&&rows[0].title==='标签 B 不应丢失';},ids);
 const afterResolution=await noteApi();assert.equal(afterResolution.title,'标签 A 已保存');assert.equal(afterResolution.bodyMd,'只读快照正文');assert.ok(afterResolution.version>parallel.version);
 const retained=Object.values(await readBranches());assert.deepEqual(retained,[Object.values(beforeConflict).find(x=>x.title==='标签 B 不应丢失')],'A 确认后 B 的完整不可变修订仍须保持原样');
 await page.reload();await page.getByText('有本机未同步草稿',{exact:true}).waitFor();assert.ok((await page.locator('section[role="status"] pre').textContent()).includes('标签 B 不应丢失'));assert.equal((await noteApi()).title,'标签 A 已保存','显示 B 恢复提示不能自动写回');
 phase='logout isolation';
 // 服务端退出后 /me 的拒绝也必须撤销离线身份。
 await page.evaluate(async()=>{const response=await fetch('/api/v1/auth/logout',{method:'POST',headers:{'x-requested-with':'fetch'}});if(!response.ok)throw Error('logout failed');});
 // 明确返回登录页后 /me 的 401 撤销可信设备读取身份。
 await page.goto(base+'/login');await page.waitForFunction(()=>!localStorage.getItem('xingli.device.v1:active'));
 await context.setOffline(true);await page.goto(base+'/app');assert.equal(await page.locator('#list button').count(),0);
 console.log('PWA与首小时：375px、笔记/Today离线、弱网草稿恢复、双标签409保留双方修订、显式冲突解决、缓存边界、登出隔离通过');
} catch(error) {
 failed=true;console.error('PWA 原始验收失败',phase,error);console.error('合成笔记 PATCH 时序',JSON.stringify(noteWriteTrace));try{console.error('合成笔记服务端末态',await db.select({title:notes.title,version:notes.version}).from(notes).where(eq(notes.id,ids.note)));}catch{};if(page){console.error((await page.locator('body').innerText()).slice(-1800));await page.screenshot({path:'/tmp/xingli-pwa-failure.png',fullPage:true}).catch(()=>{});}throw error;
} finally {
 await browser?.close();if(server.exitCode===null){const exit=once(server,'exit');server.kill('SIGTERM');await exit;}
 try {
  const noteIds=(await db.select({id:notes.id}).from(notes).where(eq(notes.workspaceId,ids.ws))).map(n=>n.id);
  if(noteIds.length){await db.delete(noteVisits).where(inArray(noteVisits.noteId,noteIds));await db.delete(noteVersions).where(inArray(noteVersions.noteId,noteIds));await db.delete(backgroundJobs).where(query`${backgroundJobs.payload}->>'noteId' in (${query.join(noteIds.map(id=>query`${id}`),query`,`)})`);}
  await db.delete(notes).where(eq(notes.workspaceId,ids.ws));await db.delete(notebooks).where(eq(notebooks.id,ids.nb));await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId,ids.ws));await db.delete(workspaces).where(eq(workspaces.id,ids.ws));await db.delete(sessions).where(eq(sessions.userId,ids.user));await db.delete(users).where(eq(users.id,ids.user));
 }catch(error){console.error("PWA 测试清理失败",error);if(!failed)throw error;}finally{await sql.end();}
}
