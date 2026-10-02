import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractClip, linkOnlyClip } from './clip-extract.ts';

test('Readability 正文、来源与选图占位，脚本/表单不进入剪藏',()=>{
 const paragraphs=Array.from({length:5},()=>'<p>这是一篇关于如何整理家庭知识库的文章。先收集资料，再阅读标注，最后建立关联，让经验可以复用。</p>').join('');
 const result=extractClip({url:'https://example.com/guides/a',html:`<html><head><title>家庭知识库指南</title></head><body><nav>无关导航</nav><article><h1>家庭知识库指南</h1>${paragraphs}<img src="../cover.png" alt="封面"/><a href="next">下一篇</a><form>私人输入<input value="secret"/></form><script>doBad()</script></article></body></html>`});
 assert.equal(result.title,'家庭知识库指南');assert.match(result.bodyMd,/https:\/\/example.com\/guides\/a/);assert.match(result.bodyMd,/家庭知识库/);assert.ok(!result.bodyMd.includes('doBad'));assert.ok(!result.bodyMd.includes('私人输入'));
 assert.equal(result.images[0]!.url,'https://example.com/cover.png');assert.match(result.bodyMd,/!\[封面\]/);assert.match(result.bodyMd,/https:\/\/example.com\/guides\/next/);
});
test('公众号正文与 lazy 主图提取，受限页面有明确兜底',()=>{
 const result=extractClip({url:'https://mp.weixin.qq.com/s/example',html:'<html><head><title>公众号文章</title></head><body><h1 id="activity-name">假期家常菜</h1><div id="js_content"><p>今天分享一道家常菜的做法，食材准备、分步烹饪和保存方法都记录下来，下次可以照着做。</p><img data-src="https://mmbiz.qpic.cn/demo.png"/></div></body></html>'});
 assert.equal(result.title,'假期家常菜');assert.equal(result.images[0]!.url,'https://mmbiz.qpic.cn/demo.png');assert.match(result.bodyMd,/食材准备/);
 assert.throws(()=>extractClip({url:'https://mp.weixin.qq.com/s/example',html:'<h1>请验证</h1>'}),/只存链接/);
 assert.match(linkOnlyClip('https://example.com/article').bodyMd,/待整理/);
});
test('选择片段无需长文，重复图片去重，结构与大小限额提前生效',()=>{
 const result=extractClip({url:'https://example.com',html:'<p>选中的一句话</p><img src="/a.png"/><img src="/a.png"/>',selection:true});assert.match(result.bodyMd,/选中的一句话/);assert.equal(result.images.length,1);
 assert.throws(()=>extractClip({url:'https://example.com',html:'x'.repeat(1_000_001)}),/1 MB/);
 assert.throws(()=>extractClip({url:'https://example.com',html:'<div>'.repeat(102)+'x'+'</div>'.repeat(102),selection:true}),/结构/);
});

test('浏览器发送的 article 片段也能按完整 Document 提取',()=>{
 const result=extractClip({url:'https://example.com',html:'<article><h1>片段标题</h1><p>正文应该完整保存到所选择的知识库，图片与链接也应该能找到，未公开笔记不会因为剪藏自动发布。</p></article>'});assert.match(result.bodyMd,/正文应该完整保存/);
});
