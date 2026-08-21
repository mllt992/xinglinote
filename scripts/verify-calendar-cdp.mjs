// 日历界面验收（设计 16 §7.2）：拖拽改期与失败回滚、撤销、Alt 复制、拉伸改时长、
// 空白处划时段建日程、键盘全路径、月视图溢出展开、今天页与日记入口。
// 前提：pnpm dev 已起，Chrome 带 --remote-debugging-port=9223 且已登录。
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
const wait = ms => new Promise(r => setTimeout(r, ms));
const key = async k => { await ex(`window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true}))`); await wait(500); };
/** 页面内调 API：借页面已有的会话 Cookie，省得脚本自己再登一次。 */
const call = async (path, init = 'undefined') => ex(`fetch(${JSON.stringify(path)},${init === 'undefined' ? `{credentials:'include'}` : init}).then(r=>r.json()).then(j=>j.data)`);
const post = (path, body) => call(path, `{method:'POST',credentials:'include',headers:{'content-type':'application/json','X-Requested-With':'fetch'},body:${JSON.stringify(JSON.stringify(body))}}`);
const del = path => call(path, `{method:'DELETE',credentials:'include',headers:{'X-Requested-With':'fetch'}}`);

/** 鼠标按下—移动—抬起：React 的 onPointerDown 收得到，用来验拉伸与划时段。 */
async function dragMouse(from, to, steps = 6) {
  await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, button: 'left', buttons: 1 });
    await wait(40);
  }
  await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
  await wait(700);
}

await go('http://127.0.0.1:12098/app');
const wsId = await ex('location.pathname.split("/")[2]||""');
const result = {};

// —— 造数据：同一天九条，好验月视图溢出；一条带时长的日程，好验拉伸 ——
// 九条而不是五条：月视图每格显示几条按实测格高算（上限 6），五条在大屏上塞得下，就验不到溢出了
const day = '2027-09-17';
const at = h => `2027-09-17T0${h}:00:00.000Z`;
const seeded = [];
for (let i = 0; i < 9; i++) seeded.push((await post(`/api/v1/workspaces/${wsId}/calendar/items`, { kind: 'task', title: `验收待办${i + 1}`, dueAt: at(1 + i) })).id);
const meeting = await post(`/api/v1/workspaces/${wsId}/calendar/items`, { kind: 'event', title: '验收会议', startsAt: at(2), endsAt: at(3) });
const itemsOf = async () => call(`/api/v1/workspaces/${wsId}/calendar?from=2027-09-01T00:00:00.000Z&to=2027-09-30T00:00:00.000Z`).then(d => d.items);

// —— 月视图：溢出不是死的「还有 N 项」，点开就地展开 ——
await go(`http://127.0.0.1:12098/w/${wsId}/calendar?view=month&date=${day}`);
const cellText = `[...document.querySelectorAll('[role="gridcell"]')].find(el=>el.innerText.includes('验收待办1'))`;
result.monthShowsOverflow = (await ex(`(${cellText})?.innerText.includes('还有')`)) === true;
await ex(`(()=>{const cell=${cellText};const b=[...cell.querySelectorAll('button')].find(x=>x.innerText.includes('还有'));b&&b.click()})()`);
await wait(500);
result.monthOverflowExpandsInPlace = (await ex(`(${cellText})?.innerText.includes('验收待办5')`)) === true && (await ex('location.search.includes("view=month")')) === true;

// —— 键盘：视图、今天、快速添加、Esc ——
for (const [k, want] of [['d', 'view=day'], ['w', 'view=week'], ['a', 'view=agenda'], ['m', 'view=month']]) {
  await key(k);
  result[`key_${k}`] = (await ex('location.search')).includes(want);
}
await key('n');
result.key_n_opensQuickAdd = (await ex(`!!document.querySelector('input[placeholder*="和销售团队"]')`)) === true;
await key('Escape');
result.key_escape_closes = (await ex(`!document.querySelector('input[placeholder*="和销售团队"]')`)) === true;

// —— 拖拽改期：用真实的 DragEvent 走组件自己的 onDrop ——
const dropOn = async (itemId, targetDay, altKey = false) => ex(`(async()=>{
  const chip=[...document.querySelectorAll('[role="gridcell"]')].flatMap(c=>[...c.querySelectorAll('div')]).find(d=>d.getAttribute('draggable')==='true'&&d.innerText.includes('验收待办1'));
  const cell=[...document.querySelectorAll('[role="gridcell"]')].find(el=>el.innerText.includes(${JSON.stringify(targetDay)}));
  if(!chip||!cell)return 'missing';
  const dt=new DataTransfer();
  dt.setData('text/kb-item',JSON.stringify({id:${JSON.stringify(itemId)},occurrenceStart:null}));
  for(const type of ['dragstart','dragover','drop']){
    const el=type==='dragstart'?chip:cell;
    el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt,altKey:${altKey}}));
  }
  return 'ok';
})()`);

