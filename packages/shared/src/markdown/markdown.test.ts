import assert from "node:assert/strict";
import { test } from "node:test";
import { countWords, diagramBlockAt, diagramFence, outlineOf, plainTextOf, renderMarkdown, sliceHeadingSection, slugifyHeading, toggleTaskAt } from "./index.js";

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

test("章节截取与正文锚点共用标题解析，重复标题和代码块不漂移", () => {
  const source = "# 安装 **指南**\n正文\n## 重复\n甲\n```md\n# 伪标题\n```\n## 重复\n乙\n# 下一章\n丙";
  assert.equal(sliceHeadingSection(source, "安装-指南"), "# 安装 **指南**\n正文\n## 重复\n甲\n```md\n# 伪标题\n```\n## 重复\n乙");
  assert.equal(sliceHeadingSection(source, "重复-2"), "## 重复\n乙");
  assert.equal(sliceHeadingSection(source, "伪标题"), null);
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

test("Callout：类型落到 class，标题可省，正文照常解析", () => {
  const html = renderMarkdown("> [!WARNING] 小心\n> 正文 **粗体**\n");
  assert.match(html, /<blockquote class="callout callout-warning" data-callout="warning">/);
  assert.match(html, /<div class="callout-title">小心<\/div>/);
  assert.match(html, /<strong>粗体<\/strong>/);
  // 省标题时用类型的中文名兜底
  assert.match(renderMarkdown("> [!TIP]\n> 只有正文\n"), /<div class="callout-title">提示<\/div>/);
  // 只有标题没有正文时不留空段落
  assert.doesNotMatch(renderMarkdown("> [!NOTE] 单行\n"), /<p><\/p>/);
  // GitHub 的别名认，认不出的类型不抢普通引用
  assert.match(renderMarkdown("> [!CAUTION] 危\n"), /callout-caution/);
  assert.doesNotMatch(renderMarkdown("> [!随便] 写\n"), /callout/);
  // 折叠写法的 +/- 只识别不折叠，标题不该把符号带出来
  assert.match(renderMarkdown("> [!NOTE]- 收起来\n> 正文\n"), /<div class="callout-title">收起来<\/div>/);
});

test("Callout 导出仍是合法引用块：源码不动", () => {
  const src = "> [!NOTE] 标题\n> 正文\n";
  // 渲染是显示层的事，正文字节一个不改（设计 17 §4.1）
  assert.equal(plainTextOf(src).includes("[!NOTE]"), false);
  assert.match(renderMarkdown(src), /<blockquote/);
});

test("脚注：按首次引用编号，未定义的保持字面量", () => {
  const html = renderMarkdown("正文[^b] 再来[^a] 又是[^b]\n\n[^a]: 甲的注\n[^b]: 乙的 **注**\n");
  // b 先出现，所以 b 是 1
  assert.match(html, /<a id="fnref-1-1" href="#fn-1">\[1\]<\/a>/);
  assert.match(html, /<a id="fnref-2-1" href="#fn-2">\[2\]<\/a>/);
  assert.match(html, /<a id="fnref-1-2" href="#fn-1">\[1\]<\/a>/);
  assert.match(html, /<section class="footnotes">/);
  assert.match(html, /<li id="fn-1" class="footnote-item"><p>乙的 <strong>注<\/strong>/);
  // 被引用两次就给两个回跳
  assert.match(html, /href="#fnref-1-1"[^>]*>↩<\/a><a href="#fnref-1-2"/);
  // 定义行本身不该出现在正文里
  assert.doesNotMatch(html, /\[\^a\]:/);
  // 没定义的引用原样留着
  const orphan = renderMarkdown("孤儿[^zzz]\n");
  assert.match(orphan, /\[\^zzz\]/);
  assert.doesNotMatch(orphan, /<section class="footnotes">/);
});

test("脚注：定义可以缩进续行；没被引用的定义不输出", () => {
  const html = renderMarkdown("正文[^a]\n\n[^a]: 第一行\n    第二行\n\n[^unused]: 没人引用\n");
  assert.match(html, /第一行[\s\S]*第二行/);
  assert.doesNotMatch(html, /没人引用/);
});

test("==高亮== 支持嵌套，落单的等号不吃字", () => {
  assert.match(renderMarkdown("这是 ==重点== 那句"), /<mark>重点<\/mark>/);
  assert.match(renderMarkdown("==**加粗的重点**=="), /<mark><strong>加粗的重点<\/strong><\/mark>/);
  // 单个等号是普通字符，别把 `a = b` 变成高亮
  assert.doesNotMatch(renderMarkdown("a = b = c"), /<mark>/);
  assert.doesNotMatch(renderMarkdown("`==代码里的==`"), /<mark>/);
});

test("打开 hashtags 才把 #标签 标成链接", () => {
  assert.doesNotMatch(renderMarkdown("今天 #轻舟"), /class="hashtag"/);
  assert.match(renderMarkdown("今天 #轻舟", { hashtags: true }), /data-hashtag="轻舟"/);
  assert.doesNotMatch(renderMarkdown("# 一级标题", { hashtags: true }), /class="hashtag"/);
  assert.doesNotMatch(renderMarkdown("`#轻舟`", { hashtags: true }), /class="hashtag"/);
});

test("传了 mentionHandles 才把 @handle 标成 mention", () => {
  assert.doesNotMatch(renderMarkdown("找 @Arch 帮忙"), /class="mention"/);
  assert.match(renderMarkdown("找 @Arch 帮忙", { mentionHandles: ["arch"] }), /<span class="mention">@Arch<\/span>/);
  assert.doesNotMatch(renderMarkdown("mailbox@domain.com", { mentionHandles: ["domain"] }), /class="mention"/);
  assert.doesNotMatch(renderMarkdown("`@Arch`", { mentionHandles: ["arch"] }), /class="mention"/);
  assert.doesNotMatch(renderMarkdown("找 @Nobody 帮忙", { mentionHandles: ["arch"] }), /class="mention"/);
});

test("闭集新增的三样都不进字数与摘要", () => {
  const src = "> [!NOTE] 提示\n> 正文\n\n段落[^1] 与 ==重点==\n\n[^1]: 注释\n";
  const plain = plainTextOf(src);
  assert.doesNotMatch(plain, /\[!NOTE\]/);
  assert.doesNotMatch(plain, /\[\^1\]/);
  assert.doesNotMatch(plain, /==/);
  assert.match(plain, /重点/);
});
