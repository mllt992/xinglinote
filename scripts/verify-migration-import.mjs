// 隔离测试库的真实 Chromium 导入闭环：预览取消、重复选择、附件可见、HTML 消毒和报告。
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { db, sql } from '../apps/api/src/db/client.ts';
import { users, workspaces, workspaceMembers, notebooks, sessions } from '../apps/api/src/db/schema.ts';
import { hashSecret } from '../apps/api/src/lib/tokens.ts';
import { notionExportFixture } from '../apps/api/src/lib/__fixtures__/migration-export.ts';

assert.equal(process.env.DATABASE_URL,process.env.KB_TEST_DATABASE_URL);
assert.ok(process.env.KB_TEST_DATABASE_URL&&new URL(process.env.KB_TEST_DATABASE_URL).pathname.endsWith('_test'));
const ids={user:randomUUID(),ws:randomUUID(),nb:randomUUID()},token=randomBytes(32).toString('base64url'),suffix=randomUUID().slice(0,8);
await db.insert(users).values({id:ids.user,email:`migration-ui-${suffix}@example.invalid`,handle:`import${suffix}`,displayName:'迁移验收',passwordHash:'not-a-login'});
await db.insert(workspaces).values({id:ids.ws,slug:`migration-ui-${suffix}`,name:'迁移验收',kind:'normal',ownerId:ids.user});
await db.insert(workspaceMembers).values({workspaceId:ids.ws,userId:ids.user,role:'owner'});
await db.insert(notebooks).values({id:ids.nb,workspaceId:ids.ws,slug:'import',title:'导入验收本',createdBy:ids.user});
await db.insert(sessions).values({userId:ids.user,tokenHash:hashSecret(token),expiresAt:new Date(Date.now()+3600000)});
const base='http://127.0.0.1:12099';
const server=spawn(process.execPath,['--import','./apps/api/node_modules/tsx/dist/loader.mjs','apps/api/src/index.ts'],{env:{...process.env,PUBLIC_URL:base,API_PORT:'12099'},stdio:['ignore','pipe','pipe']});
let serverError='';server.stderr.on('data',chunk=>{serverError+=chunk;});let browser;
const query=async path=>{const r=await fetch(base+'/api/v1'+path,{headers:{cookie:`kb_session=${token}`}});const j=await r.json();assert.ok(j.ok,JSON.stringify(j));return j.data;};
try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/healthz')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,serverError);
  browser=await chromium.launch({executablePath:process.env.KB_CHROMIUM_EXECUTABLE,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const context=await browser.newContext({viewport:{width:1365,height:960}});await context.addCookies([{name:'kb_session',value:token,url:base}]);
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${base}/w/${ids.ws}`);
  const open=async()=>{await page.getByRole('button',{name:'笔记本操作',exact:true}).click();await page.getByRole('menuitem',{name:/导入/}).click();await page.getByRole('dialog').waitFor();};
  const fixture={name:'合成 Notion.zip',mimeType:'application/zip',buffer:notionExportFixture()};
  await open();let dialog=page.getByRole('dialog');await dialog.locator('input[type=file]').first().setInputFiles(fixture);
  await dialog.getByRole('button',{name:'确认导入 57 篇',exact:true}).waitFor();
  assert.equal((await query(`/notebooks/${ids.nb}/tree`)).notes.length,0);
  await page.screenshot({path:'/tmp/xingli-migration-preview.png',fullPage:true});
  await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await open();dialog=page.getByRole('dialog');assert.equal(await dialog.getByRole('button',{name:'确认导入',exact:true}).isDisabled(),true);
  await dialog.locator('input[type=file]').first().setInputFiles(fixture);const confirm=dialog.getByRole('button',{name:'确认导入 57 篇',exact:true});await confirm.waitFor();
  // 同一事件帧连点不能提交两批。
  await confirm.evaluate(button=>{button.click();button.click();});
  await dialog.getByText(/导入报告：成功 57/).waitFor({timeout:60000});
  const tree=await query(`/notebooks/${ids.nb}/tree`);assert.equal(tree.notes.length,57);
  assert.ok(tree.folders.some(folder=>folder.title==='项目'));assert.ok(tree.folders.some(folder=>folder.title==='归档'));
  await page.screenshot({path:'/tmp/xingli-migration-report.png',fullPage:true});
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  const note=tree.notes.find(note=>note.title==='页面 01');assert.ok(note);
  await page.goto(`${base}/w/${ids.ws}/n/${note.id}`);await page.getByRole('tab',{name:'预览',exact:true}).click();
  const img=page.locator('[data-note-preview] img').first();await img.waitFor();await img.evaluate(async image=>{if(!image.complete)await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;});});
  assert.ok(await img.evaluate(image=>image.naturalWidth>0&&image.naturalHeight>0));
  await page.screenshot({path:'/tmp/xingli-migration-image.png',fullPage:true});
  await open();dialog=page.getByRole('dialog');await dialog.getByText('或粘贴文章 HTML',{exact:true}).click();
  await dialog.getByRole('textbox',{name:'文章 HTML',exact:true}).fill('<title>HTML 验收</title><h1>正文</h1><p>干净内容</p><script>window.__unsafe=true</script><img src="http://127.0.0.1/private">');
  await dialog.getByRole('button',{name:'预览 HTML',exact:true}).click();await dialog.getByRole('button',{name:'确认导入 1 篇',exact:true}).waitFor();
  await dialog.getByRole('button',{name:'确认导入 1 篇',exact:true}).click();await dialog.getByText(/导入报告：成功 1/).waitFor();assert.equal(await page.evaluate(()=>window.__unsafe),undefined);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({syntheticPages:57,previewNoWrites:true,cancelAndReselect:true,doubleClickGuard:true,folders:true,imageVisible:true,htmlSanitized:true,report:true},null,2));
}finally{await browser?.close();server.kill('SIGTERM');await sql.end();}
