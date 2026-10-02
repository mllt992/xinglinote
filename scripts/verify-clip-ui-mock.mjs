import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const base='http://127.0.0.1:12148';
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
await mkdir('artifacts',{recursive:true});
try {
for(const width of [375,1280]){
 const context=await browser.newContext({viewport:{width,height:900}});let user='mock-user',saves=0,previewDelay=false;
 await context.routeWebSocket(/.*/,ws=>ws.close());
 await context.route('**/api/**',async route=>{const url=new URL(route.request().url()),path=url.pathname;let data={};
 if(path==='/api/v1/me')data={id:user,displayName:'验收用户',appearance:'light',themeId:'mono-modern',personalWorkspaceId:'ws',instanceRole:'user'};
 else if(path==='/api/v1/workspaces')data={workspaces:[{id:'ws',name:'验收空间',role:'owner'}]};
 else if(path==='/api/v1/meta')data={squareEnabled:false,navEnabled:false};
 else if(path==='/api/v1/clips/preview'){if(previewDelay)await new Promise(r=>setTimeout(r,300));data={title:'预览',bodyMd:'验收正文',excerpt:'',images:[],warnings:[]};}
 else if(path==='/api/v1/me/clip-inbox')data={id:'nb'};
 else if(path==='/api/v1/notebooks/nb/clips'){saves++;await new Promise(r=>setTimeout(r,150));data={id:'saved',workspaceId:'ws',warnings:[]};}
 else if(path.includes('notebooks'))data={notebooks:[],folders:[]};
 else data={notifications:[],unread:0,workspaces:[],notes:[],projects:[]};
 await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})}).catch(()=>{});
 });
 const page=await context.newPage();await page.goto(base+'/capture');await page.getByLabel('来源链接',{exact:true}).fill('https://example.invalid/article');await page.getByLabel('剪藏标题',{exact:true}).fill('保留草稿');
 await page.screenshot({path:`artifacts/clip-${width}.png`,fullPage:true});
 await page.getByRole('button',{name:'返回并保留草稿',exact:true}).click();await page.waitForURL(url=>url.pathname!=='/capture');await page.goto(base+'/capture');assert.equal(await page.getByLabel('剪藏标题',{exact:true}).inputValue(),'保留草稿');
 await page.getByRole('button',{name:'丢弃',exact:true}).click();await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.getByLabel('剪藏标题',{exact:true}).inputValue(),'保留草稿');
 previewDelay=true;await page.getByRole('button',{name:'提取并预览',exact:true}).click();await page.getByRole('button',{name:'取消提取',exact:true}).click();await page.waitForTimeout(400);assert.equal(await page.getByTestId('clip-preview').count(),0);
 await page.evaluate(()=>{window.mockSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException('quota','QuotaExceededError');};});await page.getByLabel('剪藏标题',{exact:true}).fill('存储失败');await page.getByRole('button',{name:'返回并保留草稿',exact:true}).click();assert.ok(page.url().endsWith('/capture'));await page.evaluate(()=>{Storage.prototype.setItem=window.mockSetItem;});
 await page.getByRole('button',{name:'确认保存到星璃',exact:true}).evaluate(b=>{b.click();b.click();});await page.getByRole('heading',{name:'已存到星璃',exact:true}).waitFor();assert.equal(saves,1);
 user='mock-other';await page.evaluate(()=>window.dispatchEvent(new Event('kb:me-updated')));await page.getByLabel('剪藏标题',{exact:true}).waitFor();await page.waitForTimeout(100);assert.equal(await page.getByLabel('剪藏标题',{exact:true}).inputValue(),'');
 console.log(`PASS ${width}: return draft, cancel discard, cancel extraction, storage guard, repeat save, account isolation`);await context.close();
}
}finally{await browser.close();}
