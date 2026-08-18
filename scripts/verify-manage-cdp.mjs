// 新界面的浏览器验收：通知铃、导入按钮、备份与审计页。
// 前提：dev 已起，Chrome 带 --remote-debugging-port=9223 且已登录 127.0.0.1:12098。
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
const go = async url => { await cmd('Page.navigate', { url }); await new Promise(r => setTimeout(r, 2500)); };

await go('http://127.0.0.1:12098/app');
const wsId = await ex('location.pathname.split("/")[2]||""');
if (!wsId) throw new Error('没进到工作区，可能未登录');

const header = {
  bell: await ex('!!document.querySelector(\'header button[aria-label*="通知"]\')'),
  importButton: await ex('[...document.querySelectorAll("aside button")].some(b=>b.querySelector("svg.lucide-upload"))'),
  manageMenuItem: false,
};
await go(`http://127.0.0.1:12098/w/${wsId}/manage`);
const page = await ex('document.body.innerText');
const result = {
  bellInHeader: header.bell,
  importButtonInTree: header.importButton,
  managePageLoads: page.includes('工作区管理'),
  hasAllTabs: ['备份', '分享', '导出与恢复', '审计日志', '冻结'].every(x => page.includes(x)),
  backupPanelRenders: page.includes('新增目标') && (page.includes('还没有备份目标') || page.includes('运行记录')),
  tabsSwitch: false,
};
// 切到「导出与恢复」。Radix 的 Tab 听的是 mousedown，所以要发真的鼠标事件而不是 el.click()
const rect = await ex('(()=>{const b=[...document.querySelectorAll("[role=tab]")].find(x=>x.textContent.trim()==="导出与恢复");if(!b)return null;const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
const clicked = !!rect;
if (rect) for (const type of ['mousePressed', 'mouseReleased']) await cmd('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 600));
result.tabsSwitch = clicked && (await ex('document.body.innerText')).includes('导出工作区');
// 右侧面板里的附件区
const noteId = await ex(`(async()=>{const j=async u=>(await (await fetch(u,{headers:{'X-Requested-With':'fetch'}})).json()).data;const nbs=await j('/api/v1/workspaces/${wsId}/notebooks');const tree=await j('/api/v1/notebooks/'+nbs.notebooks[0].id+'/tree');return tree.notes[0]?.id??''})()`);
if (noteId) {
  await go(`http://127.0.0.1:12098/w/${wsId}/n/${noteId}`);
  const toggle = await ex('(()=>{const b=[...document.querySelectorAll("button")].find(x=>x.querySelector("svg.lucide-panel-right"));if(!b)return null;const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
  if (toggle) for (const type of ['mousePressed', 'mouseReleased']) await cmd('Input.dispatchMouseEvent', { type, x: toggle.x, y: toggle.y, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 700));
  const panel = await ex('document.body.innerText');
  result.attachmentSectionInPanel = panel.includes('附件') && panel.includes('反向链接');
} else result.attachmentSectionInPanel = false;
console.log(JSON.stringify(result, null, 2));
ws.close();
if (!Object.values(result).every(Boolean)) process.exitCode = 1;
