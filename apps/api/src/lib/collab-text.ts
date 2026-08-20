/**
 * 协同里不碰数据库、不碰 Yjs 的那一小块（设计 17 §3.4）：
 * 把「外面有人直接改了 notes.body_md」这件事折算成一次最小的文本替换。
 *
 * 单独拆出来是为了能直接单测——判断「该不该回灌、回灌哪一段」是这套东西里
 * 最容易出错也最难在跑起来之后复现的一步。
 */

export type TextPatch = { at: number; remove: number; insert: string };

/**
 * 只掐掉公共前后缀，把中间那一段当成改动。
 *
 * 不上真正的 diff 算法是刻意的：外部写（MCP 改一段、AI 重写一节、恢复历史版本）
 * 几乎总是一处连续改动，掐前后缀就已经最小；而正在打字的人只要不在这一段里，
 * 光标与选区就分毫不动。真上 Myers 反而会把一处改动拆成很多小段，
 * 每一段都在 Y.Text 上产生一次删除+插入，光标被拨来拨去。
 */
export function minimalPatch(from: string, to: string): TextPatch | null {
  if (from === to) return null;
  const max = Math.min(from.length, to.length);
  let head = 0;
  while (head < max && from[head] === to[head]) head++;
  let tail = 0;
  while (tail < max - head && from[from.length - 1 - tail] === to[to.length - 1 - tail]) tail++;
  return { at: head, remove: from.length - head - tail, insert: to.slice(head, to.length - tail) };
}

/**
 * 房间该不该把 DB 里的正文回灌进来。
 *
 * - `text`：房间此刻的文本。
 * - `stored`：DB 里现在的正文。
 * - `lastPersisted`：房间上一次亲手写下去的那份。
 *
 * `stored === lastPersisted` 说明 DB 里就是房间自己写的，房里之后的编辑是新的，
 * 该往下写而不是往回灌。只有当 `stored` 既不是房间现在的文本、也不是房间上次写的那份时，
 * 才说明有人从外面动过（MCP / AI / 恢复版本）。
 */
export function externalChange(text: string, stored: string, lastPersisted: string): TextPatch | null {
  if (stored === text || stored === lastPersisted) return null;
  return minimalPatch(text, stored);
}

/**
 * 版本合并（设计 17 §3.4）：同一篇、5 分钟内的连续协同落库复用同一条 note_versions。
 * 否则十分钟的协作能产生上百条版本，把版本抽屉淹掉。返回可复用的那条 id，没有就 null。
 */
export function mergeableCollabVersion(
  rows: Array<{ id: string; version: number; source: string; createdAt: Date }>,
  currentVersion: number,
  now = Date.now(),
) {
  const last = rows.find(r => r.version === currentVersion);
  if (!last || last.source !== "collab") return null;
  return now - last.createdAt.getTime() < 5 * 60_000 ? last.id : null;
}
