try{
 const id=location.hash.slice(1);if(!/^[a-f0-9-]{36}$/.test(id))throw Error('剪藏标识无效');
 const key='capture:'+id,data=(await chrome.storage.session.get(key))[key];
 if(!data||Date.now()-data.createdAt>600000)throw Error('临时剪藏已过期，请重新点击扩展');
 const target=new URL('/api/v1/clips/bridge',data.origin);if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw Error('实例地址无效');
 const form=document.createElement('form');form.method='POST';form.action=target.href;const input=document.createElement('input');input.type='hidden';input.name='packet';input.value=JSON.stringify(data.packet);form.append(input);document.body.append(form);
 await chrome.storage.session.remove(key);form.submit();
}catch(error){document.getElementById('status').textContent='未能打开剪藏确认页：'+error.message+'。请返回来源页面重试。';}
