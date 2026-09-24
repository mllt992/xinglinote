import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyMindMap, remapMindMapNotes, listOutline, mindMapFromOutline, extractMindMapNoteLinks, noteIdFromHref, noteLinkHref, sanitizeMindMap, MindMapDataError } from "./mindmap.ts";

const NOTE = "0b8a5c0e-3a57-4d8e-9d1c-2f4f1b7a9c11";

test("清洗：丢掉未知与危险字段，保留白名单", () => {
  const data = sanitizeMindMap({
    direction: 1,
    arrows: [{ id: "a", label: "<img src=x onerror=alert(1)>" }],
    summaries: [{ id: "s", label: "<b>x</b>" }],
    nodeData: {
      id: "root", topic: "中心", dangerouslySetInnerHTML: "<script>1</script>", image: { url: "javascript:1", width: 1, height: 1 },
      style: { color: "#fff", background: "url(http://evil)", fontSize: "16px", position: "fixed" },
      children: [
        { id: "a1", topic: "外链", hyperLink: "javascript:alert(1)" },
        { id: "a2", topic: "笔记", hyperLink: noteLinkHref(NOTE), tags: ["t", { text: "obj" }, 3], icons: ["⭐"] },
        { id: "a3", topic: "网页", hyperLink: "https://example.com/x", expanded: false, direction: 0 },
      ],
    },
  });
  assert.equal(data.direction, 1);
  assert.deepEqual(Object.keys(data), ["nodeData", "direction"]);
  const root = data.nodeData as Record<string, unknown>;
  assert.equal(root.dangerouslySetInnerHTML, undefined);
  assert.equal(root.image, undefined);
  assert.deepEqual(root.style, { color: "#fff", fontSize: "16px" });
  const [a1, a2, a3] = data.nodeData.children!;
  assert.equal(a1!.hyperLink, undefined);
  assert.equal(a2!.hyperLink, `#note:${NOTE}`);
  assert.deepEqual(a2!.metadata, { noteId: NOTE });
  assert.deepEqual(a2!.tags, ["t", "obj"]);
  assert.equal(a3!.hyperLink, "https://example.com/x");
  assert.equal(a3!.expanded, false);
  assert.equal(a3!.direction, 0);
});

test("清洗：结构错误、重复 id、超深都拒绝", () => {
  assert.throws(() => sanitizeMindMap(null), MindMapDataError);
  assert.throws(() => sanitizeMindMap({ nodeData: { topic: "x" } }), MindMapDataError);
  assert.throws(() => sanitizeMindMap({ nodeData: { id: "r", topic: "x", children: [{ id: "r", topic: "y" }] } }), /重复/);
  let deep: Record<string, unknown> = { id: "d0", topic: "x" };
  for (let i = 1; i < 60; i++) deep = { id: `d${i}`, topic: "x", children: [deep] };
  assert.throws(() => sanitizeMindMap({ nodeData: deep }), /层/);
});

test("metadata.noteId 以 hyperLink 为准，伪造的 metadata 被丢弃", () => {
  const data = sanitizeMindMap({ nodeData: { id: "root", topic: "x", metadata: { noteId: NOTE } } });
  assert.equal(data.nodeData.metadata, undefined);
  assert.deepEqual(extractMindMapNoteLinks(data), []);
});

test("提取关联笔记：去重，取第一次出现的节点", () => {
  const data = sanitizeMindMap({ nodeData: { id: "root", topic: "x", children: [
    { id: "a", topic: "1", hyperLink: noteLinkHref(NOTE) },
    { id: "b", topic: "2", children: [{ id: "c", topic: "3", hyperLink: noteLinkHref(NOTE.toUpperCase()) }] },
  ] } });
  assert.deepEqual(extractMindMapNoteLinks(data), [{ nodeId: "a", noteId: NOTE }]);
  assert.equal(noteIdFromHref("#note:nope"), null);
});

test("按标题大纲建树，跳级挂到最近上级", () => {
  const data = mindMapFromOutline("读书笔记", [
    { level: 1, text: "第一章" }, { level: 3, text: "细节" }, { level: 2, text: "小结" }, { level: 1, text: "第二章" }, { level: 2, text: "  " },
  ], { noteId: NOTE });
  assert.equal(data.nodeData.topic, "读书笔记");
  assert.equal(data.nodeData.hyperLink, `#note:${NOTE}`);
  const shape = (n: { topic: string; children?: unknown[] }): unknown => [n.topic, ...((n.children ?? []) as Array<{ topic: string }>).map(shape)];
  assert.deepEqual(shape(data.nodeData), ["读书笔记", ["第一章", ["细节"], ["小结"]], ["第二章"]]);
  // 生成的结果必须能原样通过入库清洗
  assert.deepEqual(sanitizeMindMap(data), data);
});

test("列表大纲：缩进决定层级，跳过代码块，去掉加粗与双链语法", () => {
  const md = ["- **目标**", "  - 提升 [[效率|效率]]", "    1. 自动化", "- 风险", "```", "- 不是列表", "```", "* [ ] 待办项"].join("\n");
  assert.deepEqual(listOutline(md), [
    { level: 1, text: "目标" }, { level: 2, text: "提升 效率" }, { level: 3, text: "自动化" }, { level: 1, text: "风险" }, { level: 1, text: "待办项" },
  ]);
});

test("新导图只有根节点", () => {
  assert.deepEqual(emptyMindMap("  "), { nodeData: { id: "root", topic: "中心主题" }, direction: 2 });
});

test("恢复时换笔记 id：映射不到的去掉链接，外链不动", () => {
  const OTHER = "9d0c7c3e-1111-4a2b-8c3d-000000000001";
  const NEW = "7f000000-2222-4b2b-8c3d-000000000002";
  const out = remapMindMapNotes({ nodeData: { id: "root", topic: "r", hyperLink: noteLinkHref(NOTE), children: [
    { id: "a", topic: "a", hyperLink: noteLinkHref(OTHER) }, { id: "b", topic: "b", hyperLink: "https://example.com/" },
  ] } }, id => id === NOTE ? NEW : null);
  assert.equal(out.nodeData.hyperLink, `#note:${NEW}`);
  assert.deepEqual(out.nodeData.metadata, { noteId: NEW });
  assert.equal(out.nodeData.children![0]!.hyperLink, undefined);
  assert.equal(out.nodeData.children![0]!.metadata, undefined);
  assert.equal(out.nodeData.children![1]!.hyperLink, "https://example.com/");
});
