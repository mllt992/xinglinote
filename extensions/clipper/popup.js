/* 全部传输经用户配置的实例表单页，不持有 API key 或常驻网站权限。 */
const instance=document.getElementById('instance'),button=document.getElementById('capture'),status=document.getElementById('status');
const settings=await chrome.storage.local.get('instance');instance.value=settings.instance||'';
const [tab]=await chrome.tabs.query({active:true,currentWindow:true});document.getElementById('source').textContent=tab?.title||'当前网页';
button.addEventListener('click',async()=>{
 button.disabled=true;status.textContent='正在提取正文…';
 try{
  const origin=new URL(instance.value.trim());if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('请填写实例根地址，例如 https://notes.example.com');
  if(!tab?.id||!/^https?:\/\//.test(tab.url||''))throw Error('只支持普通 HTTP(S) 网页；浏览器设置页无法读取');
  await chrome.storage.local.set({instance:origin.origin});
  const queued=await chrome.storage.session.get(null);await chrome.storage.session.remove(Object.keys(queued).filter(k=>k.startsWith('capture:')&&Date.now()-queued[k].createdAt>600000));
  await chrome.scripting.executeScript({target:{tabId:tab.id},files:['Readability.js','capture-page.js']});
  const results=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>globalThis.collectXingliClipPacket()});
  const packet=results[0]?.result;if(!packet)throw Error('未取得正文，请刷新来源页面重试');
  const id=crypto.randomUUID();await chrome.storage.session.set({['capture:'+id]:{origin:origin.origin,packet,createdAt:Date.now()}});
  await chrome.tabs.create({url:chrome.runtime.getURL('transfer.html')+'#'+id});window.close();
 }catch(error){status.textContent=error.message;button.disabled=false;}
});
