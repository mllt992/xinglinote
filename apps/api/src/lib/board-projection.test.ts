import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectionCurrent, sanitizeBoardSvg } from './board-projection.ts';

test('SVG 公开投影保留可读图形，移除脚本、外链、源元数据和 HTML', () => {
 const clean=sanitizeBoardSvg('<svg viewBox="0 0 100 100" onload="evil()"><metadata>private-json</metadata><script>evil()</script><foreignObject><div>private-html</div></foreignObject><a href="https://secret.invalid"><text x="4" y="5">公开节点</text></a><image href="https://secret.invalid/pixel"/><path d="M0 0L10 10" stroke="url(https://secret.invalid/x)"/><rect width="10" height="10" fill="red" style="filter:url(https://x)"/></svg>');
 assert.ok(clean.includes('公开节点'));assert.ok(clean.includes('viewBox="0 0 100 100"'));
 for(const bad of ['evil','private','secret.invalid','foreignObject','style=','onload','<a '])assert.ok(!clean.includes(bad),bad);
});
test('SVG 不接收 DTD、SVG 数据图、外部 use 与事件属性',()=>{
 assert.throws(()=>sanitizeBoardSvg('<!DOCTYPE svg><svg><text>x</text></svg>'));
 const clean=sanitizeBoardSvg('<svg><text>ok</text><image href="data:image/svg+xml;base64,PHN2Zz4="/><use href="https://x/a.svg#id"/><g onclick="x()"><rect width="3" height="3"/></g></svg>');
 assert.ok(!clean.includes('href='));assert.ok(!clean.includes('onclick'));
});
test('公开预览必须与源版本一致，回收站立即失效',()=>{
 const b={version:2,publicSvgVersion:2,publicSvg:'<svg/>',trashedAt:null};
 assert.equal(projectionCurrent(b),true);assert.equal(projectionCurrent({...b,version:3}),false);assert.equal(projectionCurrent({...b,trashedAt:new Date()}),false);
});

test('公开 SVG 不保留可指数展开的 use，并限制结构深度',()=>{
 const clean=sanitizeBoardSvg('<svg><defs><g id="a"><use href="#a"/></g></defs><rect width="1" height="1"/><use href="#a"/></svg>');assert.ok(!clean.includes('<use'));
 assert.throws(()=>sanitizeBoardSvg('<svg>'+ '<g>'.repeat(129)+'<rect/>'+ '</g>'.repeat(129)+'</svg>'),/嵌套/);
});

test('公开 SVG 的嵌入图复核魔数与总解码像素，不放行伪装 HTML 或图片炸弹',()=>{
 const encode=(mime:string,bytes:Buffer)=>`<svg><image href="data:${mime};base64,${bytes.toString('base64')}"/></svg>`;
 assert.throws(()=>sanitizeBoardSvg(encode('image/png',Buffer.from('<html>bad</html>'))),/类型/);
 const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(5000,16);png.writeUInt32BE(5000,20);
 assert.throws(()=>sanitizeBoardSvg(encode('image/png',png)),/总像素/);
});

test('SVG 展示属性不能用 CSS 转义或实体隐藏远程 URL',()=>{
 const raw=String.raw`<svg><rect fill="u\72l(https://example.invalid/fill#id)"/><g clip-path="\75rl(https://example.invalid/clip#id)"><text>safe</text></g><circle stroke="u&#92;72l(https://example.invalid/encoded#id)"/><path fill="u&#x0009;rl(https://example.invalid/control#id)"/></svg>`;
 const clean=sanitizeBoardSvg(raw);assert.ok(!clean.includes('example.invalid'));assert.ok(clean.includes('safe'));
});

test('多行 SVG 路径保留几何，不能只剩白字和透明选择框',()=>{
 const clean=sanitizeBoardSvg('<svg width="100" height="50"><path d="M 0 0\nL 100 0\tL 100 50 L 0 50 Z" fill="#111111"/><text fill="#ffffff">根节点</text></svg>');assert.match(clean,/d="M 0 0 L 100 0 L 100 50 L 0 50 Z"/);assert.match(clean,/fill="#111111"/);
});
