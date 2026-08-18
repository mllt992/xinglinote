import assert from "node:assert/strict";
import { test } from "node:test";
import { countWords, diagramBlockAt, diagramFence, outlineOf, plainTextOf, renderMarkdown, slugifyHeading, toggleTaskAt } from "./index.js";

test("GFM 表格、删除线、任务列表都在闭集里", () => {
  const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n\n~~划掉~~\n");
  // 表格套横向滚动容器：列宽交给表格自己算，容器负责滚，别把中文表头挤成一列一个字。
  assert.match(html, /<div class="table-scroll"><table>/);
  assert.match(html, /<\/table>\s*<\/div>/);
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

test("公式只出占位元素，排版交给客户端按需加载的 KaTeX", () => {
  const inline = renderMarkdown("质能方程 $E=mc^2$ 完");
  assert.match(inline, /<span class="math math-inline" data-math="E=mc\^2">/);
  // 占位元素里放的是原始源码：KaTeX 没到位（或加载失败）时看到的是公式源码，不是空白。
  assert.match(inline, /\$E=mc\^2\$<\/span>/);

  const block = renderMarkdown("$$\n\\frac{1}{2}\n$$");
  assert.match(block, /<div class="math math-block" data-math="\\frac\{1\}\{2\}" data-math-display="1">/);

  assert.doesNotMatch(renderMarkdown("这件 $5 那件 $8"), /class="math/);
  // 源码里的尖括号照样要转义，别让公式成为注入口子
  assert.match(renderMarkdown("$a<b$"), /data-math="a&lt;b"/);
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

const FENCE = String.fromCharCode(96, 96, 96);
const NL = String.fromCharCode(10);

test("mermaid 块渲染成占位元素，源码原样留在里面", () => {
  const html = renderMarkdown(`${FENCE}mermaid${NL}graph TD;A-->B;${NL}${FENCE}${NL}`);
  assert.match(html, /<div class="diagram diagram-mermaid" data-diagram="mermaid"/);
  assert.match(html, /data-diagram-src="graph TD;A--&gt;B;"/);
  // 没排版时看到的是源码，不是空白。
  assert.match(html, /<pre class="diagram-source">graph TD;A--&gt;B;<\/pre>/);
});

test("别的语言与空图块照旧走代码块", () => {
  assert.match(renderMarkdown(`${FENCE}js${NL}let a = 1;${NL}${FENCE}${NL}`), /<pre><code class="language-js">/);
  assert.doesNotMatch(renderMarkdown(`${FENCE}mermaid${NL}${FENCE}${NL}`), /data-diagram/);
});

test("mermaid 块也吃 sourceLines 行号", () => {
  const html = renderMarkdown(`正文${NL}${NL}${FENCE}mermaid${NL}graph TD;A-->B;${NL}${FENCE}${NL}`, { sourceLines: true });
  assert.match(html, /data-line="2"/);
});

test("diagramBlockAt 认出光标所在的图块", () => {
  const src = `前言${NL}${NL}${FENCE}mermaid${NL}graph TD;${NL}A-->B;${NL}${FENCE}${NL}${NL}后记`;
  const at = src.indexOf("A-->B;");
  const block = diagramBlockAt(src, at);
  assert.ok(block);
  assert.equal(block.lang, "mermaid");
  assert.equal(block.source, `graph TD;${NL}A-->B;`);
  assert.equal(src.slice(block.from, block.to), `${FENCE}mermaid${NL}graph TD;${NL}A-->B;${NL}${FENCE}`);
  // 换成新图时只动这一段，前后正文一个字节不变。
  assert.equal(src.slice(0, block.from) + diagramFence("graph LR;C-->D;") + src.slice(block.to),
    `前言${NL}${NL}${FENCE}mermaid${NL}graph LR;C-->D;${NL}${FENCE}${NL}${NL}后记`);
  assert.equal(diagramBlockAt(src, 0), null);
  assert.equal(diagramBlockAt(src, src.length - 1), null);
});

test("diagramBlockAt 不把普通代码块里的围栏当成图", () => {
  const src = `${FENCE}js${NL}// ${FENCE}mermaid${NL}${FENCE}${NL}${NL}${FENCE}mermaid${NL}graph TD;A-->B;${NL}${FENCE}`;
  assert.equal(diagramBlockAt(src, 10), null);
  assert.equal(diagramBlockAt(src, src.indexOf("graph TD"))?.source, "graph TD;A-->B;");
});
