const targets = await fetch("http://127.0.0.1:9223/json/list").then(r => r.json());
let t = targets.find(x => x.type === "page");
if (!t) t = await fetch("http://127.0.0.1:9223/json/new?http://127.0.0.1:5174/app", { method: "PUT" }).then(r => r.json());
const ws = new WebSocket(t.webSocketDebuggerUrl);
let seq=0; const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}};
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
await call("Runtime.enable"); await call("Page.enable");
const ex=async(expression)=>(await call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true})).result.value;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(expression,label,tries=100)=>{for(let i=0;i<tries;i++){if(await ex(expression))return;await sleep(100)}throw new Error(`timeout: ${label}`)};
const setValue = async (selector, value) => {
  const focused = await ex(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.focus();el.select();return true})()`);
  if (!focused) throw new Error(`element missing: ${selector}`);
  await call("Input.insertText", { text: value });
};
const clickText = (selector,text) => ex(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.textContent.trim()===${JSON.stringify(text)});if(!el)return false;el.click();return true})()`);
try {
  await call("Page.navigate",{url:"http://127.0.0.1:5174/app"});
  await wait("document.body.innerText.includes('NOTEBOOKS')","workspace");
  await ex("[...document.querySelectorAll('button')].find(x=>x.textContent.includes('＋笔记')).click()");
  await wait("location.pathname.includes('/n/') && document.querySelector('.ttl')","first note");
  await setValue(".ttl","项目总览");
  await setValue(".src","# 项目总览\n\n这是第一篇知识。\n\n## 目标\n做成 AI 的大脑。");
  await wait("document.querySelector('.bar')?.textContent.includes('已保存')","first save",150);
  await ex("[...document.querySelectorAll('button')].find(x=>x.textContent.includes('＋笔记')).click()");
  await wait("location.pathname.includes('/n/') && document.querySelector('.ttl')?.value==='未命名'","second note");
  await setValue(".ttl","会议纪要");
  await setValue(".src","# 会议纪要\n\n请查看 [[项目总览]]。\n\n- [x] 已确认范围");
  await wait("document.querySelector('.bar')?.textContent.includes('已保存')","second save",150);
  await clickText("a.node","项目总览");
  await wait("document.querySelector('.ttl')?.value==='项目总览'","open target");
  await wait("document.body.innerText.includes('反向链接 1')","backlink",80);
  await setValue(".top-search","会议纪要");
  await wait("document.querySelector('.search-pop')?.innerText.includes('会议纪要')","search");
  const state=await ex(`({url:location.href,title:document.querySelector('.ttl')?.value,body:document.body.innerText,preview:document.querySelector('.markdown')?.innerText})`);
  console.log(JSON.stringify({ok:true,...state},null,2));
} catch(e){console.error(JSON.stringify({ok:false,error:e.message,url:await ex("location.href"),body:await ex("document.body.innerText")},null,2));process.exitCode=1} finally { ws.close(); }