await go(`http://127.0.0.1:12098/w/${wsId}/calendar?view=month&date=${day}`);
// 目标格：找一个写着「20」的格子（同月，日期唯一）
result.dragDispatched = (await dropOn(seeded[0], '20')) === 'ok';
await wait(1600);
const afterDrag = (await itemsOf()).find(i => i.id === seeded[0]);
result.dragReschedules = afterDrag?.dueAt.startsWith('2027-09-19') || afterDrag?.dueAt.startsWith('2027-09-20');
result.dragShowsUndo = (await ex(`document.body.innerText.includes('撤销')`)) === true;

// —— 撤销：点 toast 里的「撤销」回到原位 ——
await ex(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='撤销');b&&b.click()})()`);
await wait(1600);
result.undoRestores = ((await itemsOf()).find(i => i.id === seeded[0])?.dueAt ?? '').startsWith('2027-09-17');

// —— Alt 拖拽 = 复制一份，原件留在原地 ——
const before = (await itemsOf()).length;
await dropOn(seeded[0], '20', true);
await wait(1600);
const afterCopy = await itemsOf();
result.altDragCopies = afterCopy.length === before + 1 && afterCopy.filter(i => i.title === '验收待办1').length === 2;

// —— 失败回滚：条目已被别处删掉，拖它必须报错并回到原位，而不是留在错误位置 ——
const doomed = await post(`/api/v1/workspaces/${wsId}/calendar/items`, { kind: 'task', title: '会失败的一条', dueAt: at(6) });
await go(`http://127.0.0.1:12098/w/${wsId}/calendar?view=month&date=${day}`);
await del(`/api/v1/calendar/items/${doomed.id}`);
await ex(`(async()=>{const cell=[...document.querySelectorAll('[role="gridcell"]')].find(el=>el.innerText.includes('20'));const dt=new DataTransfer();dt.setData('text/kb-item',JSON.stringify({id:${JSON.stringify(doomed.id)},occurrenceStart:null}));cell.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));cell.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));})()`);
await wait(1600);
result.failureShowsError = (await ex(`document.body.innerText.includes('操作失败')`)) === true;
result.failureLeavesNothingBehind = !(await ex(`document.body.innerText.includes('会失败的一条')`));

// —— 周视图：拉伸改时长 ——
await go(`http://127.0.0.1:12098/w/${wsId}/calendar?view=week&date=${day}`);
const handle = await ex(`(()=>{const el=[...document.querySelectorAll('[data-kb-item]')].find(d=>d.innerText.includes('验收会议'));if(!el)return null;el.scrollIntoView({block:'center'});const h=el.querySelector('[role="separator"]');const r=h.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
if (handle) await dragMouse(handle, { x: handle.x, y: handle.y + 96 });
const resized = (await itemsOf()).find(i => i.id === meeting.id);
result.resizeChangesDuration = !!handle && new Date(resized.endsAt) - new Date(resized.startsAt) > 3600000;

// —— 周视图：空白处划时段，就地建日程，回车即存 ——
await go(`http://127.0.0.1:12098/w/${wsId}/calendar?view=week&date=${day}`);
const blank = await ex(`(()=>{const col=[...document.querySelectorAll('[data-kb-col]')].pop();const r=col.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+520}})()`);
await dragMouse(blank, { x: blank.x, y: blank.y + 90 });
result.blankDragOpensDraft = (await ex(`!!document.querySelector('input[placeholder*="回车即存"]')`)) === true;
await ex(`(()=>{const i=document.querySelector('input[placeholder*="回车即存"]');if(!i)return;const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;setter.call(i,'划出来的日程');i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`);
await wait(1800);
result.blankDragCreatesEvent = (await itemsOf()).some(i => i.title === '划出来的日程' && i.kind === 'event');

// —— 今天页与日记入口 ——
await go(`http://127.0.0.1:12098/w/${wsId}/today`);
const todayText = await ex('document.body.innerText');
result.todayPageRenders = ['今天要做', '今天的日程', '今天写过的笔记'].every(s => todayText.includes(s));
result.todayHasDiaryEntry = todayText.includes('写今天的日记');
await ex(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('写今天的日记'));b&&b.click()})()`);
await wait(2600);
result.diaryOpensNote = (await ex('location.pathname')).includes(`/w/${wsId}/n/`);

console.log(JSON.stringify(result, null, 2));
if (!Object.values(result).every(Boolean)) process.exitCode = 1;
ws.close();
