import assert from "node:assert/strict";
import { test } from "node:test";
import { tableCellAtSourceOffset, tableCellSourceRange } from "./table-edit.js";

function cell(source: string, row: number, col: number) {
  const range = tableCellSourceRange(source, row, col);
  return range ? { ...range, text: source.slice(range.from, range.to) } : null;
}

test("表格单元格范围映射回 Markdown 源码，并排除两侧排版空白", () => {
  const source = "前列 | 后列\n--- | ---\n值一 | 需要引用的内容";
  assert.deepEqual(cell(source, 1, 1), { from: source.indexOf("需要引用"), to: source.length, text: "需要引用的内容" });
});

test("带首尾竖线、中文和转义竖线的单元格仍能精确映射", () => {
  const source = "| 字段 | 说明 |\n| --- | --- |\n| kind | `A` 或 B \\| C |";
  const text = "`A` 或 B \\| C";
  const from = source.indexOf(text);
  assert.deepEqual(cell(source, 1, 1), { from, to: from + text.length, text });
});

test("表头按第零行映射，越界单元格返回 null", () => {
  const source = "| 字段 | 说明 |\n| --- | --- |\n| id | 主键 |";
  const from = source.indexOf("说明");
  assert.deepEqual(cell(source, 0, 1), { from, to: from + 2, text: "说明" });
  assert.equal(tableCellSourceRange(source, 9, 0), null);
  assert.equal(tableCellSourceRange(source, 0, 9), null);
});

test("源码偏移能反查可视化表格单元格，分隔行不冒充内容", () => {
  const source = "| 字段 | 说明 |\n| --- | --- |\n| id | 主键 |";
  assert.deepEqual(tableCellAtSourceOffset(source, source.indexOf("主键")), { row: 1, col: 1 });
  assert.deepEqual(tableCellAtSourceOffset(source, source.indexOf("字段")), { row: 0, col: 0 });
  assert.equal(tableCellAtSourceOffset(source, source.indexOf("---")), null);
});
