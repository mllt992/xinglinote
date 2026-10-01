import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compactNoteTitlePlugin } from '../../compact-note-title-plugin.ts';

test('生产标题变换移除带恢复保护的旧输入，只留下受同样保护的紧凑标题',()=>{
 const source=readFileSync(new URL('../App.tsx',import.meta.url),'utf8');
 const transform=compactNoteTitlePlugin().transform as (code:string,id:string)=>string|undefined;
 const output=transform(source,'/app/apps/web/src/App.tsx');assert.ok(output);
 assert.equal((output.match(/<NoteTitleChrome /g)??[]).length,1);
 assert.match(output,/canEdit=\{note.canEdit && !localRecovery\}/);
 assert.equal((output.match(/placeholder="无标题"/g)??[]).length,0,'不能留下正文区旧标题输入');
 assert.equal(transform(output,'/app/apps/web/src/App.tsx'),undefined,'重复变换应幂等');
});
