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
// 点某一格只在格内露出输入框，整张表仍保持渲染；保存后只改这格的 Markdown 内容
await click(`document.querySelector('.cm-content .cm-md-table tbody td')`);
result.wysiwygEditsOneCell = await ex(`!!document.querySelector('.cm-md-table table .cm-table-cell-input') && !!document.querySelector('.cm-md-table table')`);
await type('改');
await press('Enter', 'Enter', 13);
await settle();
const cellEdited = (await call(`/api/v1/notes/${noteId}`)).bodyMd;
result.wysiwygCellEditWritesMarkdown = /\|\s*1改\s*\|\s*2\s*\|/.test(cellEdited);
result.wysiwygTableStaysRendered = await until(`!!document.querySelector('.cm-content .cm-md-table table')`);
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

// —— 十点八、P8/P9：编辑侧行宽、悬挂缩进、块感、无障碍、粘贴、斜杠别名、Tab 的归属 ——
await click(`[...document.querySelectorAll('[role=tab]')].find(x=>x.textContent.trim()==='编辑')`);
await wait(700);
const shell = await ex(`(()=>{
  const content=document.querySelector('.cm-content');
  const prose=[...document.querySelectorAll('.cm-line')].find(l=>!l.classList.contains('cm-md-code-line'));
  const code=document.querySelector('.cm-md-code-line');
  if(!content||!prose||!code) return null;
  return {
    proseMax: parseFloat(getComputedStyle(prose).maxWidth) || 0,
    codeMax: getComputedStyle(code).maxWidth,
    hang: document.querySelectorAll('.cm-md-hang').length,
    hangStyle: document.querySelector('.cm-md-hang')?.getAttribute('style') || '',
    heading: document.querySelectorAll('.cm-md-heading').length,
    blockFirst: document.querySelectorAll('.cm-md-code-line.cm-md-block-first').length,
    blockLast: document.querySelectorAll('.cm-md-code-line.cm-md-block-last').length,
    activeLine: document.querySelectorAll('.cm-activeLine').length,
    aria: content.getAttribute('aria-label') || '',
    spell: content.getAttribute('spellcheck'),
  };
})()`);
// 正文行收在易读行宽内，代码行可以吃满整栏（设计 17 §3.2）
result.editorProseKeepsMeasure = !!shell && shell.proseMax > 0 && shell.proseMax <= 760;
result.editorCodeUsesFullColumn = !!shell && shell.codeMax === 'none';
// 列表悬挂缩进（§3.7）：首行原地、折行对齐正文起点
result.listHangingIndent = !!shell && shell.hang > 0 && /padding-left:\s*\d+ch/.test(shell.hangStyle) && /text-indent:\s*-\d+ch/.test(shell.hangStyle);
result.headingLineMarked = !!shell && shell.heading > 0;
// 代码块首尾行各收一个圆角，中间连成一整块
result.codeBlockHasCorners = !!shell && shell.blockFirst > 0 && shell.blockLast > 0;
// 即时渲染下不高亮当前行（§3.1）：一条横贯正文的底色会把段落切碎
result.wysiwygDropsActiveLine = !!shell && shell.activeLine === 0;
// 无障碍（§3.9）：CodeMirror 只给了 role/aria-multiline，名字要自己补；拼写检查默认开
result.contentHasAriaLabel = !!shell && shell.aria.length > 0;
result.spellcheckOn = !!shell && shell.spell === 'true';

// 富文本粘贴转闭集内的 Markdown（§3.6），顺带验一遍脚本与 javascript: 被消毒掉
const pasted = await ex(`(()=>{
  const view=document.querySelector('.cm-content');
  if(!view) return null;
  const dt=new DataTransfer();
  dt.setData('text/plain','小标题 甲 乙');
  dt.setData('text/html','<h3>小标题<\\/h3><ul><li>甲<\\/li><li>乙<\\/li><\\/ul><a href="javascript:alert(1)">恶意<\\/a><script>alert(2)<\\/script>');
  view.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
  return document.querySelector('.cm-content').innerText;
})()`);
result.pasteHtmlBecomesMarkdown = typeof pasted === 'string' && pasted.includes('小标题') && pasted.includes('甲');
result.pasteHtmlDropsScript = typeof pasted === 'string' && !pasted.includes('javascript:') && !pasted.includes('alert(2)');
await press('z', 'KeyZ', 90, true);     // 撤销刚粘进去的那段，别把后面的断言搞乱

