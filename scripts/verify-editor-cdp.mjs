// 编辑器验收（设计 03、17、规格 §9.2）：CodeMirror 6 内核、源码字节保真、Live Preview、
// 快捷键、列表续行、查找面板、`[[` 补全、分栏滚动同步，以及预览侧的公式 / 任务 / 表格 / 双链。
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
const wait = ms => new Promise(r => setTimeout(r, ms));
const go = async url => { await cmd('Page.navigate', { url }); await wait(2800); };
const click = async selectorExpr => { const rect = await ex(`(()=>{const el=${selectorExpr};if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); if (!rect) return false; for (const type of ['mousePressed', 'mouseReleased']) await cmd('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 }); await wait(400); return true; };
const type = async text => { for (const ch of text) await cmd('Input.dispatchKeyEvent', { type: 'char', text: ch }); await wait(350); };
/** 组合键与功能键：CodeMirror 收的是 keydown，所以用 rawKeyDown。ctrl = 2，shift = 8。 */
const press = async (key, code, vk, ctrl = false, shift = false) => {
  const modifiers = (ctrl ? 2 : 0) + (shift ? 8 : 0);
  for (const type of ['rawKeyDown', 'keyUp']) await cmd('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await wait(320);
};
const toEnd = () => press('End', 'End', 35, true);
/** 编辑器可见文本。Live Preview 会把标记藏起来，所以这读到的不一定等于源码。 */
const shown = () => ex(`(()=>{const el=document.querySelector('.cm-content');return el?el.innerText.replace(/\\u00a0/g,' '):''})()`);
/** 全选一次让所有行露出原文，读完再把光标收到文末——这同时验证了「光标所在行显示原样式子」。 */
const source = async () => { await press('a', 'KeyA', 65, true); const text = await shown(); await toEnd(); return text; };
const call = async (path, init = '{}') => ex(`fetch(${JSON.stringify(path)},{credentials:'include',headers:{'X-Requested-With':'fetch','content-type':'application/json'},...${init}}).then(r=>r.json()).then(j=>j.data)`);
/** 自动保存是 850ms debounce，等状态条落到「已保存」再断言。 */
const settle = async () => { for (let i = 0; i < 14; i++) { if (await ex(`document.body.innerText.includes('已保存 · v')`)) return true; await wait(400); } return false; };
/** KaTeX 是按需加载的，跟公式有关的断言要能等它下完。 */
const until = async expr => { for (let i = 0; i < 12; i++) { if (await ex(expr)) return true; await wait(400); } return false; };

const NL = String.fromCharCode(10);
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const SEED = [
  '# 验收标题',
  '',
  '质能方程 $E=mc^2$ 收尾，还有 **粗体** 和 `代码`。',
  '',
  '- [ ] 甲项',
  '- [x] 乙项',
  '',
  '| 列一 | 列二 |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '看 [[验收标题]] 与 [外链](https://example.com)。',
  '',
  `![像素](${PIXEL})`,
  '',
  '$$',
  '\\frac{a}{b} = c',
  '$$',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '```mermaid',
  'flowchart TD',
  '  A[开始] --> B[结束]',
  '```',
  '',
  ...Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 段填充正文，用来把编辑器撑出滚动条。`),
].join(NL);

await go('http://127.0.0.1:12098/app');
const wsId = await ex('location.pathname.split("/")[2]||""');
const result = {};

const nbs = await call(`/api/v1/workspaces/${wsId}/notebooks`);
const nbId = await ex(`(${JSON.stringify(nbs)}).notebooks[0].id`);
const note = await call('/api/v1/notes', `{method:'POST',body:${JSON.stringify(JSON.stringify({ notebookId: nbId, title: '编辑器验收' }))}}`);
const noteId = note.id;
await call(`/api/v1/notes/${noteId}`, `{method:'PATCH',body:${JSON.stringify(JSON.stringify({ expectedVersion: note.version, bodyMd: SEED }))}}`);
await go(`http://127.0.0.1:12098/w/${wsId}/n/${noteId}`);

// —— 一、内核 ——
result.usesCodeMirror = await ex(`!!document.querySelector('.cm-editor .cm-content')`);
result.oldTextareaGone = await ex(`!document.querySelector('textarea.editor-textarea')`);
result.syntaxTokenised = await ex(`document.querySelectorAll('.cm-content .cm-line span').length > 0`);
result.softWrapOn = await ex(`!!document.querySelector('.cm-lineWrapping')`);

// —— 二、字节保真：全选露出原文后，编辑器里的文本必须和库里存的一模一样 ——
await click(`document.querySelector('.cm-content')`);
result.docIsExactSource = (await source()) === SEED;

// —— 三、Live Preview：标记平时藏着，光标落到那一行就露出来 ——
await toEnd();
const idle = await shown();
result.hidesMarkersWhenIdle = !idle.includes('# 验收标题') && idle.includes('验收标题');
await press('Home', 'Home', 36, true);          // Ctrl+Home 回到第一行
const onHeading = await shown();
result.revealsMarkersOnCursorLine = onHeading.includes('# 验收标题');
result.rendersInlineMath = await until(`!!document.querySelector('.cm-content .cm-md-math .katex')`);
result.rendersImage = await ex(`!!document.querySelector('.cm-content img.cm-md-image')`);
result.rendersTaskCheckbox = await ex(`document.querySelectorAll('.cm-content input.cm-md-task').length === 2`);
result.rendersWikiChip = await ex(`!!document.querySelector('.cm-content .cm-md-wiki')`);
result.rendersBullet = await ex(`!!document.querySelector('.cm-content .cm-md-bullet')`);
result.rendersBlockMath = await until(`!!document.querySelector('.cm-content .cm-md-math-block .katex')`);

// —— 四、勾选任务：只翻一个字符 ——
const beforeTask = (await call(`/api/v1/notes/${noteId}`)).bodyMd;
await click(`document.querySelector('.cm-content input.cm-md-task')`);
await settle();
const afterTask = (await call(`/api/v1/notes/${noteId}`)).bodyMd;
result.taskToggleFlipsOneChar = afterTask === beforeTask.replace('- [ ] 甲项', '- [x] 甲项') && afterTask !== beforeTask;

// —— 五、打字与自动保存 ——
await click(`document.querySelector('.cm-content')`);
await toEnd();
await type('尾巴');
result.autoSavedAfterTyping = await settle();
const saved = await call(`/api/v1/notes/${noteId}`);
result.savedBytesMatch = saved.bodyMd === afterTask + '尾巴';

// —— 六、快捷键：Ctrl+B 包粗体，Ctrl+Z 原样退回 ——
await press('a', 'KeyA', 65, true);
await press('b', 'KeyB', 66, true);
const bolded = await shown();
result.boldWrapsSelection = bolded.startsWith('**') && bolded.trimEnd().endsWith('**');
await press('z', 'KeyZ', 90, true);
result.undoRestoresBytes = (await source()) === afterTask + '尾巴';

// —— 七、列表续行 ——
await toEnd();
await press('Enter', 'Enter', 13);
await type('- 丙项');
await press('Enter', 'Enter', 13);
result.listContinues = (await shown()).trimEnd().endsWith('- ');
for (let i = 0; i < 5; i++) await press('z', 'KeyZ', 90, true);

// —— 八、`[[` 补全 ——
await toEnd();
await press('Enter', 'Enter', 13);
await type('[[验收');
await wait(900);
result.wikiCompletionOpens = await ex(`!!document.querySelector('.cm-tooltip-autocomplete li')`);
result.wikiCompletionHitsTitle = await ex(`[...document.querySelectorAll('.cm-tooltip-autocomplete li')].some(li=>li.textContent.includes('编辑器验收'))`);
await press('Escape', 'Escape', 27);
for (let i = 0; i < 8; i++) await press('z', 'KeyZ', 90, true);

// —— 八点五、斜杠菜单：只在行首触发，选中后把这一行变成对应标记 ——
await click(`document.querySelector('.cm-content')`);
await toEnd();
await press('Enter', 'Enter', 13);
await type('/二级');
await wait(700);
result.slashMenuOpens = await ex(`!!document.querySelector('.cm-tooltip-autocomplete li')`);
await press('Enter', 'Enter', 13);
await wait(400);
result.slashMenuInserts = (await shown()).trimEnd().endsWith('## ');
// 句子中间的斜杠不该弹菜单
await type('路径 a/b');
await wait(600);
result.slashMenuIgnoresMidLine = await ex(`!document.querySelector('.cm-tooltip-autocomplete li')`);
for (let i = 0; i < 10; i++) await press('z', 'KeyZ', 90, true);

// —— 九、查找替换面板 ——
await click(`document.querySelector('.cm-content')`);
await press('f', 'KeyF', 70, true);
result.searchPanelOpens = await ex(`!!document.querySelector('.cm-panel.cm-search input')`);
await press('Escape', 'Escape', 27);

// —— 十、分栏滚动同步：编辑器滚到底，预览跟着走 ——
const viewport = `[...document.querySelectorAll('[data-radix-scroll-area-viewport]')].find(v=>v.querySelector('.markdown'))`;
result.previewHasSourceLines = await ex(`!!(${viewport})?.querySelector('[data-line]')`);
await ex(`(${viewport}).scrollTop = 0`);
await click(`document.querySelector('.cm-content')`);
await toEnd();
await wait(900);
result.previewFollowsEditor = await ex(`((${viewport})?.scrollTop ?? 0) > 40`);

// —— 十点五、P2 外壳：折叠、拖拽记忆、底栏、命令面板、全屏 ——
const colsOf = `getComputedStyle(document.querySelector('.app-grid')).gridTemplateColumns`;
// 用 [0-9] 而不是 \d：这串要经模板字面量再进 Runtime.evaluate，少一层反斜杠少一个坑。
result.statusBarShowsCounts = await ex(`/[0-9]+ 字/.test(document.body.innerText) && document.body.innerText.includes('已保存 · v')`);
result.statusBarShowsCursor = await ex(`/第 [0-9]+ 行 第 [0-9]+ 列/.test(document.body.innerText)`);

const wideCols = await ex(colsOf);
await click(`document.querySelector('button[aria-label="折叠或展开左侧栏"]')`);
await wait(500);
result.sidebarCollapses = await ex(`!document.querySelector('.notebook-panel') && !document.querySelector('.tree-panel')`);
await click(`document.querySelector('button[aria-label="折叠或展开左侧栏"]')`);
await wait(500);
result.sidebarRestores = (await ex(colsOf)) === wideCols;

// 拖一下笔记本栏，宽度要变且要落进 localStorage
const handle = await ex(`(()=>{const el=document.querySelector('[aria-label="调整笔记本栏宽度"]');if(!el)return null;const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+120}})()`);
if (handle) {
  await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x + i * 10, y: handle.y, button: 'left', buttons: 1 });
  await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x + 60, y: handle.y, button: 'left', clickCount: 1 });
  await wait(600);
}
result.sidebarResizes = (await ex(colsOf)) !== wideCols;
result.sidebarWidthPersisted = await ex(`(JSON.parse(localStorage.getItem('kb.layout')||'{}').notebooksWidth ?? 0) > 224`);

