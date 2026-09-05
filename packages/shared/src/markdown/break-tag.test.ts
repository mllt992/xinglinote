import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "./index.js";

test("字面量 <br> 是硬换行（表格单元格断行），其它标签仍然转义", () => {
  assert.match(renderMarkdown("上<br>下"), /上<br>\n?下/);
  assert.match(renderMarkdown("| a | b |\n|---|---|\n| 左<br>右 | x |"), /左<br>\n?右/);
  assert.match(renderMarkdown("见 <div>"), /&lt;div&gt;/);
});
