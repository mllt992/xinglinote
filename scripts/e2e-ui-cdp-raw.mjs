const target = await fetch("http://127.0.0.1:9223/json/new?http://127.0.0.1:5174/app", { method: "PUT" }).then(r => r.json());
const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq=0; const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}};
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
await call("Runtime.enable");
const ex=async expression=>(await call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true})).result.value;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(let i=0;i<100;i++){const body=await ex("document.body.innerText");if(body.includes("笔记本")&&body.includes("回收站"))break;await sleep(100)}
const opened=await ex(`(async()=>{const ws=location.pathname.split('/')[2];const d=await fetch('/api/v1/search?workspaceId='+ws+'&q='+encodeURIComponent('总览-')).then(r=>r.json());const hit=d.data.hits[0];if(!hit)return false;location.assign('/w/'+ws+'/n/'+hit.id);return true})()`);
if(!opened) throw new Error(`test note not found through search: ${await ex("document.body.innerText")}`);
for(let i=0;i<100;i++){if((await ex("document.querySelector('.markdown')?.innerText||''")).includes("核心目标"))break;await sleep(100)}
for(let i=0;i<100;i++){if((await ex("document.body.innerText")).includes("核心目标"))break;await sleep(100)}
const state=await ex(`({url:location.href,title:[...document.querySelectorAll('input')].find(x=>x.value.startsWith('总览-'))?.value,preview:document.querySelector('.markdown')?.innerText,controls:document.body.innerText})`);
const ok=state.url.includes('/n/')&&state.preview.includes('核心目标')&&state.controls.includes('编辑预览分栏')&&state.controls.includes('AI 可读');
console.log(JSON.stringify({ok,...state},null,2));ws.close();if(!ok)process.exitCode=1;
