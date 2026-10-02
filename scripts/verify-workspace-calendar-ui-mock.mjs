import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const base=process.env.KB_MOCK_BASE_URL??'http://127.0.0.1:12148';
const browser=await chromium.launch({executablePath:process.env.KB_CHROMIUM_EXECUTABLE??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
await mkdir('artifacts',{recursive:true});
const spaces=[{id:'a',name:'工作区甲',role:'owner'},{id:'b',name:'工作区乙',role:'owner'}];
const title=ws=>ws==='a'?'甲区私有内容':'乙区当前内容';
const board=ws=>({id:`map-${ws}`,notebookId:`nb-${ws}`,kind:'mindmap',title:title(ws),version:1,createdAt:'2026-10-02T00:00:00Z',updatedAt:'2026-10-02T00:00:00Z'});
const item=ws=>({id:`task-${ws}`,workspaceId:ws,title:title(ws),kind:'task',allDay:true,startsAt:null,endsAt:null,dueAt:'2026-10-02T00:00:00+08:00',timezone:'Asia/Shanghai',status:'open',priority:0,recurring:false,source:'manual',sourceNoteId:null,sourceNoteTitle:null,linkState:'linked',assigneeUserId:null,createdBy:'mock',canEdit:true});
try{
for(const mode of ['light','dark']){
 const context=await browser.newContext({viewport:{width:1280,height:900},colorScheme:mode,serviceWorkers:'block'});await context.routeWebSocket(/.*/,ws=>ws.close());let hold=false,held=[],accountChanged=false;
 await context.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname,ws=path.includes('/workspaces/b/')?'b':'a';let data={};
  if(path==='/api/v1/me')data={id:'mock',displayName:'验收用户',personalWorkspaceId:'a',appearance:mode,themeId:'mono-modern',instanceRole:'user'};
  else if(path==='/api/v1/theme/resolved')data={id:'mock',name:'mock',mode,navActiveStyle:'solid',vars:mode==='dark'?{'--background':'#111111','--foreground':'#eeeeee','--primary':'#eeeeee','--primary-foreground':'#111111','--muted':'#222222','--muted-foreground':'#aaaaaa','--border':'#444444','--accent':'#333333'}:{}};
  else if(path==='/api/v1/meta')data={squareEnabled:false,navEnabled:false};
  else if(path==='/api/v1/workspaces')data={workspaces:spaces};
  else if(path.endsWith('/mindmaps'))data={notebooks:[{id:`nb-${ws}`,title:'验收笔记本',canEdit:true}],mindMaps:[board(ws)],drawioEnabled:false};
  else if(path.endsWith('/calendar/inbox'))data={inbox:accountChanged?[]:[item(ws)],legacy:[],groups:[],overdue:0,me:'mock',workspaceKind:'personal',canEdit:true};
  else if(path.endsWith('/calendar'))data={items:accountChanged?[]:[item(ws)],notes:[],timezone:'Asia/Shanghai'};
  else if(path.endsWith('/members'))data={members:[]};
  else if(path==='/api/v1/push/config')data={enabled:false};
  else data={notifications:[],unread:0,counts:{},templates:[],channels:[]};
  const finish=()=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})}).catch(()=>{});
  if(hold&&path.includes('/workspaces/a/')&&(path.endsWith('/mindmaps')||path.endsWith('/calendar')||path.endsWith('/calendar/inbox')))held.push(finish);else await finish();
 });
 let deviceModule;const page=await context.newPage();page.on("request",req=>{if(req.url().includes("/lib/device-storage.ts"))deviceModule=req.url();});page.on('pageerror',e=>console.error('PAGEERROR',e.message));await page.clock.install({time:new Date('2026-10-02T04:00:00Z')});
 await page.goto(base+'/w/a/mindmaps');await page.getByText(title('a'),{exact:true}).waitFor();assert.equal(await page.getByLabel('当前导图工作区').inputValue(),'a');
 hold=true;await page.evaluate(()=>{history.pushState({},'','/w/b/mindmaps');dispatchEvent(new PopStateEvent('popstate'));});await page.getByText(title('b'),{exact:true}).waitFor();await page.getByLabel('当前导图工作区').selectOption('a');await page.waitForTimeout(100);assert.ok(held.length>0);await page.getByLabel('当前导图工作区').selectOption('b');await page.getByText(title('b'),{exact:true}).waitFor();for(const finish of held.splice(0))await finish();await page.waitForTimeout(100);assert.equal(await page.getByText(title('a'),{exact:true}).count(),0);await page.screenshot({path:`artifacts/mindmap-workspace-${mode}.png`,fullPage:true});hold=false;
 await page.goto(base+'/w/a/calendar?view=month&date=2026-10-02');await page.getByRole('grid',{name:'月视图'}).waitFor();await page.locator('.bg-primary.text-primary-foreground').first().waitFor();await page.screenshot({path:`artifacts/calendar-month-${mode}.png`,fullPage:true});
 const color=await page.locator('.bg-primary.text-primary-foreground').first().evaluate(e=>{const c=getComputedStyle(e);return {fg:c.color,bg:c.backgroundColor};});assert.notEqual(color.fg,color.bg);
 await page.evaluate(()=>{history.pushState({},'','/w/a/calendar?view=day&date=2026-10-02');dispatchEvent(new PopStateEvent('popstate'));});await page.locator('.border-t-2.border-primary').waitFor();await page.screenshot({path:`artifacts/calendar-time-${mode}.png`,fullPage:true});
 hold=true;await page.evaluate(()=>{history.pushState({},'','/w/b/calendar?view=day&date=2026-10-02');dispatchEvent(new PopStateEvent('popstate'));});await page.getByText(title('b'),{exact:true}).first().waitFor();await page.evaluate(()=>{history.pushState({},'','/w/a/calendar?view=day&date=2026-10-02');dispatchEvent(new PopStateEvent('popstate'));});await page.waitForTimeout(100);assert.ok(held.length>0);await page.evaluate(()=>{history.pushState({},'','/w/b/calendar?view=day&date=2026-10-02');dispatchEvent(new PopStateEvent('popstate'));});await page.getByText(title('b'),{exact:true}).first().waitFor();for(const finish of held.splice(0))await finish();await page.waitForTimeout(100);assert.equal(await page.getByText(title('a'),{exact:true}).count(),0);hold=false;accountChanged=true;await page.evaluate(async url=>{const m=await import(url);m.deviceStorage.identify('second-user');},deviceModule);await page.waitForTimeout(150);assert.equal(await page.getByText(title('b'),{exact:true}).count(),0,'日历跨账号清空历史任务');console.log(`PASS ${mode}: mindmap workspace switch/late response, calendar date colors/time line/workspace late response`);await context.close();
}
}finally{await browser.close();}