// 斜杠菜单认英文与拼音（§5）：敲下 `/` 那一刻输入法基本都在英文态
await toEnd();
await press('Enter', 'Enter', 13);
await type('/biaoge');
await wait(500);
result.slashAcceptsPinyin = await ex(`[...document.querySelectorAll('.cm-tooltip-autocomplete li')].some(li=>li.textContent.includes('表格'))`);
await press('Escape', 'Escape', 27);
for (let i = 0; i < 8; i++) await press('Backspace', 'Backspace', 8);

// Tab 不再无条件吞掉（§3.9）：光标在普通段落里按 Tab，正文一个字节都不该变
const beforeTab = await ex(`document.querySelector('.cm-content').innerText.length`);
await press('Tab', 'Tab', 9);
result.tabLeavesProseAlone = (await ex(`document.querySelector('.cm-content').innerText.length`)) === beforeTab;
await click(`document.querySelector('.cm-content')`);
await settle();

// —— 十点九、折叠、大纲联动、附件上传不动文档 ——
// 折叠（§3.10）：把手在，点第一个标题的把手能把这一节收起来，正文字节不变
result.foldGutterPresent = await ex(`document.querySelectorAll('.cm-md-fold').length > 0`);
const bodyBeforeFold = (await call(`/api/v1/notes/${noteId}`)).bodyMd;
await click(`document.querySelector('.cm-md-fold')`);
await wait(500);
result.foldCollapsesSection = await ex(`!!document.querySelector('.cm-foldPlaceholder')`);
result.foldKeepsSource = (await call(`/api/v1/notes/${noteId}`)).bodyMd === bodyBeforeFold;
await click(`document.querySelector('.cm-foldPlaceholder')`);
await wait(400);
result.foldReopens = await ex(`!document.querySelector('.cm-foldPlaceholder')`);

// 大纲跟随光标（§3.2）：光标停在文首，大纲第一条该被标成当前小节
await ex(`(()=>{const el=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='大纲'||b.textContent.trim()==='大纲');el&&el.click()})()`);
await wait(600);
await click(`document.querySelector('.cm-content')`);
await press('Home', 'Home', 36, true);
await wait(700);
result.outlineFollowsCursor = await ex(`!!document.querySelector('[aria-current="location"]')`);

// 附件上传期间文档一个字节都不动（§3.6）：占位是装饰不是正文
const upload = await ex(`(()=>{
  const view=document.querySelector('.cm-content');
  if(!view) return null;
  const before=view.innerText.length;
  const dt=new DataTransfer();
  dt.items.add(new File([new Uint8Array([1,2,3])],'verify.png',{type:'image/png'}));
  view.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
  return {before, widget:document.querySelectorAll('.cm-md-uploading').length, after:document.querySelector('.cm-content').innerText.length};
})()`);
result.uploadShowsWidget = !!upload && upload.widget === 1;
result.uploadKeepsDocIntact = !!upload && upload.before === upload.after;
await until(`document.querySelectorAll('.cm-md-uploading').length === 0`);
await settle();

