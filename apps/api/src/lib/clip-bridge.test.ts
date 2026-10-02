import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clipBridgeDocument } from './clip-bridge.ts';
test('剪藏表单桥只返回转义数据和站内脚本，不执行来源 HTML',()=>{
 const packet={url:'https://example.com/a#fragment',title:'正常标题',html:'<article><p>原文</p></article>',selection:true};
 const html=clipBridgeDocument(JSON.stringify(packet));assert.ok(!html.includes(packet.html));assert.match(html,/src="\/clip-bridge.js"/);const embedded=JSON.parse(html.match(/id="clip-packet">(.*?)<\/script>/)![1]!);assert.equal(embedded.html,packet.html);assert.equal(embedded.url,'https://example.com/a');
 assert.throws(()=>clipBridgeDocument(JSON.stringify({...packet,url:'file:///private'})),/HTTP/);
 assert.throws(()=>clipBridgeDocument(JSON.stringify({...packet,html:'文'.repeat(340000)})),/1 MB/);
});