await ex(`(()=>{const el=document.querySelector('button[aria-label="命令面板"]');el&&el.click()})()`);
await wait(600);
result.commandPaletteOpens = await ex(`!!document.querySelector('input[placeholder="输入命令…"]')`);
await type('全屏');
result.commandPaletteFilters = await ex(`[...document.querySelectorAll('[role=dialog] button')].some(b=>b.textContent.includes('全屏'))`);
await press('Escape', 'Escape', 27);
await wait(400);

await ex(`(()=>{const el=document.querySelector('button[aria-label="编辑器全屏"]');el&&el.click()})()`);
await wait(700);
result.fullscreenHidesChrome = await ex(`!document.querySelector('.notebook-panel') && !document.querySelector('.tree-panel')`);
await press('Escape', 'Escape', 27);
await wait(700);
result.fullscreenExits = await ex(`!!document.querySelector('.notebook-panel')`);

// —— 十点六、即时渲染（Typora 模式）：元素粒度、表格就地渲染、比例字体 ——
await click(`document.querySelector('.cm-content')`);
await press('Home', 'Home', 36, true);
result.wysiwygOnByDefault = await ex(`!!document.querySelector('[data-editor="markdown"][data-wysiwyg="1"]')`);
// 光标停在第一行（标题），同一行之外的表格该已经渲成真表格
result.wysiwygRendersTable = await until(`!!document.querySelector('.cm-content .cm-md-table table')`);
result.wysiwygProportionalFont = await ex(`(()=>{const el=document.querySelector('[data-wysiwyg="1"] .cm-scroller');if(!el)return false;const f=getComputedStyle(el).fontFamily;return !/mono/i.test(f)})()`);
result.wysiwygCodeStaysMono = await ex(`(()=>{const el=document.querySelector('.cm-md-code-line');return !!el && /mono/i.test(getComputedStyle(el).fontFamily)})()`);
// 元素粒度：光标在标题行，同一行里的行内标记该露出；换到别处该重新藏起来
result.wysiwygRevealsByElement = await ex(`!document.querySelector('.cm-content').innerText.includes('**')`);
// 切回源码模式后表格该回到源码
await ex(`(()=>{const el=document.querySelector('button[aria-label="切换即时渲染"]');el&&el.click()})()`);
await wait(700);
result.sourceModeDropsTable = await ex(`!document.querySelector('.cm-content .cm-md-table')`);
await ex(`(()=>{const el=document.querySelector('button[aria-label="切换即时渲染"]');el&&el.click()})()`);
await wait(600);

