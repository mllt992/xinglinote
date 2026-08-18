import assert from "node:assert/strict";
import { test } from "node:test";
import { countWords, outlineOf, plainTextOf, renderMarkdown, slugifyHeading, toggleTaskAt } from "./index.js";

test("GFM 表格、删除线、任务列表都在闭集里", () => {
  const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n\n~~划掉~~\n");
  assert.match(html, /<table>/);
  assert.match(html, /<s>划掉<\/s>/);
  const task = renderMarkdown("- [ ] 待办\n- [x] 已办\n");
  assert.match(task, /class="task-list"/);
  assert.match(task, /type="checkbox" disabled data-task-line="0"/);
  assert.match(task, /type="checkbox" checked disabled data-task-line="1"/);
  assert.doesNotMatch(task, /\[ \]/);
});

test("任务列表可交互时才允许点击", () => {
  assert.match(renderMarkdown("- [ ] 待办\n", { interactiveTasks: true }), /type="checkbox" data-task-line="0"/);
});

test("勾选只改那一个字符", () => {
  const src = "标题\n\n- [ ] 待办 [[链接]]\n- [x] 已办\n";
  assert.equal(toggleTaskAt(src, 2), "标题\n\n- [x] 待办 [[链接]]\n- [x] 已办\n");
  assert.equal(toggleTaskAt(src, 3), "标题\n\n- [ ] 待办 [[链接]]\n- [ ] 已办\n");
  assert.equal(toggleTaskAt(src, 0), src);
  assert.equal(toggleTaskAt(src, 99), src);
});

test("双链四种写法", () => {
  assert.match(renderMarkdown("[[会议纪要]]"), /data-wiki="%E4%BC%9A%E8%AE%AE%E7%BA%AA%E8%A6%81"/);
  assert.match(renderMarkdown("[[会议纪要|纪要]]"), />纪要</);
  assert.match(renderMarkdown("[[会议纪要#决议]]"), /data-wiki-section=/);
  assert.match(renderMarkdown("![[会议纪要]]"), /class="wiki embed"[^>]*data-wiki-embed="1"/);
});

test("代码块与行内代码里的 [[ 不是双链", () => {
  assert.doesNotMatch(renderMarkdown("```\n[[不是链接]]\n```"), /data-wiki=/);
  assert.doesNotMatch(renderMarkdown("`[[不是链接]]`"), /data-wiki=/);
});

test("双链交给宿主解析，公开页给不出地址就退成纯文本", () => {
  const resolveWiki = (ref: { title: string }) => (ref.title === "有" ? { href: "/w/1/n/2" } : { missing: true });
  assert.match(renderMarkdown("[[有]]", { resolveWiki }), /<a class="wiki" href="\/w\/1\/n\/2"/);
  assert.match(renderMarkdown("[[无]]", { resolveWiki }), /class="wiki missing" role="link"/);
  assert.match(renderMarkdown("[[无]]", { mode: "public" }), /class="wiki plain"/);
  assert.match(renderMarkdown("[[无]]"), /role="link"/);
});

test("公式渲染，坏公式退回源码不炸", () => {
  assert.match(renderMarkdown("质能方程 $E=mc^2$ 完"), /class="math math-inline"/);
  assert.match(renderMarkdown("$$\n\frac{1}{2}\n$$"), /class="math math-block"/);
  assert.match(renderMarkdown("$\frac{1}$"), /class="math-error"/);
  assert.doesNotMatch(renderMarkdown("这件 $5 那件 $8"), /class="math/);
});

test("用户 HTML 一律不解析", () => {
  assert.doesNotMatch(renderMarkdown("<script>alert(1)</script>"), /<script>/);
  assert.doesNotMatch(renderMarkdown("<div onclick='x'>hi</div>"), /<div/);
  assert.match(renderMarkdown("<div onclick='x'>hi</div>"), /&lt;div onclick/);
});

test("标题带锚点，重名加序号", () => {
  const html = renderMarkdown("# 决议\n## 决议\n");
  assert.match(html, /<h1 id="决议">/);
  assert.match(html, /<h2 id="决议-2">/);
  assert.equal(slugifyHeading("Hello, World! 你好"), "hello-world-你好");
});

test("目录带层级与行号", () => {
  assert.deepEqual(outlineOf("# 一\n\n正文\n\n## 二 [[三|别名]]\n"), [
    { level: 1, text: "一", slug: "一", line: 0 },
    { level: 2, text: "二 别名", slug: "二-别名", line: 4 },
  ]);
});

test("纯文本摘要吃掉标记", () => {
  assert.equal(plainTextOf("# 标题\n\n- [ ] 做 **这个** 和 [[那个|它]]\n\n`code`\n"), "标题 做 这个 和 它");
});

test("外链新窗口打开，站内链接不动", () => {
  assert.match(renderMarkdown("[x](https://example.com)"), /target="_blank" rel="noreferrer noopener"/);
  assert.doesNotMatch(renderMarkdown("[x](/w/1/n/2)"), /target="_blank"/);
});

test("sourceLines 只在要求时给块级元素打行号", () => {
  const src = "# 标题" + String.fromCharCode(10, 10) + "正文。" + String.fromCharCode(10, 10) + "- 甲" + String.fromCharCode(10) + "- 乙";
  const plain = renderMarkdown(src);
  assert.doesNotMatch(plain, /data-line/);
  const traced = renderMarkdown(src, { sourceLines: true });
  assert.match(traced, /<h1 id="标题" data-line="0">/);
  assert.match(traced, /<p data-line="2">/);
  assert.match(traced, /<ul data-line="4">/);
  assert.match(traced, /<li data-line="5">/);
});

test("字数：中日韩按字、拉丁按词，标记不算", () => {
  assert.equal(countWords("你好世界"), 4);
  assert.equal(countWords("hello world"), 2);
  assert.equal(countWords("# 标题 **加粗** hello"), 5);   // 标题2 + 加粗2 + hello1
  assert.equal(countWords(""), 0);
});
