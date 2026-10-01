import { z } from 'zod';
import { publicFetchUrl } from './public-fetch.ts';
import { CLIP_LIMITS } from './clip-extract.ts';
import { fail } from '@kb/shared';

export function clipBridgeDocument(raw:string){
 let parsed:unknown;try{parsed=JSON.parse(raw);}catch{throw fail('VALIDATION','剪藏数据格式错误');}
 const packet=z.object({url:z.string().max(4096),title:z.string().max(160).default(''),html:z.string().max(CLIP_LIMITS.htmlBytes).optional(),selection:z.boolean().default(false)}).parse(parsed);
 packet.url=publicFetchUrl(packet.url).href;
 if(packet.html&&Buffer.byteLength(packet.html)>CLIP_LIMITS.htmlBytes)throw fail('QUOTA','剪藏正文超过 1 MB');
 const json=JSON.stringify(packet).replaceAll('<','\\u003c').replaceAll('>','\\u003e').replaceAll('&','\\u0026');
 // 匿名、无数据库读写、无远程请求。跨站表单只搬运用户主动选中的内容，保存仍需登录并明确点击。
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>存到星璃</title><body><h1>存到星璃</h1><p id="status">正在打开剪藏确认页；此时尚未保存到任何笔记本。</p><pre id="fallback" hidden></pre><script type="application/json" id="clip-packet">${json}</script><script src="/clip-bridge.js" defer></script></body></html>`;
}
