import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
import sanitizeHtml from 'sanitize-html';
import { fail } from '@kb/shared';
import { assertAttachmentType } from './file-type.ts';
import { htmlToMarkdown } from './migration-html.ts';
import { MIGRATION_LIMITS, migrationBudget, migrationPath, readMigrationZip, type MigrationEntry } from './migration-zip.ts';
import { parseFront } from './import-plan-path.ts';

export type MigrationOrigin = 'auto' | 'notion' | 'yuque' | 'generic';
export type MigrationReportItem = { path: string; status: 'success' | 'skipped' | 'degraded' | 'failed'; message: string; id?: string; title?: string };
export type MigrationAsset = { path: string; filename: string; mime: string; bytes: Buffer; placeholder: string };
export type MigrationPage = { path: string; sourcePath: string; content: string; warnings: string[]; assets: MigrationAsset[] };
export type MigrationSource = { files: MigrationPage[]; report: MigrationReportItem[]; source: MigrationOrigin };
const noteExt = /\.(?:md|markdown|csv|html?|docx)$/i;
const notionSuffix = /[ -][a-f\d]{32}(?=\.[^.]+$|$)/ig;
const mimeByExt: Record<string,string> = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.pdf':'application/pdf','.txt':'text/plain','.md':'text/markdown','.markdown':'text/markdown','.zip':'application/zip','.mp4':'video/mp4','.webm':'video/webm' };
const text = (bytes: Buffer) => new TextDecoder('utf-8', { fatal:true }).decode(bytes).replace(/^\uFEFF/,'');
const token = (kind: string, path: string) => `/__migration_${kind}/${createHash('sha256').update(path).digest('hex')}`;
export const migrationNoteToken = (path: string) => token('note',path);
export function migrationTitlePath(path: string, source: MigrationOrigin) { return (source === 'notion' ? path.split('/').map(p => p.replace(notionSuffix,'')).join('/') : path).replace(noteExt,'.md'); }

/** 支持引号、双引号转义和单元格内换行；数据库关系/视图明确降级为静态表。 */
export function csvToMarkdown(raw: string) {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (char === '"') { if (quoted && raw[i+1] === '"') { cell += '"'; i++; } else if (quoted || !cell) quoted = !quoted; else cell += char; }
    else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      row.push(cell); cell = '';
      if(row.length>200||rows.length>=10000)throw fail('VALIDATION','CSV 超过 200 列 / 10000 行');
      if (char !== ',') { rows.push(row); row = []; if (char === '\r' && raw[i+1] === '\n') i++; }
    } else cell += char;
  }
  if (quoted) throw fail('VALIDATION','CSV 引号未闭合');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return '';
  const width = Math.max(...rows.map(r=>r.length));
  if (width > 200 || rows.length > 10000) throw fail('VALIDATION','CSV 超过 200 列 / 10000 行');
  const render = (r: string[]) => `| ${Array.from({length:width},(_,i)=>(r[i]??'').replaceAll('\\','\\\\').replaceAll('|','\\|').replace(/\r?\n/g,'<br>')).join(' | ')} |`;
  return `${render(rows[0]!)}\n${render(Array(width).fill('---'))}\n${rows.slice(1).map(render).join('\n')}`;
}
function localTarget(source: string, href: string): string | null {
  try {
    const decoded = decodeURIComponent(href.split('#')[0]!.split('?')[0]!);
    if (!decoded || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(decoded) || decoded.includes('\\')) return null;
    const joined = posix.normalize(posix.join(posix.dirname(source), decoded));
    return joined.startsWith('../') ? null : migrationPath(joined);
  } catch { return null; }
}

