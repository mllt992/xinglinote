import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareMigration, csvToMarkdown, migrationTitlePath } from './migration-source.ts';
import { htmlToMarkdown } from './migration-html.ts';
import { readMigrationZip, migrationPath } from './migration-zip.ts';
import { makeZip } from './zip.ts';
import { parseFront } from './import-plan-path.ts';
import { FIXTURE_PNG, notionExportFixture, wordExportFixture } from './__fixtures__/migration-export.ts';

test('合成 Notion ≥50 页：层级、标题、待办、图片、附件、CSV 表格',async()=>{
  const result=await prepareMigration([{path:'Notion.zip',bytes:notionExportFixture()}]);
  assert.equal(result.source,'notion'); assert.equal(result.files.length,57);
  const page=result.files.find(f=>f.path==='合成知识库/项目/页面 01.md')!;
  assert.ok(page);assert.equal(parseFront(page.content).title,'页面 01');
  assert.match(page.content,/- \[ \] 待办/);assert.match(page.content,/- \[x\] 已完成/);
  assert.equal(page.assets.length,2);assert.equal(page.assets[0]!.mime,'image/png');assert.deepEqual(page.assets[0]!.bytes,FIXTURE_PNG);
  const csv=result.files.find(f=>f.path.endsWith('/数据库.md'))!;assert.match(csv.content,/\| 名称 \| 状态 \| 备注 \|/);assert.match(csv.content,/多行<br>说明/);assert.match(csv.warnings[0]!,/静态/);
  assert.equal(result.report.filter(r=>r.status==='failed').length,0);
});
test('语雀保留导出目录，中文百分号路径与相对附件',async()=>{
  const result=await prepareMigration([{path:'语雀.zip',bytes:makeZip([{path:'团队/教程/入门.md',data:Buffer.from('# 入门\n![图](../资源/图%20片.png)')},{path:'团队/资源/图 片.png',data:FIXTURE_PNG}])}],'yuque');
  assert.equal(result.files[0]!.path,'团队/教程/入门.md');assert.equal(result.files[0]!.assets.length,1);assert.equal(result.report.length,0);
});
test('HTML 先消毒：脚本/事件/iframe/危险 URL 不进入正文，远程图不发请求',async()=>{
  const before=globalThis.fetch;let requests=0;globalThis.fetch=async()=>{requests++;throw Error('不应联网');};
  try{
    const result=await prepareMigration([{path:'article.html',bytes:Buffer.from('<html><title>文章标题</title><body><h1>正文</h1><script>secret()</script><iframe src="http://127.0.0.1/private">bad</iframe><p onclick="bad()">安全 <a href="javascript:alert(1)">链接</a></p><img src="http://169.254.169.254/latest/meta-data" onerror="bad()"><ul><li><input type="checkbox" checked>完成</li></ul></body></html>')}]);
    assert.equal(requests,0);const page=result.files[0]!;assert.equal(parseFront(page.content).title,'文章标题');assert.doesNotMatch(page.content,/secret|iframe|javascript:|onclick|onerror|!\[/);assert.match(page.content,/\[x\]/);assert.ok(page.warnings.length>0);
  }finally{globalThis.fetch=before;}
});
test('HTML 表格和本地 data 图片保留，通用转换器默认不保留可执行图片',async()=>{
  const html=`<h1>图</h1><img alt="内嵌" src="data:image/png;base64,${FIXTURE_PNG.toString('base64')}"><table><tr><th>列</th></tr><tr><td>值</td></tr></table>`;
  const result=await prepareMigration([{path:'image.html',bytes:Buffer.from(html)}]);assert.equal(result.files[0]!.assets.length,1);assert.match(result.files[0]!.content,/\| 列 \|/);
  assert.doesNotMatch(htmlToMarkdown('<img src="/api/private">').content,/!\[/);
});
test('DOCX 安全转换正文与内嵌图片',async()=>{
  const result=await prepareMigration([{path:'合成.docx',bytes:wordExportFixture()}]);
  assert.equal(result.files.length,1,JSON.stringify(result.report));assert.match(result.files[0]!.content,/Word 正文/);assert.equal(result.files[0]!.assets.length,1);assert.match(result.files[0]!.warnings.join(' '),/复杂排版/);
});
test('Markdown 普通/引用式附件、外链图片、不支持附件与代码示例',async()=>{
  const source='# 正文\n![本地][img]\n\n[img]: photo.png\n\n![远程](http://127.0.0.1/a.png)\n[危险](javascript:evil)\n[缺失](missing.pdf)\n```md\n![例子](missing.png)\n```';
  const result=await prepareMigration([{path:'note.md',bytes:Buffer.from(source)},{path:'photo.png',bytes:FIXTURE_PNG}]);
  const page=result.files[0]!;assert.equal(page.assets.length,1);assert.doesNotMatch(page.content,/!\[远程\]|javascript:evil/);assert.match(page.content,/!\[例子\]\(missing.png\)/);assert.ok(page.warnings.some(w=>w.includes('missing.pdf')));
});
test('单个坏文件按路径报告，不妨碍其他正文预览',async()=>{
  const result=await prepareMigration([{path:'broken.docx',bytes:Buffer.from('bad')},{path:'good.md',bytes:Buffer.from('正常')},{path:'archive.enex',bytes:Buffer.from('<en-export/>')}]);
  assert.equal(result.files.length,1);assert.ok(result.report.some(r=>r.path==='broken.docx'&&r.status==='failed'));assert.ok(result.report.some(r=>r.path==='archive.enex'&&r.status==='skipped'));
});
test('CSV 引号转义、逗号、换行；拒绝未闭合引号',()=>{
  assert.match(csvToMarkdown('A,B\n"x,y","a""b"'),/x,y \| a"b/);assert.throws(()=>csvToMarkdown('A\n"bad'),/未闭合/);
});
test('Notion 展示路径不带页面 ID，普通路径保持原样',()=>{
  const path=`根 ${'a'.repeat(32)}/标题 ${'b'.repeat(32)}.md`;assert.equal(migrationTitlePath(path,'notion'),'根/标题.md');assert.equal(migrationTitlePath(path,'generic'),path);
});
test('拒绝 ZIP 路径穿越、绝对路径、加密、软链接和重复条目',()=>{
  for(const path of ['../escape.md','/absolute.md','C:\\file.md','a\\..\\escape.md'])assert.throws(()=>readMigrationZip(makeZip([{path,data:Buffer.from('x')}])),/不安全/);
  assert.throws(()=>migrationPath('bad\0path.md'),/不安全/);
  assert.throws(()=>readMigrationZip(makeZip([{path:'a.md',data:Buffer.from('1')},{path:'a.md',data:Buffer.from('2')}])),/重复/);
  const encrypted=makeZip([{path:'a.md',data:Buffer.from('x')}]);const directory=encrypted.readUInt32LE(encrypted.length-6);encrypted.writeUInt16LE(1,directory+8);assert.throws(()=>readMigrationZip(encrypted),/加密/);
  const symlink=makeZip([{path:'a.md',data:Buffer.from('x')}]);symlink.writeUInt32LE(0xa1ff0000,directory+38);assert.throws(()=>readMigrationZip(symlink),/符号链接/);
});
test('ZIP 大小谎报/炸弹/损坏 CRC/截断不会无限解压',()=>{
  const bomb=makeZip([{path:'large.md',data:Buffer.alloc(100_000,65)}]);const directory=bomb.readUInt32LE(bomb.length-6);bomb.writeUInt32LE(10,directory+24);assert.throws(()=>readMigrationZip(bomb),/不能解压/);
  const badCrc=makeZip([{path:'a.md',data:Buffer.from('abc')}]);const dir=badCrc.readUInt32LE(badCrc.length-6);badCrc.writeUInt32LE(1,dir+16);assert.throws(()=>readMigrationZip(badCrc),/校验和/);
  assert.throws(()=>readMigrationZip(badCrc.subarray(0,badCrc.length-10)),/不完整/);
});
test('超过 500 篇整体拒绝，外来 frontmatter id 丢弃且 JSON 标题正确解析',async()=>{
  await assert.rejects(prepareMigration([{path:'large.zip',bytes:notionExportFixture(501)}]),/500/);
  const result=await prepareMigration([{path:'note.md',bytes:Buffer.from('---\nid: fake-id\ntitle: "带 \\"引号\\" 的标题"\n---\n正文')}]);assert.doesNotMatch(result.files[0]!.content,/fake-id/);assert.equal(parseFront(result.files[0]!.content).title,'带 "引号" 的标题');
});

test('Obsidian 附件与简写引用可用，代码中的引用定义不改变',async()=>{
  const raw='![[photo.png]]\n![缩写]\n\n[缩写]: photo.png\n\n```md\n[原样]: photo.png\n![原样]\n```';
  const result=await prepareMigration([{path:'note.md',bytes:Buffer.from(raw)},{path:'photo.png',bytes:FIXTURE_PNG}]);
  const page=result.files[0]!;assert.equal(page.assets.length,1);assert.match(page.content,/!\[缩写\]\(<\/__migration_asset/);assert.match(page.content,/\[原样\]: photo.png/);
});
test('通用 HTML 转换器可将文章相对链接变成原站绝对链接',()=>{
  const result=htmlToMarkdown('<a href="../guide?a=1">指南</a><img src="/img.png">',{baseUrl:'https://example.invalid/news/page'});
  assert.match(result.content,/https:\/\/example.invalid\/guide\?a=1/);assert.match(result.content,/https:\/\/example.invalid\/img.png/);assert.doesNotMatch(result.content,/!\[/);
});
