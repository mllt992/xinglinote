import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boardPlainText, drawioText, emptyMindMap, extractBoardNoteLinks, extractMindMapNoteLinks, listOutline, mindMapFromMarkdown, mindMapFromOutline,
  mindMapToOutline, MindMapDataError, noteIdFromHref, noteLinkHref, parseMindMapOutline, remapBoardNotes, remapMindMapNotes, sanitizeDrawio, sanitizeMindMap,
  type MindMapData,
} from "./mindmap.ts";

const NOTE = "0b8a5c0e-3a57-4d8e-9d1c-2f4f1b7a9c11";
const NOTE2 = "1c9b6d1f-4b68-4e9f-8e2d-3a5a2c8b0d22";
const PNG = "data:image/png;base64,iVBORw0KGgo=";

test("清洗：丢掉危险字段与富文本，保留白名单与样式", () => {
  const data = sanitizeMindMap({
    layout: "fishbone",
    theme: { template: "kb", config: { lineColor: "#333", backgroundImage: "url(http://evil)", second: { fillColor: "#fff", evil: "<b>" } } },
    root: {
      data: { uid: "root", text: "<b>中心</b>", richText: true, image: "javascript:alert(1)", attachmentUrl: "http://x", fillColor: "url(http://evil)", color: "#fff", fontSize: 18, startDir: [0, 1] },
      children: [
        { data: { uid: "a1", text: "外链", hyperlink: "javascript:alert(1)" }, children: [] },
        { data: { uid: "a2", text: "笔记", hyperlink: noteLinkHref(NOTE), tag: ["t", { text: "obj" }, 3], icon: ["priority_1", "<svg>"], note: "备注", image: PNG, imageSize: { width: 20, height: 10 } }, children: [] },
        { data: { uid: "a3", text: "网页", hyperlink: "https://example.com/x", expand: false, generalization: { text: "概要", onclick: "x" }, associativeLineTargets: ["a1", "gone"], associativeLineText: { a1: "关联" } }, children: [] },
      ],
    },
  });
  assert.equal(data.layout, "fishbone");
  assert.deepEqual(data.theme, { template: "kb", config: { lineColor: "#333", second: { fillColor: "#fff" } } });
  const root = data.root.data;
  assert.equal(root.text, "中心");
  assert.equal(root.richText, undefined);
  assert.equal(root.image, undefined);
  assert.equal(root.attachmentUrl, undefined);
  assert.equal(root.fillColor, undefined);
  assert.equal(root.color, "#fff");
  assert.deepEqual(root.startDir, [0, 1]);
  const [a1, a2, a3] = data.root.children;
  assert.equal(a1!.data.hyperlink, undefined);
  assert.equal(a2!.data.hyperlink, `#note:${NOTE}`);
  assert.deepEqual(a2!.data.tag, ["t", "obj"]);
  assert.deepEqual(a2!.data.icon, ["priority_1"]);
  assert.equal(a2!.data.image, PNG);
  assert.equal(a3!.data.expand, false);
  assert.deepEqual(a3!.data.generalization, { text: "概要" });
  assert.deepEqual(a3!.data.associativeLineTargets, ["a1"]);
});

test("清洗：结构错误、超深拒绝；缺 uid 或重复 uid 自动补新的；链接标题去尖括号", () => {
  assert.throws(() => sanitizeMindMap(null), MindMapDataError);
  assert.throws(() => sanitizeMindMap({ root: "x" }), MindMapDataError);
  const dup = sanitizeMindMap({ root: { data: { uid: "a", text: "" }, children: [{ data: { uid: "a", text: "" } }] } });
  assert.equal(dup.root.data.uid, "a");
  assert.notEqual(dup.root.children[0]!.data.uid, "a");
  const titled = sanitizeMindMap({ root: { data: { uid: "r", text: "x", hyperlink: "https://a.test/", hyperlinkTitle: "<img src=x onerror=alert(1)>说明" } } });
  assert.equal(titled.root.data.hyperlinkTitle, "img src=x onerror=alert(1)说明");
  let deep: unknown = { data: { text: "x" }, children: [] };
  for (let i = 0; i < 60; i++) deep = { data: { text: "x" }, children: [deep] };
  assert.throws(() => sanitizeMindMap({ root: deep }), /最多/);
  const d = sanitizeMindMap({ root: { data: { text: "x" }, children: [{ data: { text: "y" } }] } });
  assert.ok(d.root.data.uid && d.root.children[0]!.data.uid && d.root.data.uid !== d.root.children[0]!.data.uid);
  assert.equal(d.layout, "mindMap");
});

test("第一版 mind-elixir 数据读到时自动转换", () => {
  const d = sanitizeMindMap({ direction: 1, nodeData: { id: "root", topic: "旧图", children: [{ id: "c1", topic: "子", hyperLink: noteLinkHref(NOTE), tags: ["x"], expanded: false, style: { color: "#f00", background: "#0f0", fontSize: "18px" } }] } });
  assert.equal(d.layout, "logicalStructure");
  assert.equal(d.root.data.uid, "root");
  const c = d.root.children[0]!.data;
  assert.equal(c.text, "子");
  assert.equal(c.hyperlink, `#note:${NOTE}`);
  assert.equal(c.expand, false);
  assert.equal(c.fillColor, "#0f0");
  assert.equal(c.fontSize, 18);
  assert.deepEqual(extractMindMapNoteLinks(d), [{ nodeId: "c1", noteId: NOTE }]);
});

