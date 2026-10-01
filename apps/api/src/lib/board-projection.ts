import sanitizeHtml from "sanitize-html";
import { fail } from "@kb/shared";
import { assertAttachmentType, imageDimensions } from "./file-type.ts";

const SVG_TAGS = ['svg','g','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','defs','clipPath','linearGradient','radialGradient','stop','image','switch'];
const ATTRS = ['id','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','width','height','viewBox','preserveAspectRatio','d','points','transform','fill','fill-opacity','fill-rule','stroke','stroke-width','stroke-opacity','stroke-linecap','stroke-linejoin','stroke-dasharray','opacity','font-family','font-size','font-weight','font-style','text-decoration','text-anchor','dominant-baseline','dx','dy','offset','stop-color','stop-opacity','clip-path','gradientUnits','gradientTransform','spreadMethod','href','xlink:href','xmlns','xmlns:xlink'];
const LOCAL_URL = /^url\(#[A-Za-z_][\w:.-]*\)$/;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;

/** 公开投影仅留绘图和纯文字。无原始导图 JSON、draw.io XML、脚本、HTML、链接或远程资源。 */
export function sanitizeBoardSvg(raw: string) {
  if (Buffer.byteLength(raw, 'utf8') > 2_000_000) throw fail('PAYLOAD_TOO_LARGE', '公开预览最多 2 MB，请减少图片');
  if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(raw) || /<!DOCTYPE|<!ENTITY/i.test(raw)) throw fail('VALIDATION', '预览必须是普通 SVG');
  let nodes=0,depth=0,imageCount=0,imagePixels=0;
  const svg = sanitizeHtml(raw, {
    onOpenTag:()=>{if(++nodes>10000||++depth>128)throw fail('QUOTA','SVG 结构过大或嵌套过深');},
    onCloseTag:()=>{depth=Math.max(0,depth-1);},
    parser: { xmlMode: true, lowerCaseTags: false, lowerCaseAttributeNames: false },
    allowedTags: SVG_TAGS,
    allowedAttributes: { '*': ATTRS },
    allowedSchemes: ['data'], allowedSchemesAppliedToAttributes: ['href','xlink:href'],
    allowProtocolRelative: false,
    nonTextTags: ['script','style','foreignObject','metadata','title','desc','iframe','object','embed'],
    transformTags: { '*': (tag, attrs) => {
      const safe: Record<string,string> = {};
      for (const [key, rawValue] of Object.entries(attrs)) {
        // 路径/变换的合法空白归一化，不能因多行 d 而丢掉节点形状。CSS 展示值仍拒绝控制符。
        const value=['d','points','transform','viewBox'].includes(key)?rawValue.replace(/[\t\n\r\f]/g,' '):rawValue;
        if (!ATTRS.includes(key) || value.length > (key === 'href' || key === 'xlink:href' ? 1_500_000 : 100_000)) continue;
        if (key === 'href' || key === 'xlink:href') {
          if (tag === 'image' && !safe.href && DATA_IMAGE.test(value)) {
            if(++imageCount>32)throw fail('QUOTA','公开预览最多 32 张嵌入图片');
            const [head,body]=value.split(',',2),mime=head!.slice(5).split(';')[0]!;
            const bytes=Buffer.from(body!,'base64');assertAttachmentType(mime,bytes);
            const size=imageDimensions(mime,bytes)!;imagePixels+=size.width*size.height;
            if(imagePixels>16_000_000)throw fail('QUOTA','公开预览图片总像素过大，请压缩图片');
            safe.href = value;
          }
          continue;
        }
        if (key === 'xmlns' || key === 'xmlns:xlink') continue;
        // SVG presentation 属性走 CSS 词法：先拒绝转义/控制符，不能只匹配字面 url。
        if (/[\\\u0000-\u001f\u007f]/.test(value)) continue;
        if (/url\s*\(/i.test(value) && !LOCAL_URL.test(value)) continue;
        if (/[<>]|javascript:|expression\s*\(|data:/i.test(value)) continue;
        safe[key] = value;
      }
      if (tag === 'svg') safe.xmlns = 'http://www.w3.org/2000/svg';
      return { tagName: tag, attribs: safe };
    } },
  });
  if (!svg.startsWith('<svg') || !/<(?:path|rect|circle|ellipse|line|polyline|polygon|text|image)\b/.test(svg)) throw fail('VALIDATION', '预览没有可显示的图形，请重新导出 SVG');
  return svg;
}
export function projectionCurrent(board: { version: number; publicSvgVersion: number | null; publicSvg: string | null; trashedAt: Date | null }) {
  return !board.trashedAt && !!board.publicSvg && board.publicSvgVersion === board.version;
}