// —— 十点七、正文栏宽：表格吃满整栏、表头不换行、正文保持易读行宽、左边缘对齐 ——
await click(`[...document.querySelectorAll('[role=tab]')].find(x=>x.textContent.trim()==='预览')`);
await wait(600);
const layout = await ex(`(()=>{
  const box=document.querySelector('[data-note-preview]');
  const wrap=document.querySelector('.markdown .table-scroll');
  const table=document.querySelector('.markdown table');
  const th=document.querySelector('.markdown th');
  const p=document.querySelector('.markdown > p');
  if(!box||!wrap||!table||!th||!p) return null;
  const cs=getComputedStyle(th);
  const lines=Math.round((th.getBoundingClientRect().height-parseFloat(cs.paddingTop)-parseFloat(cs.paddingBottom))/parseFloat(cs.lineHeight));
  return {box:box.getBoundingClientRect().width, table:table.getBoundingClientRect().width,
    para:p.getBoundingClientRect().width, headerLines:lines,
    sameLeft:Math.abs(table.getBoundingClientRect().left-p.getBoundingClientRect().left)<2,
    pageOverflows:document.documentElement.scrollWidth>window.innerWidth+1};
})()`);
result.tableUsesFullColumn = !!layout && layout.table > layout.box * 0.9;
result.tableHeaderNotWrapped = !!layout && layout.headerLines === 1;
result.proseKeepsMeasure = !!layout && layout.para <= 760 && layout.para < layout.table;
result.contentSharesLeftEdge = !!layout && layout.sameLeft;
result.noHorizontalPageScroll = !!layout && !layout.pageOverflows;

