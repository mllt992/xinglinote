/**
 * GFM 表格的源码变换（设计 17 §3.5）。
 *
 * 可视化编辑最终都归到同一件事：把一张表读成单元格矩阵，改矩阵，再序列化回去。
 * 这里只做纯字符串变换，不碰 CodeMirror，也不碰 DOM——这样它能直接单测，
 * 而「只替换这张表占的那几行、表外一个字节都不动」这条铁律也才好保证。
 */

export type Align = "left" | "center" | "right" | null;

export type ParsedTable = {
  /** 含表头在内的所有行；`rows[0]` 是表头。 */
  rows: string[][];
  aligns: Align[];
  /** 原文里每行是不是以 `|` 开头 / 结尾，序列化时照抄，免得把别人的写法改了。 */
  leading: boolean;
  trailing: boolean;
};

const DELIM_CELL = /^\s*:?-{1,}:?\s*$/;

/** 按未转义的 `|` 切一行。`\|` 是单元格里的竖线，不能当分隔符。 */
function splitRow(line: string, leading: boolean, trailing: boolean): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\" && line[i + 1] === "|") { cur += "\\|"; i++; continue; }
    if (ch === "|") { cells.push(cur); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur);
  if (leading) cells.shift();
  if (trailing) cells.pop();
  return cells.map(c => c.trim());
}

