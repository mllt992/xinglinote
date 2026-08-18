// 本轮界面补齐的浏览器验收：搜索过滤条、分享对话框、回收站销毁、工作区管理的分享页。
// 前提：dev 已起，Chrome 带 --remote-debugging-port=9223 且已登录。
const targets = await fetch('http://127.0.0.1:9223/json/list').then(r => r.json());
const t = targets.find(x => x.url.includes('127.0.0.1:5174'));
if (!t) throw new Error('没有找到已登录的 5174 页面');
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.j(m.error) : p.r(m.result); } };
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const cmd = (method, params = {}) => new Promise((r, j) => { const n = ++id; pending.set(n, { r, j }); ws.send(JSON.stringify({ id: n, method, params })); });
await cmd('Runtime.enable'); await cmd('Page.enable');
const ex = async expr => (await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const go = async url => { await cmd('Page.navigate', { url }); await new Promise(r => setTimeout(r, 2600)); };
const click = async selectorExpr => { const rect = await ex(`(()=>{const el=${selectorExpr};if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); if (!rect) return false; for (const type of ['mousePressed', 'mouseReleased']) await cmd('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 }); await new Promise(r => setTimeout(r, 600)); return true; };
const type = async text => { for (const ch of text) await cmd('Input.dispatchKeyEvent', { type: 'char', text: ch }); await new Promise(r => setTimeout(r, 900)); };

await go('http://127.0.0.1:5174/app');
const wsId = await ex('location.pathname.split("/")[2]||""');
const result = {};

// 搜索面板：范围切换与仅标题
await click(`document.querySelector('header input[placeholder*="搜索"]')`);
await type('验收');
const panel = await ex(`(()=>{const el=[...document.querySelectorAll('div')].find(d=>d.className.includes('top-11'));return el?el.innerText:''})()`);
result.searchFilterBar = panel.includes('仅本工作区') && panel.includes('仅标题');
result.searchScopeToggles = await click(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='仅本工作区')`);
result.searchScopeSwitched = (await ex(`(()=>{const el=[...document.querySelectorAll('div')].find(d=>d.className.includes('top-11'));return el?el.innerText:''})()`)).includes('全部工作区');
await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });

// 工作区管理：分享页
await go(`http://127.0.0.1:5174/w/${wsId}/manage`);
const manage = await ex('document.body.innerText');
result.manageHasSharesTab = manage.includes('分享') && manage.includes('工作区管理');
result.sharesTabOpens = await click(`[...document.querySelectorAll('[role=tab]')].find(x=>x.textContent.trim()==='分享')`);
const sharesText = await ex('document.body.innerText');
result.sharesPanelRenders = sharesText.includes('分享链接') || sharesText.includes('全部分享') || sharesText.includes('自己创建');

// 回收站：销毁按钮与删除人信息
await go(`http://127.0.0.1:5174/w/${wsId}/trash`);
result.trashHasPurge = await ex(`!!document.querySelector('button[aria-label="立即销毁"]') || document.body.innerText.includes('回收站是空的')`);

// 笔记页：分享对话框的单节选项与标签区
// 现建一篇带小标题的笔记，单节分享的下拉只有存在标题时才出现
const noteId = await ex(`(async()=>{const call=async(u,o)=>(await (await fetch(u,{...o,headers:{'X-Requested-With':'fetch','content-type':'application/json'}})).json()).data;
  const nbs=await call('/api/v1/workspaces/${wsId}/notebooks');
  const n=await call('/api/v1/notes',{method:'POST',body:JSON.stringify({notebookId:nbs.notebooks[0].id,title:'界面验收样例'})});
  await call('/api/v1/notes/'+n.id,{method:'PATCH',body:JSON.stringify({expectedVersion:n.version,bodyMd:'# 第一节'+String.fromCharCode(10)+'正文。'+String.fromCharCode(10,10)+'## 第二节'+String.fromCharCode(10)+'更多正文。'})});
  return n.id})()`);
if (noteId) {
  await go(`http://127.0.0.1:5174/w/${wsId}/n/${noteId}`);
  await click(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='分享')`);
  const dialog = await ex(`document.querySelector('[role=dialog]')?.innerText||''`);
  result.shareDialogHasToggles = dialog.includes('允许纠错建议') && dialog.includes('显示反向链接');
  result.shareDialogHasSectionPicker = await ex(`(()=>{const s=document.querySelector('[role=dialog] select');return !!s&&[...document.querySelectorAll('[role=dialog] option')].some(o=>o.textContent.includes('只分享这一节')||o.textContent.includes('分享整篇'))})()`);
  await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await new Promise(r => setTimeout(r, 500));
  await click(`[...document.querySelectorAll('button')].find(x=>x.querySelector('svg.lucide-panel-right'))`);
  const side = await ex('document.body.innerText');
  result.tagEditorInPanel = side.includes('标签') && (await ex(`!!document.querySelector('input[placeholder="加标签…"]')`));
  await ex(`fetch('/api/v1/notes/${noteId}',{method:'DELETE',headers:{'X-Requested-With':'fetch'}})`);   // 验收样例用完就删
} else { result.shareDialogHasToggles = result.shareDialogHasSectionPicker = result.tagEditorInPanel = false; }

console.log(JSON.stringify(result, null, 2));
ws.close();
const failed = Object.entries(result).filter(([, v]) => !v).map(([k]) => k);
if (failed.length) { console.error('失败：' + failed.join(', ')); process.exitCode = 1; }