// —— 十一、预览侧的闭集渲染 ——
await click(`[...document.querySelectorAll('[role=tab]')].find(x=>x.textContent.trim()==='预览')`);
await wait(700);
result.previewRendersMath = await until(`!!document.querySelector('.markdown .math[data-math-done] .katex')`);
result.katexLoadedLazily = await ex(`performance.getEntriesByType('resource').some(r=>r.name.includes('katex'))`);
result.previewRendersDiagram = await until(`!!document.querySelector('.markdown .diagram[data-diagram-theme] svg')`);
result.mermaidLoadedLazily = await ex(`performance.getEntriesByType('resource').some(r=>/mermaid/i.test(r.name))`);
// 图画出来了，源码仍是原样那段 fence —— 渲染绝不回写正文（设计 17 §2）。
result.diagramKeepsSource = (await call(`/api/v1/notes/${noteId}`)).bodyMd.includes('```mermaid');
result.previewRendersTaskList = await ex(`document.querySelectorAll('.markdown input.task-checkbox').length === 2`);
result.previewRendersTable = await ex(`!!document.querySelector('.markdown table')`);
result.previewRendersWiki = await ex(`!!document.querySelector('.markdown .wiki')`);
result.previewHeadingHasAnchor = await ex(`!!document.querySelector('.markdown h1[id]')`);

// —— 十二、跨篇切换不会误标脏 ——
const settled = (await call(`/api/v1/notes/${noteId}`)).bodyMd;
await go(`http://127.0.0.1:12098/w/${wsId}/n/${noteId}`);
await wait(1600);
result.openingCleanStaysClean = await ex(`!document.body.innerText.includes('未保存')`);
result.openingDoesNotSave = (await call(`/api/v1/notes/${noteId}`)).bodyMd === settled;

await ex(`fetch('/api/v1/notes/${noteId}',{method:'DELETE',headers:{'X-Requested-With':'fetch'}})`);   // 验收样例用完就删

console.log(JSON.stringify(result, null, 2));
ws.close();
const failed = Object.entries(result).filter(([, v]) => !v).map(([k]) => k);
if (failed.length) { console.error('失败：' + failed.join(', ')); process.exitCode = 1; }
