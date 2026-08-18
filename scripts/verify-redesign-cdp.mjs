import { writeFile } from "node:fs/promises";
const target = await fetch("http://127.0.0.1:9223/json/new?http://127.0.0.1:12098/app", { method: "PUT" }).then(r => r.json());
const ws = new WebSocket(target.webSocketDebuggerUrl); let seq=0; const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}};
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
await call("Runtime.enable"); await call("Page.enable"); await call("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
const ex=async expression=>(await call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true})).result.value;
for(let i=0;i<100;i++){if((await ex("document.body.innerText")).includes("笔记本"))break;await new Promise(r=>setTimeout(r,100))}
const state=await ex(`({url:location.href,text:document.body.innerText,grid:getComputedStyle(document.querySelector('main.app-grid')).gridTemplateColumns,tailwind:document.querySelectorAll('[class*=rounded-xl]').length,title:document.title})`);
const shot=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false}); await writeFile("artifacts/redesign.png",Buffer.from(shot.data,"base64"));
const ok=state.url.includes('/w/')&&state.text.includes('新建笔记')&&state.grid.split(' ').length===3&&state.tailwind>3;
console.log(JSON.stringify({ok,...state,screenshot:"artifacts/redesign.png"},null,2)); ws.close(); if(!ok)process.exitCode=1;
