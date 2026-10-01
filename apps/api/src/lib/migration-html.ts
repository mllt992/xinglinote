import { fail } from '@kb/shared';
import sanitizeHtml from 'sanitize-html';
import TurndownService from 'turndown';

export type HtmlImport = { content: string; title: string | null; warnings: string[] };
/** 不启动浏览器、不加载资源；先按白名单消毒，再转 Markdown。 */
export function htmlToMarkdown(raw: string, options: { bundledImages?: boolean; baseUrl?: string } = {}): HtmlImport {
  const warnings: string[] = [];
  if(Buffer.byteLength(raw,'utf8')>2*1024*1024)throw fail('QUOTA','HTML 正文超过 2 MB');
  let depth=0,tables=0,nodes=0,tableWork=0;
  if (/<(?:script|style|iframe|object|embed|form)\b|\bon\w+\s*=/i.test(raw)) warnings.push('已移除脚本、事件属性或不支持的嵌入内容');
  const titleRaw = raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? raw.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const title = titleRaw ? new TurndownService().turndown(sanitizeHtml(titleRaw, { allowedTags: [], allowedAttributes: {} })).trim() : null;
  const clean = sanitizeHtml(raw, {
    onOpenTag: name => { if(++nodes>10000||++depth>128||(name==='table'&&++tables>1))throw fail('QUOTA','HTML 结构过大或含嵌套表格，请拆分后导入'); },
    onCloseTag: name => {depth=Math.max(0,depth-1);if(name==='table')tables=Math.max(0,tables-1);},
    allowedTags: ['h1','h2','h3','h4','h5','h6','p','br','hr','div','span','strong','b','em','i','s','del','blockquote','pre','code','ul','ol','li','a','img','table','thead','tbody','tr','th','td','input'],
    allowedAttributes: { a: ['href','title'], img: ['src','alt','title'], ol: ['start'], input: ['type','checked'] },
    allowedSchemes: ['http','https','mailto'], allowedSchemesByTag: { img: ['http','https','data'] }, allowProtocolRelative: false,
    nonTextTags: ['script','style','textarea','option','iframe','object','embed','form','svg','math'],
    transformTags: { input: (_tag, attrs) => ({ tagName: 'span', attribs: {}, text: attrs.type === 'checkbox' ? (Object.hasOwn(attrs,'checked') ? '[x] ' : '[ ] ') : '' }) },
  });
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.addRule('strike', { filter: ['s','del'], replacement: content => `~~${content}~~` });
  td.addRule('table', {
    filter: 'table', replacement: (_content, node) => {
      type Element = { tagName:string;innerHTML:string;children:ArrayLike<Element> };
      const table=node as unknown as Element;
      const rowElements=Array.from(table.children).flatMap(child=>child.tagName.toLowerCase()==='tr'?[child]:['thead','tbody','tfoot'].includes(child.tagName.toLowerCase())?Array.from(child.children).filter(row=>row.tagName.toLowerCase()==='tr'):[]);
      const rows=rowElements.map(row=>Array.from(row.children).filter(cell=>['th','td'].includes(cell.tagName.toLowerCase())).map(cell=>{
        if((tableWork+=cell.innerHTML.length)>16*1024*1024)throw fail('QUOTA','HTML 表格转换工作量超过限制');
        return td.turndown(cell.innerHTML).replaceAll('|','\\|').replace(/\n/g,'<br>');
      }));
      if (!rows.length) return '';
      const count = Math.max(...rows.map(row => row.length));
      const line = (row: string[]) => `| ${Array.from({length:count}, (_, i) => row[i] ?? '').join(' | ')} |`;
      return `\n\n${line(rows[0]!)}\n${line(Array(count).fill('---'))}\n${rows.slice(1).map(line).join('\n')}\n\n`;
    },
  });
  if(options.baseUrl)td.addRule('absoluteLink', {
    filter:'a', replacement:(content,node)=>{
      const href=node.getAttribute('href');if(!href)return content;
      try{const url=new URL(href,options.baseUrl);if(!['http:','https:','mailto:'].includes(url.protocol))return content;return `[${content}](<${url.href}>)`;}catch{return content;}
    },
  });
  td.addRule('safeImage', {
    filter: 'img', replacement: (_content, node) => {
      let src = node.getAttribute('src') ?? ''; const alt = (node.getAttribute('alt') || '图片').replace(/[\[\]\\]/g,'');
      if (src && !/^[a-z][a-z\d+.-]*:/i.test(src) && options.baseUrl) { try { src = new URL(src, options.baseUrl).href; } catch { src = ''; } }
      if (/^https?:/i.test(src)) {
        warnings.push(`远程图片未下载，保留链接：${src.slice(0,180)}`);
        return `[${alt}](${src.replaceAll(' ','%20').replaceAll('(','%28').replaceAll(')','%29')})`;
      }
      if (src && options.bundledImages && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(src.replace(/^data:image\/(?:png|jpeg|gif|webp);base64,/i, ''))) return `![${alt}](<${src}>)`;
      warnings.push(`图片无法随正文导入：${alt}`); return alt;
    },
  });
  return { content: td.turndown(clean).replace(/\\\[([ x])\\\]/g, '[$1]'), title: title || null, warnings: [...new Set(warnings)] };
}
