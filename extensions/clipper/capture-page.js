/* 与弹窗隔离世界共用的正文提取器；只有用户点击时执行。 */
globalThis.collectXingliClipPacket=()=>{
   const selection=window.getSelection();let html,title=document.title,selected=!!selection&&!selection.isCollapsed;
   const clean=root=>{root.querySelectorAll('script,style,form,input,textarea,select,button,iframe,object,embed,svg,noscript,[contenteditable]').forEach(n=>n.remove());root.querySelectorAll('img').forEach(n=>{const raw=n.getAttribute('data-src')||n.getAttribute('data-original')||n.getAttribute('src');if(raw)try{n.setAttribute('src',new URL(raw,location.href).href);}catch{}});return root;};
   if(selected){const root=document.createElement('div');root.append(selection.getRangeAt(0).cloneContents());html=clean(root).innerHTML;}
   else{const cloned=clean(document.cloneNode(true));if(cloned.getElementsByTagName('*').length>30000)throw Error('页面过大，请选择正文片段');const article=new Readability(cloned,{maxElemsToParse:30000,charThreshold:80,disableJSONLD:true}).parse();if(!article?.content)throw Error('未找到正文，请选择片段或在星璃中只存链接');html=article.content;title=article.title||title;}
   const packet={url:location.href,title:title.slice(0,160),html,selection:selected};if(new TextEncoder().encode(JSON.stringify(packet)).length>1000000)throw Error('正文超过 1 MB，请选择较短片段');return packet;
};
