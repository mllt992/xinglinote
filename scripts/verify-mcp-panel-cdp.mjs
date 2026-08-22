// MCP 钥匙界面的浏览器验收：新建表单的各项设置、列表操作、明文弹层。
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
const go = async url => { await cmd('Page.navigate', { url }); await new Promise(r => setTimeout(r, 2500)); };
const click = async selectorExpr => { const rect = await ex(`(()=>{const el=${selectorExpr};if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); if (!rect) return false; for (const type of ['mousePressed', 'mouseReleased']) await cmd('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 }); await new Promise(r => setTimeout(r, 500)); return true; };

await go('http://127.0.0.1:12098/app');
const wsId = await ex('location.pathname.split("/")[2]||""');
await go(`http://127.0.0.1:12098/w/${wsId}/settings/integrations`);
const result = {};
result.mcpTabOpens = await click(`[...document.querySelectorAll('[role=tab]')].find(x=>x.textContent.trim()==='MCP 钥匙')`);
const listText = await ex('document.body.innerText');
result.listShowsNewButton = listText.includes('新建钥匙');
result.noRawEnumInList = !/\bmanage\b|\bactive\b/.test(listText);

result.dialogOpens = await click(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('新建钥匙'))`);
const dialog = await ex(`document.querySelector('[role=dialog]')?.innerText||''`);
result.hasWorkspacePicker = /工作区/.test(dialog) && /可多选/.test(dialog) && (await ex(`!![...document.querySelectorAll('[role=dialog] input[type=checkbox]')].length`));
result.hasThreeTiers = ['只读', '读写', '全部'].every(x => dialog.includes(x));
result.hasNotebookScope = dialog.includes('跟随我的权限') && dialog.includes('指定笔记本');
result.hasExpiry = dialog.includes('永不过期') || dialog.includes('有效期');
result.hasUnlimitedDefault = dialog.includes('每日写入上限') && dialog.includes('默认不限');
result.hasAdvancedToggles = dialog.includes('允许删除') && dialog.includes('遵守 AI 索引开关') && dialog.includes('允许私密笔记本');
result.deleteToggleGatedByTier = await ex(`(()=>{const l=[...document.querySelectorAll('[role=dialog] label')].find(x=>x.textContent.includes('允许删除'));return !!l?.querySelector('input[disabled]')})()`);
// 切到「指定笔记本」后应出现可勾选的笔记本清单
await click(`[...document.querySelectorAll('[role=dialog] button')].find(x=>x.textContent.includes('指定笔记本'))`);
result.notebookListAppears = await ex(`document.querySelectorAll('[role=dialog] input[type=checkbox]').length > 3`);
console.log(JSON.stringify(result, null, 2));
ws.close();
if (!Object.values(result).every(Boolean)) process.exitCode = 1;
