import { AppError,fail } from '@kb/shared';
import { CLIP_LIMITS,extractClip,linkOnlyClip } from './clip-extract.ts';
import { fetchPublicResource } from './public-fetch.ts';
type Input={url:string;html?:string;title?:string;selection?:boolean;mode:'article'|'link'};
export async function prepareClip(input:Input,fetcher=fetchPublicResource){
 if(input.mode==='link')return linkOnlyClip(input.url,input.title);
 let html=input.html,effectiveUrl=input.url;
 if(html===undefined){
  try{const response=await fetcher(input.url,{maxBytes:CLIP_LIMITS.htmlBytes,timeoutMs:5000,accept:'text/html,application/xhtml+xml'});if(!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.contentType))throw fail('VALIDATION','来源不是 HTML 网页，请使用浏览器剪藏或只存链接');effectiveUrl=response.url;const charset=/charset\s*=\s*["']?([^;\s"']+)/i.exec(response.contentType)?.[1]??'utf-8';try{html=new TextDecoder(charset).decode(response.body);}catch{html=response.body.toString('utf8');}}
  catch(error){if(error instanceof AppError)throw error;throw fail('VALIDATION','来源无法读取或响应超时，请使用浏览器剪藏或只存链接');}
 }
 const clip=extractClip({...input,url:effectiveUrl,html,browserExtracted:input.html!==undefined});if(input.title?.trim())clip.title=input.title.trim();return clip;
}
