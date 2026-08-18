// 导入向导与 zip 导出的浏览器验收。
// 前提：dev 已起，Chrome 带 --remote-debugging-port=9223 且已登录。
import { KB_EMAIL, KB_PASSWORD } from './creds.mjs';
const targets=await fetch('http://127.0.0.1:9223/json/list').then(r=>r.json());
// dev 端口换过，旧标签页可能都停在老端口上；没有合适的就现开一个
const t=targets.find(x=>x.url.includes('127.0.0.1:12098'))
  ?? await fetch('http://127.0.0.1:9223/json/new?http://127.0.0.1:12098/app',{method:'PUT'}).then(r=>r.json());
const ws=new WebSocket(t.webSocketDebuggerUrl);let id=0;const p=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){const q=p.get(m.id);p.delete(m.id);m.error?q.j(m.error):q.r(m.result)}};
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
const cmd=(m,params={})=>new Promise((r,j)=>{const n=++id;p.set(n,{r,j});ws.send(JSON.stringify({id:n,method:m,params}))});
await cmd('Runtime.enable');await cmd('Page.enable');
const ex=async x=>(await cmd('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true})).result.value;
const go=async u=>{await cmd('Page.navigate',{url:u});await new Promise(r=>setTimeout(r,2600))};
const click=async sel=>{const r=await ex(`(()=>{const el=${sel};if(!el)return null;el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`);if(!r)return false;for(const type of ['mousePressed','mouseReleased'])await cmd('Input.dispatchMouseEvent',{type,x:r.x,y:r.y,button:'left',clickCount:1});await new Promise(x=>setTimeout(x,700));return true};
await go('http://127.0.0.1:12098/app');
// 换端口等于换 origin，旧会话不通用；落在登录页就自己登一次
if((await ex('location.pathname'))==='/login'){
  const creds=JSON.stringify({email:KB_EMAIL,password:KB_PASSWORD});
  await ex(`fetch("/api/v1/auth/login",{method:"POST",headers:{"content-type":"application/json","X-Requested-With":"fetch"},body:${JSON.stringify(creds)}}).then(r=>r.json())`);
  await go('http://127.0.0.1:12098/app');
}
const wsId=await ex('location.pathname.split("/")[2]||""');
const result={};
result.importButtonOpensWizard=await click(`[...document.querySelectorAll('aside button')].find(b=>b.querySelector('svg.lucide-upload'))`);
const dlg=await ex(`document.querySelector('[role=dialog]')?.innerText||''`);
result.wizardShowsModes=dlg.includes('改名保留')&&dlg.includes('跳过')&&dlg.includes('覆盖');
result.wizardExplainsPreview=dlg.includes('先算一份计划');
await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
await new Promise(r=>setTimeout(r,500));
result.notebookExportButton=await ex(`[...document.querySelectorAll('aside button')].some(b=>b.querySelector('svg.lucide-download'))`);
await go(`http://127.0.0.1:12098/w/${wsId}/manage`);
await click(`[...document.querySelectorAll('[role=tab]')].find(x=>x.textContent.trim()==='导出与恢复')`);
const t2=await ex('document.body.innerText');
result.workspaceZipExport=t2.includes('导出为 Markdown 压缩包')&&t2.includes('导出 zip');
console.log(JSON.stringify(result,null,2));ws.close();
const failed=Object.entries(result).filter(([,v])=>!v).map(([k])=>k);
if(failed.length){console.error('失败：'+failed.join(', '));process.exitCode=1;}
