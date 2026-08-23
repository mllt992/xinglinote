import assert from "node:assert/strict";
import test from "node:test";
import { cursorAfter, pageByCursor } from "./mcp-pagination.ts";

const context={tool:"list_test",scope:{token:"a",workspaces:["w"]},filters:{status:"open"},secret:"test-secret"};

test("不透明 cursor 可稳定遍历且不重复", () => {
  const all=[{id:"c",at:2},{id:"b",at:2},{id:"a",at:1}];
  const first=pageByCursor({...context,items:all,limit:2,keyOf:x=>[x.at,x.id],directions:["desc","desc"]});
  assert.deepEqual(first.items.map(x=>x.id),["c","b"]);
  assert.equal(first.has_more,true);
  const second=pageByCursor({...context,items:all,limit:2,cursor:first.next_cursor!,keyOf:x=>[x.at,x.id],directions:["desc","desc"]});
  assert.deepEqual(second.items.map(x=>x.id),["a"]);
  assert.equal(second.has_more,false);
});

test("cursor 绑定筛选条件与授权范围", () => {
  const page=pageByCursor({...context,items:[{id:"a"},{id:"b"}],limit:1,keyOf:x=>[x.id],directions:["asc"]});
  assert.throws(()=>cursorAfter(page.next_cursor!,{...context,filters:{status:"done"}}),/不匹配/);
  assert.throws(()=>cursorAfter(page.next_cursor!,{...context,scope:{token:"other"}}),/不匹配/);
});

test("篡改 cursor 会返回稳定错误", () => {
  assert.throws(()=>cursorAfter("broken.cursor",context),/签名无效/);
});

test("过期 cursor 返回 CURSOR_EXPIRED", () => {
  const original=Date.now;
  Date.now=()=>0;
  const page=pageByCursor({...context,items:[{id:"a"},{id:"b"}],limit:1,keyOf:x=>[x.id],directions:["asc"]});
  Date.now=original;
  try { cursorAfter(page.next_cursor!,context); assert.fail("应拒绝过期 cursor"); }
  catch (error) { assert.equal((error as {code?:string}).code,"CURSOR_EXPIRED"); }
});
