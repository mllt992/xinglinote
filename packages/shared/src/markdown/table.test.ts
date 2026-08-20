import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyTableOp, canDeleteColumn, canDeleteRow, deleteColumn, deleteRow,
  displayWidth, insertColumn, insertRow, moveColumn, parseTable, serializeTable, setAlign, setCell,
} from "./table.js";

const T = `| 键 | 作用 |\n|---|:---:|\n| Ctrl+S | 保存 |\n| Ctrl+B | 加粗 |`;

test("解析：读出矩阵与对齐，`|` 的首尾写法照抄", () => {
  const t = parseTable(T)!;
  assert.deepEqual(t.rows, [["键", "作用"], ["Ctrl+S", "保存"], ["Ctrl+B", "加粗"]]);
  assert.deepEqual(t.aligns, [null, "center"]);
  assert.equal(t.leading, true);
  assert.equal(t.trailing, true);
});

test("解析：不带首尾竖线的写法也认", () => {
  const t = parseTable("a | b\n--- | ---\n1 | 2")!;
  assert.deepEqual(t.rows, [["a", "b"], ["1", "2"]]);
  assert.equal(t.leading, false);
  assert.equal(t.trailing, false);
});

test("解析：`\\|` 是单元格里的竖线，不是分隔符", () => {
  const t = parseTable("| a | b |\n|---|---|\n| x \\| y | z |")!;
  assert.deepEqual(t.rows[1], ["x \\| y", "z"]);
});

test("解析：不是表格就回 null，绝不硬当表格改", () => {
  for (const bad of ["就是一段普通文字", "| a | b |", "| a | b |\n| 不是分隔行 |\n| 1 | 2 |", ""]) {
    assert.equal(parseTable(bad), null, bad);
  }
});

test("解析：行的列数对不上时以表头为准，多的截少的补", () => {
  const t = parseTable("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |")!;
  assert.deepEqual(t.rows, [["a", "b"], ["1", ""], ["1", "2"]]);
});

test("序列化：补空格对齐，分隔行按对齐写", () => {
  const out = serializeTable(parseTable(T)!);
  assert.equal(out, "| 键     | 作用 |\n| ------ | :--: |\n| Ctrl+S | 保存 |\n| Ctrl+B | 加粗 |");
});

test("序列化：往返一次后再往返，结果稳定（不会每次打开都产生假 diff）", () => {
  const once = serializeTable(parseTable(T)!);
  assert.equal(serializeTable(parseTable(once)!), once);
});

test("中文按两个西文宽算，不然中文表头对不齐", () => {
  assert.equal(displayWidth("键"), 2);
  assert.equal(displayWidth("Ctrl+S"), 6);
  assert.equal(displayWidth("作用ab"), 6);
});

test("插入列：左右各一次，对齐跟着挪", () => {
  const t = parseTable(T)!;
  assert.deepEqual(insertColumn(t, 0, "left").rows[0], ["", "键", "作用"]);
  assert.deepEqual(insertColumn(t, 0, "right").rows[0], ["键", "", "作用"]);
  assert.deepEqual(insertColumn(t, 1, "right").aligns, [null, "center", null]);
});

test("删列：只剩一列时不给删", () => {
  const t = parseTable(T)!;
  assert.equal(canDeleteColumn(t), true);
  assert.deepEqual(deleteColumn(t, 0).rows, [["作用"], ["保存"], ["加粗"]]);
  const one = parseTable("| a |\n|---|\n| 1 |")!;
  assert.equal(canDeleteColumn(one), false);
  assert.deepEqual(deleteColumn(one, 0).rows, one.rows, "拒绝时原样返回，不留半张表");
});

test("插入行：往表头上面插也只会落到表头下面", () => {
  const t = parseTable(T)!;
  assert.deepEqual(insertRow(t, 0, "above").rows[1], ["", ""]);
  assert.equal(insertRow(t, 0, "above").rows[0]![0], "键", "表头不会被挤走");
  assert.deepEqual(insertRow(t, 1, "below").rows[2], ["", ""]);
});

test("删行：表头删不得", () => {
  const t = parseTable(T)!;
  assert.equal(canDeleteRow(t, 0), false);
  assert.equal(canDeleteRow(t, 1), true);
  assert.deepEqual(deleteRow(t, 1).rows, [["键", "作用"], ["Ctrl+B", "加粗"]]);
  assert.deepEqual(deleteRow(t, 0).rows, t.rows);
});

test("对齐：三选一都写得回去，也能清掉", () => {
  const t = parseTable(T)!;
  assert.match(serializeTable(setAlign(t, 0, "right")), /\n\| *-+: \|/);
  assert.match(serializeTable(setAlign(t, 0, "center")), /\n\| :-+: \|/);
  assert.match(serializeTable(setAlign(t, 1, null)), /\| -+ \|\n/);
});

test("改单元格：换行与裸竖线会撕开表格，一律转义", () => {
  const t = setCell(parseTable(T)!, 1, 1, "先 a\n再 | b");
  assert.equal(t.rows[1]![1], "先 a 再 \\| b");
  assert.deepEqual(parseTable(serializeTable(t))!.rows[1], ["Ctrl+S", "先 a 再 \\| b"]);
});

test("移动列：内容与对齐一起走", () => {
  const t = moveColumn(parseTable(T)!, 1, 0);
  assert.deepEqual(t.rows[0], ["作用", "键"]);
  assert.deepEqual(t.aligns, ["center", null]);
});

test("applyTableOp：不是表格、或这次操作不允许，都回 null 让调用方别动文档", () => {
  assert.equal(applyTableOp("普通段落", { kind: "insertRow", at: 1, side: "below" }), null);
  assert.equal(applyTableOp("| a |\n|---|\n| 1 |", { kind: "deleteColumn", at: 0 }), null);
  assert.equal(applyTableOp(T, { kind: "deleteRow", at: 0 }), null);
});

test("applyTableOp：没有实际变化时也回 null，不制造空 diff", () => {
  const normalized = serializeTable(parseTable(T)!);
  assert.equal(applyTableOp(normalized, { kind: "setCell", row: 1, col: 0, text: "Ctrl+S" }), null);
});

test("applyTableOp：改完仍是能被重新解析的合法表格", () => {
  let src = T;
  for (const op of [
    { kind: "insertColumn", at: 1, side: "right" },
    { kind: "insertRow", at: 2, side: "below" },
    { kind: "setCell", row: 3, col: 2, text: "新格" },
    { kind: "setAlign", at: 2, align: "right" },
    { kind: "moveColumn", from: 2, to: 0 },
    { kind: "deleteRow", at: 1 },
  ] as const) {
    const next = applyTableOp(src, op);
    assert.ok(next, `${op.kind} 应当改得动`);
    src = next;
    assert.ok(parseTable(src), `${op.kind} 之后仍应是合法表格`);
  }
  assert.deepEqual(parseTable(src)!.rows[0], ["", "键", "作用"]);
});
