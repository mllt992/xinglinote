// CI 真浏览器 + 合成数据库：PWA 离线阅读、弱网草稿、登出隔离与管理员首小时。
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { db, sql } from '../apps/api/src/db/client.ts';
import { users, workspaces, workspaceMembers, notebooks, notes, noteVersions, backgroundJobs, sessions } from '../apps/api/src/db/schema.ts';
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
let errors='';server.stderr.on('data',d=>{errors+=d;});let browser;
try {
 let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/healthz')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,errors);
 browser=await chromium.launch({executablePath:process.env.KB_CHROMIUM_EXECUTABLE,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true});
 await context.addCookies([{name:'kb_session',value:token,url:base}]);
 const page=await context.newPage();await page.routeWebSocket('**/*',socket=>socket.close());
 await page.goto(base+'/admin');await page.getByRole('heading',{name:'第一小时清单'}).waitFor();await page.getByRole('heading',{name:'实例健康检查'}).waitFor();
 assert.ok(await page.getByText('尚未开启备份',{exact:false}).count());
 await page.screenshot({path:'/tmp/xingli-pwa-admin-375.png',fullPage:true});
 await page.goto(base+'/settings/account');await page.getByRole('button',{name:'开启可信设备暂存',exact:true}).click();await page.getByRole('button',{name:'这是我的设备，开启',exact:true}).click();
 await page.goto(`${base}/w/${ids.ws}/n/${ids.note}`);
 await page.getByPlaceholder('无标题').waitFor();
 await page.waitForFunction(id=>JSON.parse(localStorage.getItem(`xingli.device.v1:snapshots:${id}`)||'[]').some(x=>x.title==='地铁上的星璃'),ids.user);
 await page.goto(`${base}/w/${ids.ws}/today`);
 await page.waitForFunction(id=>JSON.parse(localStorage.getItem(`xingli.device.v1:snapshots:${id}`)||'[]').some(x=>x.kind==='today'),ids.user);
 await page.evaluate(async()=>{await navigator.serviceWorker.ready;});await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
 await context.setOffline(true);await page.goto(base+'/app');await page.getByRole('button',{name:'笔记 · 地铁上的星璃',exact:true}).click();
 assert.equal(await page.locator('#body').textContent(),'只读快照正文');await page.getByRole('button',{name:/^今天 · 今天/}).click();await page.locator('#body').waitFor();
 await page.screenshot({path:'/tmp/xingli-pwa-offline-375.png',fullPage:true});
 await context.setOffline(false);await page.goto(`${base}/w/${ids.ws}/n/${ids.note}`);await page.getByPlaceholder('无标题').waitFor();
 await context.setOffline(true);await page.getByPlaceholder('无标题').fill('断网时的新标题');
 await page.waitForFunction(({user,note})=>JSON.parse(localStorage.getItem(`xingli.device.v1:draft:${user}:${note}`)||'null')?.title==='断网时的新标题',ids);
 await page.reload();await page.getByRole('heading',{name:'星璃笔记',exact:true}).waitFor();
 await context.setOffline(false);await page.goto(`${base}/w/${ids.ws}/n/${ids.note}`);await page.getByText('有本机未同步草稿',{exact:true}).waitFor();
 await page.getByRole('button',{name:'恢复到编辑器',exact:true}).click();assert.equal(await page.getByPlaceholder('无标题').inputValue(),'断网时的新标题');
 await page.getByPlaceholder('无标题').press('Control+s');
 await page.waitForFunction(({user,note})=>!localStorage.getItem(`xingli.device.v1:draft:${user}:${note}`),ids);
 const cached=await page.evaluate(async()=>{const keys=[];for(const name of await caches.keys())for(const req of await (await caches.open(name)).keys())keys.push(new URL(req.url).pathname);return keys;});
 assert.ok(cached.includes('/offline.html'));assert.ok(cached.every(path=>!path.startsWith('/api/')&&!path.startsWith('/w/')&&!path.startsWith('/p/')));
 // 服务端退出后 /me 的拒绝也必须撤销离线身份。
 await page.evaluate(async()=>{const response=await fetch('/api/v1/auth/logout',{method:'POST',headers:{'x-requested-with':'fetch'}});if(!response.ok)throw Error('logout failed');});
 // 明确返回登录页后 /me 的 401 撤销可信设备读取身份。
 await page.goto(base+'/login');await page.waitForFunction(()=>!localStorage.getItem('xingli.device.v1:active'));
 await context.setOffline(true);await page.goto(base+'/app');assert.equal(await page.locator('#list button').count(),0);
 console.log('PWA与首小时：375px、笔记/Today离线、弱网草稿恢复、缓存边界、登出隔离通过');
} finally {
 await browser?.close();if(server.exitCode===null){const exit=once(server,'exit');server.kill('SIGTERM');await exit;}
 try {
  const noteIds=(await db.select({id:notes.id}).from(notes).where(eq(notes.workspaceId,ids.ws))).map(n=>n.id);
  if(noteIds.length){await db.delete(noteVersions).where(inArray(noteVersions.noteId,noteIds));await db.delete(backgroundJobs).where(query`${backgroundJobs.payload}->>'noteId' in (${query.join(noteIds.map(id=>query`${id}`),query`,`)})`);}
  await db.delete(notes).where(eq(notes.workspaceId,ids.ws));await db.delete(notebooks).where(eq(notebooks.id,ids.nb));await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId,ids.ws));await db.delete(workspaces).where(eq(workspaces.id,ids.ws));await db.delete(sessions).where(eq(sessions.userId,ids.user));await db.delete(users).where(eq(users.id,ids.user));
 }finally{await sql.end();}
}
