import { crc32, inflateRawSync } from 'node:zlib';
import { fail } from '@kb/shared';

export const MIGRATION_LIMITS = { pages: 500, entries: 2000, totalBytes: 100 * 1024 * 1024, fileBytes: 25 * 1024 * 1024, pageBytes: 2 * 1024 * 1024 };
export type MigrationBudget = { bytes: number; entries: number };
export const migrationBudget = (): MigrationBudget => ({bytes:MIGRATION_LIMITS.totalBytes,entries:MIGRATION_LIMITS.entries});
export type MigrationEntry = { path: string; bytes: Buffer };

/** 路径只是归档内的逻辑地址，绝不拿来写磁盘。仍拒绝所有穿越和歧义。 */
export function migrationPath(raw: string): string {
  const path = raw.normalize('NFC').replaceAll('\\', '/');
  if (!path || path.length > 500 || /^[\/~]|^[a-z]:/i.test(path) || /[\u0000-\u001f]/.test(path) || path.split('/').some(p => p === '..')) {
    throw fail('VALIDATION', `不安全的导入路径：${raw.slice(0, 100)}`);
  }
  return path.split('/').filter(p => p && p !== '.').join('/');
}

/** 先检查中央目录与总量，再以 maxOutputLength 解压；不信任包内的尺寸声明。 */
export function readMigrationZip(bytes: Buffer, budget: MigrationBudget = migrationBudget()): MigrationEntry[] {
  const bad = (message: string): never => { throw fail('VALIDATION', `ZIP：${message}`); };
  if (bytes.length > MIGRATION_LIMITS.totalBytes) bad('压缩文件超过 100 MB');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0) bad('文件尾部不完整');
  const count = bytes.readUInt16LE(end + 10), directory = bytes.readUInt32LE(end + 16), size = bytes.readUInt32LE(end + 12);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || count !== bytes.readUInt16LE(end + 8)) bad('不支持多卷');
  if (count === 65535 || directory === 0xffffffff || size === 0xffffffff) bad('不支持 ZIP64');
  if (count > Math.min(MIGRATION_LIMITS.entries,budget.entries) || directory + size !== end) bad('条目过多或目录损坏');
  const entries: Array<{ path: string; start: number; compressed: number; length: number; method: number; crc: number }> = [];
  const names = new Set<string>(); let pos = directory, total = 0;
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || bytes.readUInt32LE(pos) !== 0x02014b50) bad('中央目录损坏');
    const flags = bytes.readUInt16LE(pos + 8), method = bytes.readUInt16LE(pos + 10), compressed = bytes.readUInt32LE(pos + 20), length = bytes.readUInt32LE(pos + 24);
    const nameSize = bytes.readUInt16LE(pos + 28), extra = bytes.readUInt16LE(pos + 30), comment = bytes.readUInt16LE(pos + 32), local = bytes.readUInt32LE(pos + 42);
    const next = pos + 46 + nameSize + extra + comment;
    if (next > end || !nameSize) bad('条目名称损坏');
    if (flags & 1 || ![0, 8].includes(method)) bad('不支持加密或此压缩方式');
    if (bytes.readUInt16LE(pos + 34) || length === 0xffffffff || compressed === 0xffffffff || local === 0xffffffff) bad('不支持 ZIP64/多卷');
    if (((bytes.readUInt32LE(pos + 38) >>> 16) & 0xf000) === 0xa000) bad('不接受符号链接');
    const rawName = bytes.subarray(pos + 46, pos + 46 + nameSize).toString('utf8');
    const path = migrationPath(rawName);
    if (names.has(path)) bad(`重复路径：${path}`); names.add(path);
    if (length > MIGRATION_LIMITS.fileBytes || (total += length) > Math.min(MIGRATION_LIMITS.totalBytes,budget.bytes)) bad('解压后超过单文件 25 MB / 总计 100 MB 限额');
    if (local + 30 > directory || bytes.readUInt32LE(local) !== 0x04034b50) bad('文件头损坏');
    const localNameSize = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), start = local + 30 + localNameSize + localExtra;
    if (start + compressed > directory || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 6) !== flags || bytes.subarray(local + 30, local + 30 + localNameSize).toString('utf8') !== rawName) bad('文件头与目录不一致');
    if (ranges.some(([a, b]) => local < b && start + compressed > a)) bad('文件数据重叠');
    ranges.push([local, start + compressed]);
    if (!rawName.endsWith('/')) entries.push({ path, start, compressed, length, method, crc: bytes.readUInt32LE(pos + 16) });
    pos = next;
  }
  if (pos !== directory + size) bad('中央目录长度错误');
  // 在任何 inflate 前一次扣除整个中央目录预算，跨多个 ZIP / DOCX 共用。
  budget.bytes -= total;budget.entries -= count;
  return entries.map(entry => {
    const compressed = bytes.subarray(entry.start, entry.start + entry.compressed);
    let output: Buffer;
    try { output = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.min(MIGRATION_LIMITS.fileBytes, entry.length) || 1 }); }
    catch { return bad(`不能解压：${entry.path}`); }
    if (output.length !== entry.length || crc32(output) !== entry.crc) bad(`尺寸或校验和错误：${entry.path}`);
    return { path: entry.path, bytes: output };
  });
}
