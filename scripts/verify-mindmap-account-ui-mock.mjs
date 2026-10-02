import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
const browser=await chromium.launch({executablePath:process.env.KB_CHROMIUM_EXECUTABLE??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const base=process.env.KB_MOCK_BASE_URL??'http://127.0.0.1:12148';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
try{
 const context=await browser.newContext({serviceWorkers:'block'});await context.routeWebSocket(/.*/,ws=>ws.close());let user=a,patches=[],held=[],delay=false;
 await context.route('**/mind-map-editor.tsx*',route=>route.fulfill({contentType:'application/javascript',body:`import React from '/node_modules/.vite/deps/react.js'; export const MindMapEditor=React.forwardRef((p,ref)=>{const snap=React.useRef(p.data);React.useImperativeHandle(ref,()=>({getData:()=>snap.current,getPreviewSvg:async()=>'<svg/>',focusNode:()=>{}}));return React.createElement('div',{},p.leading,React.createElement('span',{},p.title),React.createElement('button',{onClick:()=>{snap.current={...snap.current,changed:Date.now()};p.onChange();}},'修改模拟导图'));}); export const MindMapPreview=()=>null;` }));
 await context.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;let data={};
 if(path==='/api/v1/me')data={id:user,displayName:'mock',personalWorkspaceId:'a'};
 else if(path==='/api/v1/workspaces')data={workspaces:[{id:'a',name:'空间甲'}]};
 else if(path==='/api/v1/meta')data={squareEnabled:false,navEnabled:false};
 else if(path==='/api/v1/theme/resolved')data={vars:{},mode:'light',navActiveStyle:'solid'};
 else if(path==='/api/v1/mindmaps/map-a'&&route.request().method()==='GET')data={workspaceId:'a',notebook:{id:'nb-a',title:'笔记本'},mindMap:{id:'map-a',title:user===a?'账号A导图':'账号B导图',kind:'mindmap',version:1,data:{format:2,root:{data:{text:'root'},children:[]}}},canEdit:true};
 else if(path==='/api/v1/mindmaps/map-a'&&route.request().method()==='PATCH'){const payload=route.request().postDataJSON();patches.push(payload);assert.equal(payload.expectedUserId,a);const finish=()=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data:{mindMap:{id:'map-a',version:2}}})}).catch(()=>{});if(delay){held.push(finish);return;}await finish();return;}
 else data={notebooks:[],mindMaps:[],notifications:[],unread:0};
 await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})});});
 let deviceModule;const page=await context.newPage();page.on('request',req=>{if(req.url().includes('/lib/device-storage.ts'))deviceModule=req.url();});page.on('pageerror',e=>console.error('PAGEERROR',e.message));await page.goto(base+'/w/a/mindmaps/map-a');await page.getByRole('button',{name:'修改模拟导图'}).waitFor();
 const changeAccount=async()=>{user=b;await page.evaluate(async ({id,url})=>{const m=await import(url);m.deviceStorage.identify(id);},{id:b,url:deviceModule});};
 await page.getByRole('button',{name:'修改模拟导图'}).click();await changeAccount();await page.getByText('账号B导图',{exact:true}).last().waitFor();await page.waitForTimeout(1200);assert.equal(patches.length,0,'账号切换不能cleanup flush或800ms旧自动保存');assert.equal(await page.getByText('账号A导图',{exact:true}).count(),0);
 user=a;await page.evaluate(async ({id,url})=>{const m=await import(url);m.deviceStorage.identify(id);},{id:a,url:deviceModule});await page.getByText('账号A导图',{exact:true}).last().waitFor();delay=true;await page.getByRole('button',{name:'修改模拟导图'}).click();await page.waitForTimeout(1000);assert.equal(patches.length,1);await changeAccount();await page.getByText('账号B导图',{exact:true}).last().waitFor();for(const finish of held)await finish();await page.waitForTimeout(1200);assert.equal(patches.length,1,'旧响应不得触发后续保存');assert.equal(await page.getByText('账号A导图',{exact:true}).count(),0);console.log('PASS editor account switch clears content, blocks delayed autosave/cleanup flush, ignores pending save response, sends expectedUserId');await context.close();
}finally{await browser.close();}