function alignOf(cell: string): Align {
  const t = cell.trim();
  const left = t.startsWith(":"), right = t.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

/**
 * 读一段 Markdown 表格。不是合法表格（缺分隔行、列数对不上）就回 null——
 * 宁可不给编辑入口，也不能把一段本来能渲染的文本改坏。
 */
export function parseTable(source: string): ParsedTable | null {
  const lines = source.replace(/\n+$/, "").split("\n");
  if (lines.length < 2) return null;
  const head = lines[0]!;
  const leading = /^\s*\|/.test(head);
  const trailing = /\|\s*$/.test(head) && !/\\\|\s*$/.test(head);
  const delim = splitRow(lines[1]!, /^\s*\|/.test(lines[1]!), /\|\s*$/.test(lines[1]!));
  if (!delim.length || !delim.every(c => DELIM_CELL.test(c))) return null;

  const rows: string[][] = [];
  for (const [i, line] of lines.entries()) {
    if (i === 1) continue;
    if (!line.trim()) continue;
    rows.push(splitRow(line, /^\s*\|/.test(line), /\|\s*$/.test(line) && !/\\\|\s*$/.test(line)));
  }
  if (!rows.length) return null;
  // 列数以表头为准：GFM 也是这么定的，多的截掉、少的补空
  const width = Math.max(rows[0]!.length, delim.length);
  return {
    rows: rows.map(r => Array.from({ length: width }, (_, i) => r[i] ?? "")),
    aligns: Array.from({ length: width }, (_, i) => alignOf(delim[i] ?? "")),
    leading, trailing,
  };
}

/** 中文按两个西文宽算，不然中文表头对不齐，源码看起来是歪的。 */
export function displayWidth(text: string) {
  let w = 0;
  for (const ch of text) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

const pad = (text: string, width: number, align: Align) => {
  const gap = Math.max(0, width - displayWidth(text));
  if (align === "right") return " ".repeat(gap) + text;
  if (align === "center") return " ".repeat(Math.floor(gap / 2)) + text + " ".repeat(Math.ceil(gap / 2));
  return text + " ".repeat(gap);
};

const delimCell = (width: number, align: Align) => {
  const bar = "-".repeat(Math.max(3, width));
  if (align === "center") return `:${bar.slice(0, Math.max(1, bar.length - 2))}:`;
  if (align === "right") return `${bar.slice(0, Math.max(2, bar.length - 1))}:`;
  if (align === "left") return `:${bar.slice(0, Math.max(2, bar.length - 1))}`;
  return bar;
};

/** 序列化回 Markdown。补空格对齐，与仓库里现有表格的写法保持一致。 */
export function serializeTable(table: ParsedTable): string {
  const width = table.rows[0]?.length ?? 0;
  const cols = Array.from({ length: width }, (_, i) =>
    Math.max(3, ...table.rows.map(r => displayWidth(r[i] ?? ""))));
  const line = (cells: string[]) => {
    const body = cells.join(" | ");
    return `${table.leading ? "| " : ""}${body}${table.trailing ? " |" : ""}`.replace(/\s+$/, "");
  };
  const out = [
    line(table.rows[0]!.map((c, i) => pad(c, cols[i]!, table.aligns[i] ?? null))),
    line(cols.map((w, i) => delimCell(w, table.aligns[i] ?? null))),
    ...table.rows.slice(1).map(r => line(r.map((c, i) => pad(c, cols[i]!, table.aligns[i] ?? null)))),
  ];
  return out.join("\n");
}

const clampCol = (t: ParsedTable, i: number) => Math.min(Math.max(i, 0), (t.rows[0]?.length ?? 1) - 1);
const clampRow = (t: ParsedTable, i: number) => Math.min(Math.max(i, 0), t.rows.length - 1);
const clone = (t: ParsedTable): ParsedTable => ({ rows: t.rows.map(r => [...r]), aligns: [...t.aligns], leading: t.leading, trailing: t.trailing });

export function insertColumn(table: ParsedTable, at: number, side: "left" | "right"): ParsedTable {
  const t = clone(table);
  const i = clampCol(t, at) + (side === "right" ? 1 : 0);
  for (const row of t.rows) row.splice(i, 0, "");
  t.aligns.splice(i, 0, null);
  return t;
}

/** 只剩一列时不给删：Markdown 表格没有「零列」这种形态，删了整张表就散成普通段落。 */
export function canDeleteColumn(table: ParsedTable) { return (table.rows[0]?.length ?? 0) > 1; }

export function deleteColumn(table: ParsedTable, at: number): ParsedTable {
  if (!canDeleteColumn(table)) return table;
  const t = clone(table);
  const i = clampCol(t, at);
  for (const row of t.rows) row.splice(i, 1);
  t.aligns.splice(i, 1);
  return t;
}

/** `at` 是数据行下标（0 = 表头）。表头不能被「上面插一行」挤掉，所以最小落点是 1。 */
export function insertRow(table: ParsedTable, at: number, side: "above" | "below"): ParsedTable {
  const t = clone(table);
  const i = Math.max(1, clampRow(t, at) + (side === "below" ? 1 : 0));
  t.rows.splice(i, 0, Array.from({ length: t.rows[0]?.length ?? 0 }, () => ""));
  return t;
}

/** 表头删不得——它是表格存在的前提。 */
export function canDeleteRow(table: ParsedTable, at: number) { return at >= 1 && table.rows.length > 1; }

export function deleteRow(table: ParsedTable, at: number): ParsedTable {
  if (!canDeleteRow(table, at)) return table;
  const t = clone(table);
  t.rows.splice(at, 1);
  return t;
}

export function setAlign(table: ParsedTable, at: number, align: Align): ParsedTable {
  const t = clone(table);
  t.aligns[clampCol(t, at)] = align;
  return t;
}

export function setCell(table: ParsedTable, row: number, col: number, text: string): ParsedTable {
  const t = clone(table);
  const r = clampRow(t, row), c = clampCol(t, col);
  // 单元格里的换行与竖线会把表格结构撕开，转义掉而不是拒绝输入
  t.rows[r]![c] = text.replace(/\r?\n/g, " ").replace(/(?<!\\)\|/g, "\\|").trim();
  return t;
}

export function moveColumn(table: ParsedTable, from: number, to: number): ParsedTable {
  const t = clone(table);
  const a = clampCol(t, from), b = clampCol(t, to);
  if (a === b) return t;
  for (const row of t.rows) row.splice(b, 0, ...row.splice(a, 1));
  t.aligns.splice(b, 0, ...t.aligns.splice(a, 1));
  return t;
}

export type TableOp =
  | { kind: "insertColumn"; at: number; side: "left" | "right" }
  | { kind: "deleteColumn"; at: number }
  | { kind: "insertRow"; at: number; side: "above" | "below" }
  | { kind: "deleteRow"; at: number }
  | { kind: "setAlign"; at: number; align: Align }
  | { kind: "setCell"; row: number; col: number; text: string }
  | { kind: "moveColumn"; from: number; to: number };

/**
 * 对一段表格源码做一次操作，回新的源码。解析不出表格、或这次操作不允许，就回 null，
 * 调用方据此不动文档——**宁可什么都不做，也不能把一段能渲染的表格改坏**。
 */
export function applyTableOp(source: string, op: TableOp): string | null {
  const table = parseTable(source);
  if (!table) return null;
  let next: ParsedTable;
  switch (op.kind) {
    case "insertColumn": next = insertColumn(table, op.at, op.side); break;
    case "deleteColumn": if (!canDeleteColumn(table)) return null; next = deleteColumn(table, op.at); break;
    case "insertRow": next = insertRow(table, op.at, op.side); break;
    case "deleteRow": if (!canDeleteRow(table, op.at)) return null; next = deleteRow(table, op.at); break;
    case "setAlign": next = setAlign(table, op.at, op.align); break;
    case "setCell": next = setCell(table, op.row, op.col, op.text); break;
    case "moveColumn": next = moveColumn(table, op.from, op.to); break;
  }
  const out = serializeTable(next);
  return out === source.replace(/\n+$/, "") ? null : out;
}
