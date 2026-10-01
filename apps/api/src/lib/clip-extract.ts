import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Readability } from '@mozilla/readability';
import sanitizeHtml from 'sanitize-html';
import { fail } from '@kb/shared';
import { htmlToMarkdown } from './migration-html.ts';
import { publicFetchUrl } from './public-fetch.ts';

type Element={textContent:string;innerHTML:string;outerHTML:string;getAttribute:(key:string)=>string|null;setAttribute:(key:string,value:string)=>void;removeAttribute:(key:string)=>void;getElementsByTagName:(tag:string)=>Element[]};
type Doc=Element&{title:string;getElementById:(id:string)=>Element|null};
const JSDOMParser=createRequire(import.meta.url)('@mozilla/readability/JSDOMParser.js') as new()=>{parse:(html:string,url?:string)=>Doc};
export type ClipImage={url:string;alt:string;placeholder:string};
export type ClipExtraction={sourceUrl:string;title:string;bodyMd:string;excerpt:string;images:ClipImage[];warnings:string[]};
export const CLIP_LIMITS={htmlBytes:1_000_000,nodes:7000,depth:100,images:10,imageBytes:3_000_000,totalImageBytes:10_000_000};

/** 仅解析字符串；官方 JSDOMParser 不执行脚本、不加载资源。Readability 后再走 Markdown 白名单。 */
export function extractClip(input:{url:string;html:string;title?:string;selection?:boolean;browserExtracted?:boolean}):ClipExtraction {
 const sourceUrl=publicFetchUrl(input.url).href;
 if(Buffer.byteLength(input.html)>CLIP_LIMITS.htmlBytes)throw fail('QUOTA','剪藏正文超过 1 MB，请选择局部内容');
 let nodes=0,depth=0;
 const clean=sanitizeHtml(input.html,{allowedTags:[...sanitizeHtml.defaults.allowedTags,'article','main','section','div','span','img','html','head','body','title','meta'],allowedAttributes:{'*':['id','class'],a:['href'],img:['src','data-src','data-original','alt','title'],meta:['property','name','content']},allowedSchemes:['http','https','mailto'],allowProtocolRelative:true,nonTextTags:['script','style','textarea','option','iframe','object','embed','form','svg','math','noscript'],onOpenTag:()=>{if(++nodes>CLIP_LIMITS.nodes||++depth>CLIP_LIMITS.depth)throw fail('QUOTA','网页结构过大，请选择正文片段');},onCloseTag:()=>{depth=Math.max(0,depth-1);}});
 const doc=new JSDOMParser().parse(/<html(?:\s|>)/i.test(clean)?clean:`<html><head></head><body>${clean}</body></html>`,sourceUrl),warnings:string[]=[];
 for(const img of doc.getElementsByTagName('img')){
  const raw=img.getAttribute('data-src')||img.getAttribute('data-original')||img.getAttribute('src')||'';
  try{const url=new URL(raw,sourceUrl);img.setAttribute('src',publicFetchUrl(url.href).href);}catch{img.removeAttribute('src');}
 }
 let title=input.title?.trim()||doc.title||new URL(sourceUrl).hostname,content:string;
 if(new URL(sourceUrl).hostname==='mp.weixin.qq.com'&&!input.selection&&!input.browserExtracted){
  const article=doc.getElementById('js_content');
  if(!article||article.textContent.trim().length<30)throw fail('VALIDATION','公众号未返回可读正文，可能需要登录、验证或已删除；可使用浏览器剪藏或只存链接');
  title=doc.getElementById('activity-name')?.textContent.trim()||title;content=article.innerHTML;
 }else if(input.selection){content=clean;}
 else{
  const article=new Readability(doc as ConstructorParameters<typeof Readability>[0],{maxElemsToParse:CLIP_LIMITS.nodes,charThreshold:80,disableJSONLD:true}).parse();
  if(!article?.content||!article.textContent||article.textContent.trim().length<30)throw fail('VALIDATION','没有提取到可读正文，请选择正文片段或只存链接');
  title=article.title?.trim()||title;content=article.content;
 }
 const article=new JSDOMParser().parse(`<html><body>${content}</body></html>`,sourceUrl),images:ClipImage[]=[];
 for(const a of article.getElementsByTagName('a')){
  try{const url=new URL(a.getAttribute('href')??'',sourceUrl);if(!['http:','https:','mailto:'].includes(url.protocol)||url.username||url.password)throw Error();a.setAttribute('href',url.href);}catch{a.removeAttribute('href');}
 }
 for(const img of article.getElementsByTagName('img')){
  const raw=img.getAttribute('src');if(!raw)continue;
  let url:string;try{url=publicFetchUrl(new URL(raw,sourceUrl).href).href;}catch{continue;}
  const existing=images.find(i=>i.url===url);if(existing){img.setAttribute('src',existing.placeholder);continue;}
  if(images.length>=CLIP_LIMITS.images){warnings.push('只处理正文前 10 张图片，其余保留来源链接');continue;}
  const placeholder=`__clip_asset_${createHash('sha256').update(url).digest('hex')}.png`;
  images.push({url,alt:(img.getAttribute('alt')||img.getAttribute('title')||'正文图片').slice(0,200),placeholder});img.setAttribute('src',placeholder);
 }
 const converted=htmlToMarkdown(article.getElementsByTagName('body')[0]!.innerHTML,{bundledImages:true});
 const bodyMd=`> 来源：[原始网页](<${sourceUrl}>)\n\n${converted.content.trim()}`;
 return{sourceUrl,title:title.replace(/\s+/g,' ').slice(0,160)||'网页剪藏',bodyMd,excerpt:converted.content.replace(/[#*_>`[\]()]/g,'').replace(/\s+/g,' ').slice(0,200),images,warnings:[...new Set([...warnings,...converted.warnings])]};
}
export function linkOnlyClip(url:string,title?:string):ClipExtraction{
 const sourceUrl=publicFetchUrl(url).href;return{sourceUrl,title:title?.trim().slice(0,160)||new URL(sourceUrl).hostname,bodyMd:`> 来源：[原始网页](<${sourceUrl}>)\n\n待整理：暂存来源链接，正文尚未剪藏。`,excerpt:'待整理 · 仅保存来源链接',images:[],warnings:['仅保存链接，未抓取正文或图片']};
}
