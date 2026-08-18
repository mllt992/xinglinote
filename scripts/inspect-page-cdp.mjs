const targets = await fetch("http://127.0.0.1:9223/json/list").then(r => r.json());
const t = targets.find(x => x.url.includes("127.0.0.1:12098/w/"));
if (!t) throw new Error("workspace target not found");
const ws = new WebSocket(t.webSocketDebuggerUrl);
let seq=0; const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result)}};
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
await call("Runtime.enable");
const ex = async (expression) => (await call("Runtime.evaluate", {expression, returnByValue:true, awaitPromise:true})).result.value;
const out = await ex(`(async()=>({
  url:location.href,
  html:document.getElementById('root')?.innerHTML,
  body:document.body.innerText,
  me:await fetch('/api/v1/me',{credentials:'include'}).then(async r=>({status:r.status,text:await r.text()})),
  ws:await fetch('/api/v1/workspaces',{credentials:'include'}).then(async r=>({status:r.status,text:await r.text()}))
}))()`);
console.log(JSON.stringify(out,null,2)); ws.close();
