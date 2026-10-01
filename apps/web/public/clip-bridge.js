/* 表单导航保留同一标签页的 sessionStorage，不需要 opener，也不放宽 COOP/CSP。 */
(() => {
 const packet=JSON.parse(document.getElementById('clip-packet').textContent);
 try {
  const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);const id=Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
  const prefix='kb.clip.incoming:';let count=0;for(let i=0;i<sessionStorage.length;i++)if(sessionStorage.key(i).startsWith(prefix))count++;
  if(count>=5)throw Error('本标签页已有 5 条未接收剪藏，请先处理或关闭该标签页后重新剪藏');
  sessionStorage.setItem(prefix+id,JSON.stringify(packet));location.replace('/capture#clip='+id);
 } catch(error) {
  document.getElementById('status').textContent='无法保存本标签页的临时剪藏：'+error.message+'。请复制下面的来源信息，登录后手动存入；关闭页面将丢失此内容。';
  const fallback=document.getElementById('fallback');fallback.hidden=false;fallback.textContent=packet.title+'\n'+packet.url+'\n'+(packet.html||'');
 }
})();