export async function prepareMigration(sources: MigrationEntry[], requested: MigrationOrigin = 'auto'): Promise<MigrationSource> {
  const entries: MigrationEntry[] = []; let total = 0;
  const budget=migrationBudget();
  if(sources.length>MIGRATION_LIMITS.entries)throw fail("QUOTA","导入条目超过限制");
  for (const input of sources) {
    const path = migrationPath(input.path);
    if ((total += input.bytes.length) > MIGRATION_LIMITS.totalBytes) throw fail('QUOTA','导入文件总计不能超过 100 MB');
    if (/\.zip$/i.test(path)) entries.push(...readMigrationZip(input.bytes,budget));
    else { if(input.bytes.length>MIGRATION_LIMITS.fileBytes || input.bytes.length>budget.bytes || budget.entries<1)throw fail('QUOTA','单个导入文件或总体预算超过限制');budget.bytes-=input.bytes.length;budget.entries--;entries.push({path,bytes:input.bytes}); }
  }
  if (entries.length > MIGRATION_LIMITS.entries || entries.reduce((n,e)=>n+e.bytes.length,0)>MIGRATION_LIMITS.totalBytes) throw fail('QUOTA','导入包解压总量或条目超过限制');
  const archive = new Map<string,Buffer>(), report: MigrationReportItem[] = [];
  for (const entry of entries) {
    if (entry.path.split('/').some(p => p === '.obsidian' || p === '__MACOSX' || p.startsWith('._'))) continue;
    if (archive.has(entry.path)) throw fail('VALIDATION',`导入源有重复路径：${entry.path}`);
    archive.set(entry.path,entry.bytes);
  }
  const source: MigrationOrigin = requested === 'auto' ? ([...archive.keys()].some(p=>/[ -][a-f\d]{32}(?:\/|\.(?:md|csv)$)/i.test(p)) ? 'notion':'generic') : requested;
  const pagePaths = [...archive.keys()].filter(p=>noteExt.test(p));
  if (pagePaths.length > MIGRATION_LIMITS.pages) throw fail('QUOTA','一次最多导入 500 篇');
  const files: MigrationPage[] = [], used = new Set<string>();
  let convertedBytes=0, imageReferences=0, imageReadRemaining=MIGRATION_LIMITS.totalBytes;
  let imageQueue: Promise<unknown> = Promise.resolve();
  const convertedImages=new Map<string,MigrationAsset>();
  for (const sourcePath of pagePaths) {
    const bytes = archive.get(sourcePath)!; const path = migrationTitlePath(sourcePath, source), warnings: string[] = [], assets: MigrationAsset[] = [];
    let content: string, title: string | null = null;
    try {
      if (!/\.docx$/i.test(sourcePath) && bytes.length > MIGRATION_LIMITS.pageBytes) throw fail('QUOTA','单篇正文不能超过 2 MB');
      if (/\.docx$/i.test(sourcePath)) {
        // mammoth 自带 ZIP 解包前也要通过同一套有界检查；禁止读取文件系统和外链。
        const docxEntries = readMigrationZip(bytes,budget);
        if(docxEntries.some(e=>/\.(?:xml|rels)$/i.test(e.path)&&e.bytes.length>MIGRATION_LIMITS.pageBytes))throw fail('QUOTA','DOCX XML 结构超过单篇限制');
        if(docxEntries.filter(e=>/\.(?:xml|rels)$/i.test(e.path)).some(e=>/<!DOCTYPE|<!ENTITY|\u0000/i.test(text(e.bytes)))) throw fail('VALIDATION','DOCX 不接受 XML 实体声明');
        let xmlBytes=0,xmlNodes=0;
        const xmlParts=new Set<string>(),xmlExtensions=new Set<string>();
        for(const entry of docxEntries.filter(e=>/\.(?:xml|rels)$/i.test(e.path))){
          if((xmlBytes+=entry.bytes.length)>8*1024*1024)throw fail('QUOTA','DOCX XML 总量超过结构预算');
          let depth=0;
          sanitizeHtml(text(entry.bytes),{parser:{xmlMode:true},allowedTags:[],allowedAttributes:{},nonTextTags:[],textFilter:()=>'',
            onOpenTag:(name,attrs)=>{
              if(++xmlNodes>50000||++depth>128)throw fail('QUOTA','DOCX XML 结构过大或嵌套过深');
              const lower=Object.fromEntries(Object.entries(attrs).map(([k,v])=>[k.toLowerCase(),v]));
              if(entry.path==='[Content_Types].xml' && /(?:\+xml|\/xml)(?:;|$)/i.test(lower.contenttype??'')){
                if(name.split(':').at(-1)?.toLowerCase()==='override'&&lower.partname)xmlParts.add(lower.partname.replace(/^\//,''));
                if(name.split(':').at(-1)?.toLowerCase()==='default'&&lower.extension)xmlExtensions.add(lower.extension.toLowerCase());
              }
              if(/\.rels$/i.test(entry.path) && name.split(':').at(-1)?.toLowerCase()==='relationship' && lower.targetmode?.toLowerCase()!=='external'){
                const binary=/\/(?:image|font|oleObject|package|audio|video|hyperlink)$/i.test(lower.type??'');
                if(!binary && lower.target && !/\.(?:xml|rels)$/i.test(lower.target))throw fail('VALIDATION','DOCX XML 关系目标必须使用 .xml/.rels 后缀');
              }
            },
            onCloseTag:()=>{depth=Math.max(0,depth-1);},
          });
        }
        for(const entry of docxEntries){
          if(/\.(?:xml|rels)$/i.test(entry.path))continue;
          const declared=xmlParts.has(entry.path)||xmlExtensions.has(posix.extname(entry.path).slice(1).toLowerCase());
          let offset=entry.bytes.subarray(0,3).equals(Buffer.from([0xef,0xbb,0xbf]))?3:0;
          while(offset<entry.bytes.length&&[9,10,13,32].includes(entry.bytes[offset]!))offset++;
          const xmlLike=entry.bytes[offset]===60 || (entry.bytes[0]===0xff&&entry.bytes[1]===0xfe) || (entry.bytes[0]===0xfe&&entry.bytes[1]===0xff);
          if(declared||xmlLike)throw fail('VALIDATION','DOCX XML 部件必须使用 .xml/.rels 后缀');
        }
        let imageFailure: Error | null = null;
        const maxImageBytes=Math.max(1,...docxEntries.filter(e=>!/\.(?:xml|rels)$/i.test(e.path)).map(e=>e.bytes.length));
        const result = await mammoth.convertToHtml({buffer:bytes}, { externalFileAccess:false, convertImage:mammoth.images.imgElement(img=> {
          if(++imageReferences>MIGRATION_LIMITS.entries){imageFailure=fail('QUOTA','内嵌图片引用过多');throw imageFailure;}
          // mammoth 可并发调用回调；串行读取使重复引用不会同时物化大量副本。
          const work=imageQueue.then(async()=>{
            if(imageFailure)throw imageFailure;
            if(imageReadRemaining<maxImageBytes)throw fail('QUOTA','DOCX 图片重复读取工作量超过限制');
            imageReadRemaining-=maxImageBytes;
            const encoded=await img.read('base64');
            const decodedLength=Math.floor(encoded.length*3/4)-(encoded.endsWith('==')?2:encoded.endsWith('=')?1:0);
            imageReadRemaining+=Math.max(0,maxImageBytes-decodedLength);
            if(encoded.length>Math.ceil(MIGRATION_LIMITS.fileBytes/3)*4)throw fail('QUOTA','内嵌图片超过 25 MB');
            const key=createHash('sha256').update(img.contentType).update(encoded).digest('hex');
            let asset=convertedImages.get(key);
            if(!asset){
              const length=Math.floor(encoded.length*3/4)-(encoded.endsWith('==')?2:encoded.endsWith('=')?1:0);
              if(length>budget.bytes)throw fail('QUOTA','转换图片超过导入总内存预算');
              budget.bytes-=length;
              const data=Buffer.from(encoded,'base64'),mime=img.contentType;assertAttachmentType(mime,data);
              const assetPath=`${sourcePath}.assets/image-${convertedImages.size+1}.${mime.split('/')[1]}`;
              asset={path:assetPath,filename:posix.basename(assetPath),mime,bytes:data,placeholder:token('asset',assetPath)};
              convertedImages.set(key,asset);
            }
            if(!assets.some(a=>a.placeholder===asset!.placeholder))assets.push(asset);
            return {src:asset.placeholder};
          });
          imageQueue=work.catch(error=>{imageFailure=error instanceof Error?error:new Error(String(error));});return work;
        }) });
        if(imageFailure)throw imageFailure;
        const html = htmlToMarkdown(result.value,{bundledImages:true}); content=html.content;title=html.title;
        warnings.push('DOCX 已转换为 Markdown，复杂排版、批注及不支持的块可能降级',...result.messages.map(m=>m.message),...html.warnings);
      } else if (/\.html?$/i.test(sourcePath)) {
        const html=htmlToMarkdown(text(bytes),{bundledImages:true});content=html.content;title=html.title;warnings.push(...html.warnings);
      } else if (/\.csv$/i.test(sourcePath)) {
        content=csvToMarkdown(text(bytes)); warnings.push('数据库已降级为静态 Markdown 表格，关系、公式和视图需整理');
      } else content=text(bytes);
      const front=parseFront(content);
      title=(front.title??title??(source==='notion'?front.body.match(/^#\s+(.+)$/m)?.[1]??null:null)??posix.basename(path,'.md')).trim()||'未命名';
      if(title.length>200){title=title.slice(0,200);warnings.push('标题超过 200 字，已截断');}
      content=front.body;
      // 分开代码与正文后才展开引用式/Obsidian 附件，代码样例永远保持原样。
      const chunks=content.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g);
      const definitions=new Map<string,string>();
      for(let i=0;i<chunks.length;i+=2)chunks[i]=chunks[i]!.replace(/^ {0,3}\[([^\]\n]+)\]:\s*(<[^>\n]+>|\S+)(?:[^\n]*)$/gm,(_raw,label:string,href:string)=>{definitions.set(label.toLowerCase(),href);return '';});
      for(let i=0;i<chunks.length;i+=2)chunks[i]=chunks[i]!.replace(/(?<!\[)(!?)\[(?!\[)([^\]\n]+)\](?:\[([^\]\n]*)\])?(?![([])/g,(raw,bang:string,label:string,id:string|undefined)=>{const href=definitions.get((id||label).toLowerCase());return href?`${bang}[${label}](${href})`:raw;}).replace(/(!?)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,(raw,bang:string,href:string,label:string|undefined)=>{const target=localTarget(sourcePath,href);return target&&archive.has(target)&&mimeByExt[posix.extname(target).toLowerCase()]&&!noteExt.test(target)?`${bang}[${label??posix.basename(href)}](<${href}>)`:raw;});
      content=chunks.join('');
      // code 内的示例路径不能被改写；参考链接定义与普通内联链接都可以复用资源。
      content=content.replace(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)|(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]*>|(?:[^\s()]|\([^()]*\))+)\s*(?:["'][^\n]*?["'])?\s*\)/g,(raw,code:string|undefined,bang:string,label:string,rawHref:string)=>{
        if(code)return raw;
        const href=rawHref.replace(/^<|>$/g,'');
        if(assets.some(a=>a.placeholder===href))return raw;
        if(/^https?:\/\//i.test(href)) { if(bang){warnings.push(`远程图片未下载，保留链接：${href.slice(0,180)}`);return `[${label||'图片'}](<${href}>)`;}return raw; }
        if(/^#/.test(href))return raw;
        if(/^data:image\/(png|jpeg|gif|webp);base64,/i.test(href)&&bang){
          try { const [header,encoded]=href.split(','); const mime=header!.slice(5).split(';')[0]!; const data=Buffer.from(encoded!,'base64');assertAttachmentType(mime,data);
            if(data.length>MIGRATION_LIMITS.fileBytes)throw new Error('图片超过 25 MB');
            const assetPath=`${sourcePath}.assets/inline-${assets.length+1}.${mime.split('/')[1]}`,placeholder=token('asset',assetPath);assets.push({path:assetPath,filename:posix.basename(assetPath),mime,bytes:data,placeholder});return `![${label}](<${placeholder}>)`;
          }catch{warnings.push('内嵌图片无法读取');return label||'图片';}
        }
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) { if(!bang&&/^mailto:/i.test(href))return raw;warnings.push(`已移除不安全链接：${href.slice(0,100)}`);return label; }
        const target=localTarget(sourcePath,href);
        if(target&&pagePaths.includes(target)&&!bang)return `[${label}](${migrationNoteToken(target)})`;
        const data=target?archive.get(target):undefined;
        if(!data){warnings.push(`找不到包内资源：${href.slice(0,180)}`);return label||'缺失资源';}
        try {
          const mime=mimeByExt[posix.extname(target!).toLowerCase()];if(!mime)throw new Error('不支持的附件格式');assertAttachmentType(mime,data);
          const placeholder=token('asset',target!);if(!assets.some(a=>a.placeholder===placeholder))assets.push({path:target!,filename:posix.basename(target!),mime,bytes:data,placeholder});used.add(target!);
          return `${bang?'!':''}[${label}](<${placeholder}>)`;
        }catch(e){warnings.push(`附件未导入：${href.slice(0,120)}（${(e as Error).message}）`);return label||'附件';}
      });
      if(title) content=`---\ntitle: ${JSON.stringify(title)}\n---\n\n${content}`;
      if(Buffer.byteLength(content)>MIGRATION_LIMITS.pageBytes)throw fail('QUOTA','转换后正文超过 2 MB');
      convertedBytes+=Buffer.byteLength(content);
      if(convertedBytes>MIGRATION_LIMITS.totalBytes)throw fail('QUOTA','转换后正文总量超过 100 MB');
      files.push({path,sourcePath,content,warnings:[...new Set(warnings)],assets}); used.add(sourcePath);
    } catch(e) {
      if(convertedBytes>MIGRATION_LIMITS.totalBytes)throw e;
      report.push({path:sourcePath,status:'failed',message:(e as Error).message});used.add(sourcePath);
    }
  }
  for(const path of archive.keys())if(!used.has(path))report.push({path,status:'skipped',message:'未被正文引用的资源或不支持的格式'});
  return {files,report,source};
}