test("大纲：Markdown ↔ 导图，关联笔记与备注往返不丢", () => {
  const md = `# 项目\n- 目标 [[note:${NOTE}]]\n  > 第一行\n  > 第二行\n  - 子目标\n- 风险`;
  const d = mindMapFromMarkdown(md, "无关");
  assert.equal(d.root.data.text, "项目");
  assert.equal(d.root.children[0]!.data.hyperlink, `#note:${NOTE}`);
  assert.equal(d.root.children[0]!.data.note, "第一行\n第二行");
  assert.equal(d.root.children[0]!.children[0]!.data.text, "子目标");
  assert.equal(mindMapToOutline(d), md);
});

test("大纲：按大纲改结构时复用原节点，保住 uid 与样式", () => {
  const base = sanitizeMindMap({ layout: "organizationStructure", root: { data: { uid: "r", text: "根" }, children: [
    { data: { uid: "a", text: "甲", fillColor: "#f00" }, children: [{ data: { uid: "a1", text: "甲一" }, children: [] }] },
    { data: { uid: "b", text: "乙" }, children: [] },
  ] } });
  const next = mindMapFromMarkdown("# 根\n- 乙\n- 甲\n  - 甲一\n  - 甲二", "x", { base });
  assert.equal(next.layout, "organizationStructure");
  assert.deepEqual(next.root.children.map(c => c.data.uid).slice(0, 2), ["b", "a"]);
  assert.equal(next.root.children[1]!.data.fillColor, "#f00");
  assert.equal(next.root.children[1]!.children[0]!.data.uid, "a1");
  assert.equal(next.root.children[1]!.children.length, 2);
});

test("解析：标题下挂列表、多个顶层条目时没有根", () => {
  const { root, items } = parseMindMapOutline("## 一\n- a\n  - b\n## 二\n```\n- 代码里的不算\n```");
  assert.equal(root, null);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.children[0]!.children[0]!.text, "b");
  assert.equal(items[1]!.children.length, 0);
});

test("按标题大纲生成：跳级挂到最近上级，根节点关联回笔记", () => {
  const d = mindMapFromOutline("读书笔记", [{ level: 1, text: "第一章" }, { level: 3, text: "细节" }, { level: 2, text: "背景" }, { level: 1, text: "第二章" }], { noteId: NOTE });
  assert.equal(d.root.data.text, "读书笔记");
  assert.equal(d.root.data.hyperlink, `#note:${NOTE}`);
  assert.deepEqual(d.root.children.map(c => c.data.text), ["第一章", "第二章"]);
  assert.deepEqual(d.root.children[0]!.children.map(c => c.data.text), ["细节", "背景"]);
});

test("列表大纲：缩进决定层级，代码块跳过", () => {
  assert.deepEqual(listOutline("- 甲\n  - 乙 **粗**\n```\n- 忽略\n```\n- 丙 [[目标|别名]]"), [{ level: 1, text: "甲" }, { level: 2, text: "乙 粗" }, { level: 1, text: "丙 别名" }]);
});

test("链接工具与备份重映射", () => {
  assert.equal(noteIdFromHref(noteLinkHref(NOTE.toUpperCase())), NOTE);
  assert.equal(noteIdFromHref("#note:xyz"), null);
  const d = mindMapFromMarkdown(`# 根 [[note:${NOTE}]]\n- a [[note:${NOTE2}]]`, "x");
  const r = remapMindMapNotes(d, id => id === NOTE ? NOTE2 : null);
  assert.equal(r.root.data.hyperlink, `#note:${NOTE2}`);
  assert.equal(r.root.children[0]!.data.hyperlink, undefined);
  const e = emptyMindMap(" ");
  assert.equal(e.root.data.text, "中心主题");
});

test("画板：只收 draw.io XML，关联笔记挂整张图，文字可搜", () => {
  assert.throws(() => sanitizeDrawio({ xml: "<script>" }), /draw\.io/);
  const xml = `<mxfile><diagram name="第一页"><mxGraphModel><root><mxCell id="2" value="&lt;b&gt;开始&lt;/b&gt;" /></root></mxGraphModel></diagram></mxfile>`;
  const d = sanitizeDrawio({ xml, noteIds: [NOTE, NOTE, "bad"] });
  assert.deepEqual(d.noteIds, [NOTE]);
  assert.deepEqual(extractBoardNoteLinks("drawio", d), [{ nodeId: "", noteId: NOTE }]);
  assert.match(drawioText(xml), /开始/);
  assert.match(boardPlainText("drawio", d), /第一页/);
  assert.deepEqual((remapBoardNotes("drawio", d, () => NOTE2) as { noteIds: string[] }).noteIds, [NOTE2]);
  const m: MindMapData = mindMapFromMarkdown("# 根\n- 甲\n  > 备注里有关键词", "x");
  assert.match(boardPlainText("mindmap", m), /关键词/);
});
