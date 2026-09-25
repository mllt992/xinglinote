import assert from "node:assert/strict";
import test from "node:test";
import { extractDrawioXml } from "./drawio-ai.ts";

test("从模型回复里抽出 XML 与说明", () => {
  const r = extractDrawioXml("画了一个流程图。\n```xml\n<mxGraphModel><root><mxCell id=\"0\"/></root></mxGraphModel>\n```");
  assert.equal(r.xml, "<mxGraphModel><root><mxCell id=\"0\"/></root></mxGraphModel>");
  assert.equal(r.reply, "画了一个流程图。");
});

test("只有 root 时补外层；截断或带脚本的拒绝", () => {
  assert.equal(extractDrawioXml("<root><mxCell id=\"0\"/></root>").xml, "<mxGraphModel><root><mxCell id=\"0\"/></root></mxGraphModel>");
  assert.equal(extractDrawioXml("```xml\n<mxGraphModel><root><mxCell id=\"0\"/>").xml, "");
  assert.equal(extractDrawioXml("<mxGraphModel><root><mxCell value=\"<script>\"/></root></mxGraphModel>").xml, "");
  assert.equal(extractDrawioXml("抱歉，我画不了").xml, "");
});