// —— 十点十、双链悬停卡片、坏图占位、换篇记住位置 ——
// 悬停卡片（§3.11）：鼠标停在 [[验收标题]] 上，350ms 后出卡片
const wikiBox = await ex(`(()=>{const el=document.querySelector('.cm-md-wiki');if(!el)return null;const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
if (wikiBox) {
  await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: wikiBox.x, y: wikiBox.y });
  await wait(200);
  await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: wikiBox.x + 1, y: wikiBox.y });
}
result.wikiHoverCard = await until(`!!document.querySelector('.cm-md-wiki-card .cm-md-wiki-card-title')`);
await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });

// 坏图：显示占位，**而且正文一个字节都不许被改回来**（设计 17 §4.1）。
// 小部件的根节点一旦被换掉，CodeMirror 会把新节点的文字读回文档——`![封面](…)` 会被
// 原地改成「图片加载失败：封面」。这条踩过一次，所以断言盯的是源码而不是那块占位。
await toEnd();
await press('Enter', 'Enter', 13);
await ex(`(()=>{const v=document.querySelector('.cm-content');if(!v)return;const d=new DataTransfer();d.setData('text/plain','![封面截图](data:image/png;base64,zzzz)');v.dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}))})()`);
result.brokenImageShowsPlaceholder = await until(`!!document.querySelector('.cm-md-image-error')`);
result.brokenImageKeepsSource = await ex(`document.querySelector('.cm-content').innerText.includes('base64,zzzz')`);
await press('z', 'KeyZ', 90, true);
await press('z', 'KeyZ', 90, true);
await settle();

// —— 十点十一、闭集新增：Callout / 脚注 / ==高亮==（规格 §9.2、设计 17 §3.14）——
await click(`[...document.querySelectorAll('[role=tab]')].find(x=>x.textContent.trim()==='编辑')`);
await wait(600);
await toEnd();
await ex(`(()=>{const v=document.querySelector('.cm-content');if(!v)return;const d=new DataTransfer();
d.setData('text/plain','\\n\\n> [!WARNING] 小心台阶\\n> 警告正文\\n\\n> 普通引用\\n\\n[草稿] 不是链接，这句有 ==重点== 与脚注[^甲]。\\n\\n[https://github.com/gsvps/GSNode](https://github.com/gsvps/GSNode)\\n\\n[^甲]: 注释\\n');
v.dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}))})()`);
await wait(900);
const closedSet = await ex(`(()=>{
  const host=document.querySelector('[data-editor="markdown"]');
  if(!host) return null;
  const text=document.querySelector('.cm-content').innerText;
  return {
    callout: host.querySelectorAll('.cm-md-callout-warning').length,
    plainQuote: [...host.querySelectorAll('.cm-md-quote-line')].filter(e=>!e.classList.contains('cm-md-callout')).length,
    mark: host.querySelectorAll('.cm-md-mark').length,
    footnote: host.querySelectorAll('.cm-md-footnote').length,
    markerVisible: text.includes('[!WARNING]'),
    bracketsKept: text.includes('[草稿]'),
    equalsHidden: !text.includes('==重点=='),
    // 标签是裸地址时，显示文本得留下，只藏链接目标部分。
    urlLabelKept: text.includes('https://github.com/gsvps/GSNode'),
    urlDestHidden: !text.includes('](https://github.com/gsvps/GSNode)'),
  };
})()`);
result.calloutColored = !!closedSet && closedSet.callout >= 2 && closedSet.plainQuote >= 1;
result.highlightRendered = !!closedSet && closedSet.mark >= 1 && closedSet.equalsHidden;
result.footnoteRefStyled = !!closedSet && closedSet.footnote >= 1;
// Callout 的标记是源码，编辑器里不许藏；而「[方括号]文字」也不许被当成链接吃掉括号
result.calloutMarkerStaysVisible = !!closedSet && closedSet.markerVisible;
result.plainBracketsNotEatenByLink = !!closedSet && closedSet.bracketsKept;
result.urlLabelNotHiddenAsDestination = !!closedSet && closedSet.urlLabelKept && closedSet.urlDestHidden;
await settle();

// 预览侧：同一段东西两边要一致
await click(`[...document.querySelectorAll('[role=tab]')].find(x=>x.textContent.trim()==='预览')`);
await wait(800);
result.previewRendersCallout = await ex(`!!document.querySelector('.markdown blockquote.callout[data-callout="warning"] .callout-title')`);
result.previewRendersMark = await ex(`!!document.querySelector('.markdown mark')`);
result.previewRendersFootnote = await ex(`!!document.querySelector('.markdown section.footnotes li#fn-1') && !!document.querySelector('.markdown .footnote-ref a[href="#fn-1"]')`);
// 渲染是显示层的事：正文里那几行原样还在
result.closedSetKeepsSource = (await call(`/api/v1/notes/${noteId}`)).bodyMd.includes("> [!WARNING] 小心台阶");

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
