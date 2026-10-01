import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareClip } from './clip-prepare.ts';
test('普通重定向后按最终网页 URL 解析相对链接和图片',async()=>{
 const clip=await prepareClip({url:'https://example.com/short',mode:'article'},async()=>({status:200,url:'https://articles.example.com/recipes/tomato/',contentType:'text/html;charset=utf-8',body:Buffer.from('<html><body><article><h1>番茄汤</h1><p>准备新鲜的番茄和鸡蛋，先把番茄炒软，再加入清水煮开。慢慢加入蛋液，保持小火，最后加入盐和葱花。</p><img src="photo.png"><a href="next">下一篇</a></article></body></html>')}));
 assert.equal(clip.sourceUrl,'https://articles.example.com/recipes/tomato/');assert.equal(clip.images[0]?.url,'https://articles.example.com/recipes/tomato/photo.png');assert.match(clip.bodyMd,/https:\/\/articles.example.com\/recipes\/tomato\/next/);
});

test('浏览器从公众号提取的正文片段不要求原页面 js_content 外壳',async()=>{
 const paragraph='<p>准备新鲜的番茄和鸡蛋，先把番茄炒软，再加入清水煮开。慢慢加入蛋液，保持小火，最后加入盐和葱花。</p>';
 for(const html of [paragraph,`<div id="js_content">${paragraph}</div>`]){const clip=await prepareClip({url:'https://mp.weixin.qq.com/s/fixture',mode:'article',title:'浏览器里的公众号标题',html});assert.equal(clip.title,'浏览器里的公众号标题');assert.match(clip.bodyMd,/准备新鲜/);}
});
