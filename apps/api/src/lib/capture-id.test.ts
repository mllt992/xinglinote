import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureTargetId } from './capture-id.ts';
test('速记幂等主键绑定账号、位置、类型与草稿',()=>{
 const a=captureTargetId('user-a','ws-a','task','draft');
 assert.equal(a,captureTargetId('user-a','ws-a','task','draft'));
 for(const b of [captureTargetId('user-b','ws-a','task','draft'),captureTargetId('user-a','ws-b','task','draft'),captureTargetId('user-a','ws-a','note','draft'),captureTargetId('user-a','ws-a','task','new')])assert.notEqual(a,b);
 assert.match(a,/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
});
