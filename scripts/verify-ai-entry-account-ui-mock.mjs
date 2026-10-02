import assert from "node:assert/strict";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
const base = process.env.KB_UI_BASE_URL || "http://127.0.0.1:12148";
const harness = new URL("../apps/web/__ai_account_mock__.html", import.meta.url);
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client';
import {ToastProvider} from './src/components/ui/toast';
import {TooltipProvider} from './src/components/ui/tooltip';
import {AiWriteTab} from './src/components/ai-write-tab';
import {AiDiagramTab} from './src/components/ai-diagram-tab';
import {AiChatPanel} from './src/components/drawio-board';
import {AiExpandDialog} from './src/components/mind-map-editor';
import {deviceStorage} from './src/lib/device-storage';
window.callbacks=0;window.changeIdentity=id=>{deviceStorage.identify(id);window.dispatchEvent(new Event('kb:me-updated'));};deviceStorage.identify('alice');
const mode=new URLSearchParams(location.search).get('mode');
const note={id:'same-note',workspaceId:'same-ws',notebookId:'nb',bodyMd:'原始正文',version:1,canEdit:true};
const common={workspaceId:'same-ws',note};
const callback=()=>{window.callbacks++;return true;};
let component;
if(mode==='write')component=React.createElement(AiWriteTab,{...common,getSelection:()=>null,onApply:async()=>callback()});
if(mode==='diagram')component=React.createElement(AiDiagramTab,{...common,getTarget:()=>null,onInsert:callback});
if(mode==='drawio')component=React.createElement(AiChatPanel,{workspaceId:'same-ws',mapId:'same-map',getXml:()=>'<mxfile/>',applyXml:callback,onClose:()=>{},ready:true});
if(mode==='expand')component=React.createElement(AiExpandDialog,{workspaceId:'same-ws',mapId:'same-map',open:true,onOpenChange:()=>{},getTarget:()=>({path:['root'],existing:[]}),onInsert:callback});
createRoot(document.getElementById('root')).render(React.createElement(TooltipProvider,null,React.createElement(ToastProvider,null,component)));
</script></body></html>`;
await writeFile(harness, html);await mkdir("artifacts", {recursive:true});
const browser=await chromium.launch({executablePath:process.env.KB_CHROMIUM_EXECUTABLE || "C:/Program Files/Google/Chrome/Application/chrome.exe",headless:true});
try {
 for(const mode of (process.env.KB_AI_TEST_MODES || "write,diagram,drawio,expand").split(",")){
  const context=await browser.newContext();let user="alice",hold=false,release;let requests=0;
  await context.routeWebSocket(/.*/,ws=>ws.close());
  await context.route("**/api/**",async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path.endsWith('/chat-options')){await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data:{userId:user,channels:[{id:'personal',name:'个人',source:'个人',models:['mock-model']}],effective:{providerId:'personal',model:'mock-model',source:'个人'},explicitWorkspace:false}})});return;}
   requests++;if(hold)await new Promise(r=>{release=r;});
   const data=mode==='write'?{text:'OLD_ACCOUNT_SUGGESTION',baseVersion:1}:mode==='diagram'?{source:'flowchart LR\n A[OLD_ACCOUNT_SUGGESTION] --> B[End]'}:mode==='drawio'?{xml:'<mxfile/>',reply:'OLD_ACCOUNT_SUGGESTION'}:{items:[{text:'OLD_ACCOUNT_SUGGESTION',children:[]}]};
   await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})}).catch(()=>{});
  });
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/__ai_account_mock__.html?mode='+mode);
  await page.getByText('当前：mock-model · 个人',{exact:false}).waitFor().catch(async e=>{console.error(mode,errors,await page.locator('body').innerText());throw e;});
  const generate=async()=>{
   if(mode==='write')await page.getByRole('button',{name:'生成建议',exact:true}).click();
   if(mode==='diagram'){await page.locator('textarea').fill('画流程图');await page.getByRole('button',{name:'生成图',exact:true}).click();}
   if(mode==='drawio'){await page.locator('textarea').fill('画流程图');await page.getByRole('button',{name:'发送',exact:true}).click();}
   if(mode==='expand')await page.getByRole('button',{name:/^(生成建议|换一批)$/}).click();
  };
  await generate();await page.getByText('OLD_ACCOUNT_SUGGESTION',{exact:false}).first().waitFor();
  if(mode==='drawio')assert.equal(await page.evaluate(()=>window.callbacks),1);
  if(mode==='write')await page.getByRole('button',{name:/^应用 \d+ 处改动$/}).click();
  if(mode==='diagram')await page.getByRole('button',{name:'插入到笔记',exact:true}).click();
  if(mode==='expand')await page.getByRole('button',{name:'插入到导图',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.callbacks),1);
  // Re-create a visible suggestion so account reset verifies existing results as well.
  if(mode!=='drawio'){await generate();await page.getByText('OLD_ACCOUNT_SUGGESTION',{exact:false}).first().waitFor();}
  const expectedRequests=mode==='drawio'?2:3;
  const before=await page.evaluate(()=>window.callbacks);
  user='bob';await page.evaluate(()=>window.changeIdentity('bob'));
  await page.getByText('当前：mock-model · 个人',{exact:false}).waitFor();
  assert.equal(await page.getByText('OLD_ACCOUNT_SUGGESTION',{exact:false}).count(),0);
  if(mode==='drawio')assert.equal(await page.getByRole('button',{name:'撤销上一次 AI 修改',exact:true}).isDisabled(),true);
  else assert.equal(await page.getByRole('button',{name:/^(应用 \d+ 处改动|插入到笔记|插入到导图)$/}).count(),0);
  hold=true;await generate();
  for(let i=0;i<30&&requests<expectedRequests;i++)await page.waitForTimeout(50);assert.equal(requests,expectedRequests);
  user='carol';await page.evaluate(()=>window.changeIdentity('carol'));
  await page.getByText('当前：mock-model · 个人',{exact:false}).waitFor();release();await page.waitForTimeout(150);
  assert.equal(await page.getByText('OLD_ACCOUNT_SUGGESTION',{exact:false}).count(),0);
  assert.equal(await page.evaluate(()=>window.callbacks),before);
  assert.deepEqual(errors,[]);
  await page.screenshot({path:'artifacts/ai-'+mode+'-account-isolation.png',fullPage:true});
  console.log('PASS '+mode+': existing suggestion cleared; late account response ignored; callbacks protected');await context.close();
 }
} finally {await browser.close();await unlink(harness);}
