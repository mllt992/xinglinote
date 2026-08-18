// 圈子动态页、公开主页、分享页互动区的浏览器验收。
// 前提：dev 已起，Chrome 带 --remote-debugging-port=9223 且已登录。
const targets = await fetch('http://127.0.0.1:9223/json/list').then(r => r.json());
const t = targets.find(x => x.url.includes('127.0.0.1:12098'));
if (!t) throw new Error('没有找到已登录的 12098 页面');
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.j(m.error) : p.r(m.result); } };
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const cmd = (method, params = {}) => new Promise((r, j) => { const n = ++id; pending.set(n, { r, j }); ws.send(JSON.stringify({ id: n, method, params })); });
await cmd('Runtime.enable'); await cmd('Page.enable');
const ex = async expr => (await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const go = async url => { await cmd('Page.navigate', { url }); await new Promise(r => setTimeout(r, 2600)); };
const click = async selectorExpr => { const rect = await ex(`(()=>{const el=${selectorExpr};if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); if (!rect) return false; for (const type of ['mousePressed', 'mouseReleased']) await cmd('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 }); await new Promise(r => setTimeout(r, 700)); return true; };

await go('http://127.0.0.1:12098/app');
const wsId = await ex('location.pathname.split("/")[2]||""');
const handle = await ex(`(async()=>{const r=await fetch('/api/v1/me',{headers:{'X-Requested-With':'fetch'}});return (await r.json()).data.handle})()`);
const result = {};

// 顶栏「圈子」入口
result.headerHasCircle = await click(`[...document.querySelectorAll('header button')].find(x=>x.textContent.trim()==='圈子')`);
result.circleRouted = (await ex('location.pathname')).endsWith('/feed');
const feedPage = await ex('document.body.innerText');
result.feedPageRenders = feedPage.includes('圈子动态') && (feedPage.includes('发布') || feedPage.includes('还没有动态'));
// 圈子必须还待在系统里：顶栏留着工作区切换器和三处导航，不再是一个只剩「返回工作区」的孤岛
result.circleKeepsChrome = await ex(`!!document.querySelector('nav[aria-label="主导航"]') && !!document.querySelector('.workspace-label') && !document.body.innerText.includes('返回工作区')`);
result.circleNavMarksSelf = await ex(`[...document.querySelectorAll('nav[aria-label="主导航"] button')].some(b=>b.textContent.trim()==='圈子'&&b.getAttribute('aria-current')==='page')`);
result.circleRailRenders = feedPage.includes('圈子成员') && feedPage.includes('关于圈子');

// 发一条，看菜单里有转正与公开到广场
const posted = await ex(`(async()=>{const r=await fetch('/api/v1/posts',{method:'POST',headers:{'content-type':'application/json','X-Requested-With':'fetch'},body:JSON.stringify({body:'界面验收用的圈子动态',visibility:'workspace',workspaceId:'${wsId}'})});return (await r.json()).data.id})()`);
await go(`http://127.0.0.1:12098/w/${wsId}/feed`);
result.feedShowsPost = (await ex('document.body.innerText')).includes('界面验收用的圈子动态');
result.postMenuOpens = await click(`document.querySelector('button[aria-label="更多操作"]')`);
const menu = await ex(`document.querySelector('[role=menu]')?.innerText||''`);
result.menuHasPromote = menu.includes('转正为笔记');
result.menuHasPublishToSquare = menu.includes('公开到广场');
await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });

// 广场：同一条顶栏，能从这里点回笔记
await go('http://127.0.0.1:12098/');
const square = await ex('document.body.innerText');
result.squareRailRenders = square.includes('关于广场');
result.squareNavBackToNotes = await ex(`[...document.querySelectorAll('nav[aria-label="主导航"] button')].some(b=>b.textContent.trim()==='笔记')`);

// 公开主页
await go(`http://127.0.0.1:12098/u/${handle}`);
const profile = await ex('document.body.innerText');
result.profilePageRenders = profile.includes(`@${handle}`) && profile.includes('广场动态');

// 分享页：评论区带回复与验证码
const token = await ex(`(async()=>{const j=async(u,o)=>(await (await fetch(u,{...o,headers:{'content-type':'application/json','X-Requested-With':'fetch'}})).json()).data;
  const nbs=await j('/api/v1/workspaces/${wsId}/notebooks');
  const n=await j('/api/v1/notes',{method:'POST',body:JSON.stringify({notebookId:nbs.notebooks[0].id,title:'互动区验收'})});
  await j('/api/v1/notes/'+n.id,{method:'PATCH',body:JSON.stringify({expectedVersion:n.version,bodyMd:'一段可以拿来纠错的正文。'})});
  const s=await j('/api/v1/notes/'+n.id+'/shares',{method:'POST',body:JSON.stringify({commentsEnabled:true,correctionsEnabled:true})});
  return s.token+'|'+n.id})()`);
const [shareToken, noteId] = token.split('|');
await go(`http://127.0.0.1:12098/p/${shareToken}`);
const sharePage = await ex('document.body.innerText');
result.shareShowsComments = sharePage.includes('评论');
result.shareShowsCaptcha = /访客请作答[:：]?\s*\d+\s*\+\s*\d+/.test(sharePage);
result.shareShowsCorrectionEntry = sharePage.includes('提个纠错');

// 收尾：删掉验收产生的内容
await ex(`(async()=>{const h={'X-Requested-With':'fetch'};await fetch('/api/v1/posts/${posted}',{method:'DELETE',headers:h});await fetch('/api/v1/notes/${noteId}',{method:'DELETE',headers:h})})()`);
console.log(JSON.stringify(result, null, 2));
ws.close();
const failed = Object.entries(result).filter(([, v]) => !v).map(([k]) => k);
if (failed.length) { console.error('失败：' + failed.join(', ')); process.exitCode = 1; }
