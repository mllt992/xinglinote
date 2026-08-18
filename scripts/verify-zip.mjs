// 前端 zip 导入解析器的单测：现造一个含 store 与 deflate 两种条目的 zip。
// 用法：node --experimental-strip-types scripts/verify-zip.mjs
import { crc32, deflateRawSync } from 'node:zlib';
import { readMarkdownZip } from '../apps/web/src/lib/zip.ts';

function zip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), raw = Buffer.from(f.content, 'utf8');
    const data = f.method === 8 ? deflateRawSync(raw) : raw, sum = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(f.method, 8);
    local.writeUInt32LE(sum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(f.method, 10);
    dir.writeUInt32LE(sum, 16); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(raw.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    chunks.push(local, name, data); central.push(dir, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

const bytes = zip([
  { name: '手册/入门.md', content: '# 入门\n压缩条目，中文路径。'.repeat(20), method: 8 },
  { name: '手册/未压缩.md', content: '# 未压缩\nstore 条目。', method: 0 },
  { name: '手册/图.png', content: 'not markdown', method: 0 },
  { name: '__MACOSX/._入门.md', content: '垃圾', method: 0 },
]);
const entries = await readMarkdownZip(new File([bytes], 'pack.zip'));
const byPath = Object.fromEntries(entries.map(e => [e.name ?? e.path, e.content]));
const result = {
  onlyMarkdown: entries.length === 2,
  keepsRelativePath: entries.some(e => e.path === '手册/入门.md'),
  inflatesDeflate: (byPath['手册/入门.md'] ?? '').startsWith('# 入门\n压缩条目，中文路径。'),
  readsStored: byPath['手册/未压缩.md'] === '# 未压缩\nstore 条目。',
  skipsMacosxJunk: !entries.some(e => e.path.includes('__MACOSX')),
};
let rejectsGarbage = false;
try { await readMarkdownZip(new File([Buffer.from('这不是 zip')], 'x.zip')); } catch { rejectsGarbage = true; }
result.rejectsGarbage = rejectsGarbage;
console.log(JSON.stringify(result, null, 2));
if (!Object.values(result).every(Boolean)) process.exitCode = 1;
