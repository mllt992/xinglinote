// 真实编辑器 SVG 导出 → 分享密码 → 公开只读/文档站，隔离测试库与合成资料。
// draw.io 使用官方 postMessage 协议夹具，单独标注，不冒充外部引擎实测。
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { db, sql } from '../apps/api/src/db/client.ts';
import { users, workspaces, workspaceMembers, notebooks, notes, sessions, mindMaps, shareLinks } from '../apps/api/src/db/schema.ts';
import { hashSecret } from '../apps/api/src/lib/tokens.ts';
import { emptyMindMap } from '../packages/shared/src/mindmap.ts';
const { eq, inArray } = createRequire(new URL('../apps/api/package.json', import.meta.url))('drizzle-orm');
assert.equal(process.env.DATABASE_URL,process.env.KB_TEST_DATABASE_URL);
assert.ok(process.env.KB_TEST_DATABASE_URL && new URL(process.env.KB_TEST_DATABASE_URL).pathname.endsWith('_test'));
const ids={user:randomUUID(),ws:randomUUID(),nb:randomUUID(),note:randomUUID(),secret:randomUUID()};
const token=randomBytes(32).toString('base64url'),suffix=randomUUID().slice(0,8),base='http://127.0.0.1:12153';
const boardIds=[];let browser,server,page;
const call=async(path,body,method=body?'POST':'GET')=>{
 const r=await fetch(base+'/api/v1'+path,{method,headers:{cookie:`kb_session=${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const j=await r.json();assert.ok(r.ok,JSON.stringify(j));return j.data;
};
try{
 await db.insert(users).values({id:ids.user,email:`board-${suffix}@example.invalid`,handle:`board${suffix}`,displayName:'导图验收',passwordHash:'not-a-login'});
 await db.insert(workspaces).values({id:ids.ws,slug:`board-${suffix}`,name:'图文知识库',kind:'normal',ownerId:ids.user});
 await db.insert(workspaceMembers).values({workspaceId:ids.ws,userId:ids.user,role:'owner'});
 await db.insert(notebooks).values({id:ids.nb,workspaceId:ids.ws,slug:'plans',title:'旅行计划',createdBy:ids.user,sitePublished:true});
 await db.insert(notes).values([{id:ids.note,title:'公开行程',published:true},{id:ids.secret,title:'私密证件资料',published:false}].map(row=>({...row,workspaceId:ids.ws,notebookId:ids.nb,bodyMd:'合成验收正文',createdBy:ids.user,updatedBy:ids.user})));
 await db.insert(sessions).values({userId:ids.user,tokenHash:hashSecret(token),expiresAt:new Date(Date.now()+3600000)});
 server=spawn(process.execPath,['--import','./apps/api/node_modules/tsx/dist/loader.mjs','apps/api/src/index.ts'],{env:{...process.env,PUBLIC_URL:base,API_PORT:'12153',DRAWIO_URL:'https://embed.diagrams.net'},stdio:['ignore','pipe','pipe']});
 let serverError='';server.stderr.on('data',chunk=>{serverError+=chunk;});server.stdout.resume();
 let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/healthz')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,serverError);
 const data=emptyMindMap('家庭旅行地图');data.root.children=[{data:{uid:'route',text:'交通路线',hyperlink:`#note:${ids.note}`},children:[]},{data:{uid:'packing',text:'打包清单',hyperlink:`#note:${ids.secret}`,note:'不应出现在公开源里的备注'},children:[]}];
 const map=(await call(`/notebooks/${ids.nb}/mindmaps`,{kind:'mindmap',title:'家庭旅行地图',data})).mindMap;boardIds.push(map.id);
 browser=await chromium.launch({executablePath:process.env.KB_CHROMIUM_EXECUTABLE,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const owner=await browser.newContext({viewport:{width:1280,height:900}});await owner.addCookies([{name:'kb_session',value:token,url:base}]);
 page=await owner.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const more=async(label)=>{await page.getByRole('button',{name:'更多操作',exact:true}).click();await page.getByRole('menuitem',{name:label,exact:true}).click();};
 await page.goto(`${base}/w/${ids.ws}/mindmaps/${map.id}`);
 await page.locator('svg').filter({hasText:'交通路线'}).first().waitFor();
 await more('分享与复制链接');await page.getByRole('dialog').waitFor();
 assert.equal(await page.getByLabel('允许评论',{exact:true}).count(),0);
 await page.getByPlaceholder('访问密码（可选）').fill('fixture-password');
 const shareResponse=page.waitForResponse(r=>r.url().endsWith(`/mindmaps/${map.id}/shares`)&&r.request().method()==='POST');
 await page.getByRole('button',{name:'生成并复制',exact:true}).click();
 const share=(await (await shareResponse).json()).data;
 await page.keyboard.press('Escape');
 const visitor=await browser.newContext({viewport:{width:375,height:812}});const publicPage=await visitor.newPage();
 await publicPage.goto(`${base}/p/${share.token}`);await publicPage.getByRole('heading',{name:'此分享受密码保护'}).waitFor();
 assert.equal(await publicPage.getByText('交通路线',{exact:true}).count(),0);
 await publicPage.getByPlaceholder('访问密码',{exact:true}).fill('fixture-password');await publicPage.getByRole('button',{name:'解锁内容'}).click();
 await publicPage.locator('.public-board-svg text').filter({hasText:'交通路线'}).first().waitFor();
 assert.equal(await publicPage.getByRole('button',{name:'更多操作',exact:true}).count(),0);
 assert.equal(await publicPage.getByRole('link',{name:'私密证件资料',exact:true}).count(),0);
 await publicPage.getByRole('link',{name:'公开行程',exact:true}).waitFor();
 const raw=await publicPage.evaluate(async url=>(await fetch(url)).text(),`${base}/api/v1/public/shares/${share.token}`);
 for(const secret of [ids.secret,'不应出现在公开源里的备注','"root"','"xml"'])assert.ok(!raw.includes(secret),secret);
 await publicPage.getByLabel('搜索图中节点',{exact:true}).fill('交通');
 assert.ok(await publicPage.locator('.public-board-svg text').evaluateAll(nodes=>nodes.some(n=>n.style.outline.includes('3px'))));
 await publicPage.getByRole('button',{name:'放大导图'}).click();assert.equal(await publicPage.locator('.public-board-svg').evaluate(el=>el.style.width),'125%');
 await publicPage.getByRole('button',{name:'适应',exact:true}).click();
 await publicPage.screenshot({path:'/tmp/xingli-boards-share-375.png',fullPage:true});
 const geometry=await publicPage.locator('.public-board-svg > svg').evaluate(svg=>{
  const root=svg.getBoundingClientRect();return{viewBox:svg.getAttribute('viewBox'),shapes:[...svg.querySelectorAll('rect,path')].slice(0,20).map(n=>{const r=n.getBoundingClientRect();return{tag:n.tagName,fill:getComputedStyle(n).fill,opacity:n.getAttribute('opacity'),x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};}),root:{x:root.x,y:root.y,width:root.width,height:root.height},labels:[...svg.querySelectorAll('text')].filter(t=>/家庭旅行地图|交通路线|打包清单/.test(t.textContent)).map(t=>{const r=t.getBoundingClientRect();return{text:t.textContent,x:r.x,y:r.y,right:r.right,bottom:r.bottom,font:getComputedStyle(t).fontSize,fill:getComputedStyle(t).fill};})};
 });
 assert.ok(geometry.viewBox,'响应式 SVG 必须有 viewBox');assert.ok(geometry.root.height>50);
 for(const label of geometry.labels){assert.ok(label.x>=geometry.root.x-2&&label.right<=geometry.root.x+geometry.root.width+2&&label.y>=geometry.root.y-2&&label.bottom<=geometry.root.y+geometry.root.height+2,JSON.stringify({geometry,label}));}
 const rootLabel=geometry.labels.find(l=>l.text==='家庭旅行地图');assert.ok(rootLabel);
 assert.ok(geometry.shapes.some(s=>s.fill!==rootLabel.fill&&!['none','transparent','rgba(0, 0, 0, 0)'].includes(s.fill)&&s.x<=rootLabel.x&&s.right>=rootLabel.right&&s.y<=rootLabel.y&&s.bottom>=rootLabel.bottom),'根节点必须有可见的对比背景，不能只剩白字');
 console.log('SVG visible geometry',JSON.stringify(geometry));

 assert.equal(await publicPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await publicPage.screenshot({path:'/tmp/xingli-boards-share-375.png',fullPage:true});
 await more('发布到文档站');await page.getByText('已发布到文档站',{exact:true}).waitFor();
 const site=`${base}/s/board-${suffix}/plans`;
 await publicPage.setViewportSize({width:1280,height:900});await publicPage.goto(`${site}/boards/${map.id}`);
 await publicPage.getByRole('navigation',{name:'文档站导图目录'}).getByRole('button',{name:'家庭旅行地图',exact:true}).waitFor();
 await publicPage.locator('.public-board-svg text').filter({hasText:'交通路线'}).first().waitFor();
 await publicPage.goto(`${site}/${ids.note}`);await publicPage.getByRole('heading',{name:'关联导图',exact:true}).waitFor();
 await publicPage.getByRole('button',{name:'家庭旅行地图',exact:true}).last().click();await publicPage.locator('.public-board-svg text').filter({hasText:'交通路线'}).first().waitFor();
 await publicPage.screenshot({path:'/tmp/xingli-boards-site-desktop.png',fullPage:true});
 // 源通过 API 修改后旧预览立刻失效；回编辑器刷新后才恢复，不能显示旧敏感内容。
 const current=(await call(`/mindmaps/${map.id}`)).mindMap;current.data.root.children[0].data.text='交通路线已更新';
 await call(`/mindmaps/${map.id}`,{data:current.data,expectedVersion:current.version},'PATCH');
 assert.equal((await visitor.request.get(`${base}/api/v1/public/shares/${share.token}`)).status(),404);
 await page.reload();await page.getByRole('status').filter({hasText:'公开预览待刷新'}).waitFor();
 await page.locator('svg').filter({hasText:'交通路线已更新'}).first().waitFor();
 const refreshed=page.waitForResponse(r=>r.url().endsWith(`/mindmaps/${map.id}/public-preview`)&&r.request().method()==='PUT');
 await more('刷新公开预览');assert.equal((await refreshed).status(),200);
 await publicPage.goto(`${base}/p/${share.token}`);await publicPage.locator('.public-board-svg text').filter({hasText:'交通路线已更新'}).first().waitFor();
 // A 发布请求的迟到响应不能修改 SPA 已切换到 B 的发布状态。
 const other=(await call(`/notebooks/${ids.nb}/mindmaps`,{kind:'mindmap',title:'另一张导图',data:emptyMindMap('另一张导图')})).mindMap;boardIds.push(other.id);
 let releasePublish,markPublish;const publishGate=new Promise(r=>{releasePublish=r;}),publishStarted=new Promise(r=>{markPublish=r;});
 await page.route(`**/api/v1/mindmaps/${map.id}/publish`,async route=>{const response=await route.fetch();markPublish();await publishGate;await route.fulfill({response});});
 await more('从文档站隐藏');await publishStarted;
 await page.evaluate(path=>{history.pushState({},'',path);dispatchEvent(new PopStateEvent('popstate'));},`/w/${ids.ws}/mindmaps/${other.id}`);
 await page.getByRole('button',{name:'另一张导图',exact:true}).waitFor();releasePublish();await page.waitForTimeout(150);
 await page.getByRole('button',{name:'更多操作',exact:true}).click();await page.getByRole('menuitem',{name:'发布到文档站',exact:true}).waitFor();assert.equal(await page.getByRole('menuitem',{name:'从文档站隐藏',exact:true}).count(),0);await page.keyboard.press('Escape');
 await page.unroute(`**/api/v1/mindmaps/${map.id}/publish`);
 // 不调用外部服务：协议夹具检查 draw.io export 返回 SVG 走同一安全投影链。
 const drawingSvg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><rect width="400" height="100" fill="white"/><text x="20" y="55">架构图协议验收</text></svg>';
 await page.route('https://embed.diagrams.net/**',route=>route.fulfill({contentType:'text/html',body:`<script>addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.action==='export')parent.postMessage(JSON.stringify({event:'export',format:'svg',data:${JSON.stringify('data:image/svg+xml;base64,'+Buffer.from(drawingSvg).toString('base64'))}}),'*')});parent.postMessage(JSON.stringify({event:'init'}),'*')</script>`}));
 const drawing=(await call(`/notebooks/${ids.nb}/mindmaps`,{kind:'drawio',title:'只读架构图',data:{format:'drawio',xml:'<mxfile><diagram><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>',noteIds:[]}})).mindMap;boardIds.push(drawing.id);
 await page.goto(`${base}/w/${ids.ws}/mindmaps/${drawing.id}`);await page.frameLocator('iframe').locator('body').waitFor();
 await more('分享与复制链接');await page.getByRole('dialog').waitFor();
 const drawingShareResponse=page.waitForResponse(r=>r.url().endsWith(`/mindmaps/${drawing.id}/shares`)&&r.request().method()==='POST');
 await page.getByRole('button',{name:'生成并复制',exact:true}).click();const drawingShare=(await (await drawingShareResponse).json()).data;
 await publicPage.goto(`${base}/p/${drawingShare.token}`);await publicPage.locator('.public-board-svg text').filter({hasText:'架构图协议验收'}).waitFor();
 assert.equal(await publicPage.locator('iframe').count(),0,'访客不加载编辑器 iframe');
 await call(`/shares/${share.id}`,undefined,'DELETE');assert.equal((await visitor.request.get(`${base}/api/v1/public/shares/${share.token}`)).status(),404);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({realMindmapSvg:true,passwordGate:true,privateSourcesExcluded:true,zoomAndSearch:true,mobile375:true,siteTreeAndInline:true,sourceVersionInvalidation:true,drawioEmbedProtocolFixture:true,revocation:true},null,2));
}catch(error){
 if(page){console.error((await page.locator('body').innerText()).slice(-2500));await page.screenshot({path:'/tmp/xingli-boards-failure.png',fullPage:true}).catch(()=>{});}
 throw error;
}finally{
 await browser?.close();if(server&&server.exitCode===null){const exit=once(server,'exit');server.kill('SIGTERM');await exit;}
 if(boardIds.length){await db.delete(shareLinks).where(inArray(shareLinks.targetId,boardIds));await db.delete(mindMaps).where(inArray(mindMaps.id,boardIds));}
 await db.delete(notes).where(eq(notes.workspaceId,ids.ws));await db.delete(notebooks).where(eq(notebooks.id,ids.nb));await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId,ids.ws));await db.delete(workspaces).where(eq(workspaces.id,ids.ws));await db.delete(sessions).where(eq(sessions.userId,ids.user));await db.delete(users).where(eq(users.id,ids.user));await sql.end();
}
