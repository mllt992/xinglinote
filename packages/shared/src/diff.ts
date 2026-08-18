export type DiffOp = "same" | "add" | "del";

/** 一行差异。aLine / bLine 是 1 起的行号，删除行没有 bLine，新增行没有 aLine。 */
export type DiffLine = { op: DiffOp; text: string; aLine?: number; bLine?: number };

/** LCS 动态规划的格子上限，超过就退化成整段替换，免得几万行的笔记把浏览器卡死。 */
const MAX_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // 末尾换行会切出一个空串，它不是真正的一行。
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 逐行对比两段文本（a 是旧的，b 是新的）。 */
export function diffLines(a: string, b: string): DiffLine[] {
  const oldLines = splitLines(a);
  const newLines = splitLines(b);
  const out: DiffLine[] = [];

  // 先切掉共同的头尾，中间那段才需要跑 LCS。
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++;
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail++;

  for (let i = 0; i < head; i++) out.push({ op: "same", text: oldLines[i], aLine: i + 1, bLine: i + 1 });

  const midOld = oldLines.slice(head, oldLines.length - tail);
  const midNew = newLines.slice(head, newLines.length - tail);
  for (const line of middleDiff(midOld, midNew, head)) out.push(line);

  for (let i = 0; i < tail; i++) {
    const ai = oldLines.length - tail + i;
    const bi = newLines.length - tail + i;
    out.push({ op: "same", text: oldLines[ai], aLine: ai + 1, bLine: bi + 1 });
  }
  return out;
}

function middleDiff(oldLines: string[], newLines: string[], offset: number): DiffLine[] {
  const out: DiffLine[] = [];
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0 && m === 0) return out;
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_CELLS) {
    for (let i = 0; i < n; i++) out.push({ op: "del", text: oldLines[i], aLine: offset + i + 1 });
    for (let j = 0; j < m; j++) out.push({ op: "add", text: newLines[j], bLine: offset + j + 1 });
    return out;
  }

  // lcs[i][j] = oldLines[i..] 和 newLines[j..] 的最长公共子序列长度，摊平成一维。
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = oldLines[i] === newLines[j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      out.push({ op: "same", text: oldLines[i], aLine: offset + i + 1, bLine: offset + j + 1 });
      i++; j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      out.push({ op: "del", text: oldLines[i], aLine: offset + i + 1 });
      i++;
    } else {
      out.push({ op: "add", text: newLines[j], bLine: offset + j + 1 });
      j++;
    }
  }
  while (i < n) { out.push({ op: "del", text: oldLines[i], aLine: offset + i + 1 }); i++; }
  while (j < m) { out.push({ op: "add", text: newLines[j], bLine: offset + j + 1 }); j++; }
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.op === "add") added++;
    else if (line.op === "del") removed++;
  }
  return { added, removed };
}

export type DiffChunk =
  | { kind: "lines"; lines: DiffLine[] }
  | { kind: "gap"; count: number; lines: DiffLine[] };

/** 把没改动的大段折叠起来，只在改动前后各留 context 行。 */
export function collapseDiff(lines: DiffLine[], context = 3): DiffChunk[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].op === "same") continue;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  }
  const chunks: DiffChunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const visible = keep[i];
    const start = i;
    while (i < lines.length && keep[i] === visible) i++;
    const slice = lines.slice(start, i);
    // 只藏几行反而更碍眼，索性直接展开。
    if (!visible && slice.length <= context) chunks.push({ kind: "lines", lines: slice });
    else if (visible) chunks.push({ kind: "lines", lines: slice });
    else chunks.push({ kind: "gap", count: slice.length, lines: slice });
  }
  return chunks;
}

/** 一段连续的改动（增/删混在一起算一段），[start, end) 是 DiffLine 数组下标。 */
export type DiffHunk = { index: number; start: number; end: number; added: number; removed: number };

export function hunksOf(lines: DiffLine[]): DiffHunk[] {
  const out: DiffHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].op === "same") { i++; continue; }
    const start = i;
    let added = 0;
    let removed = 0;
    while (i < lines.length && lines[i].op !== "same") {
      if (lines[i].op === "add") added++; else removed++;
      i++;
    }
    out.push({ index: out.length, start, end: i, added, removed });
  }
  return out;
}

/**
 * 逐块采纳：accepted 里的块取新内容（add），没采纳的块保留原内容（del）。
 * 传空集合就等于原样退回，传全集就等于整篇接受。
 */
export function applyHunks(lines: DiffLine[], accepted: ReadonlySet<number>): string {
  const hunks = hunksOf(lines);
  const owner = new Map<number, number>();
  for (const h of hunks) for (let i = h.start; i < h.end; i++) owner.set(i, h.index);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.op === "same") { out.push(line.text); continue; }
    const take = accepted.has(owner.get(i) ?? -1);
    if (take ? line.op === "add" : line.op === "del") out.push(line.text);
  }
  return out.join("\n");
}
