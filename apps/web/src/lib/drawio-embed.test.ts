import assert from "node:assert/strict";
import { test } from "node:test";
import { drawioFrameUrl } from "./drawio-embed.ts";

test("画板使用无固定滚动边界的官方参数，保留现有通信和编辑能力", () => {
  const url = new URL(drawioFrameUrl("https://embed.diagrams.net", true, false));
  assert.equal(url.origin, "https://embed.diagrams.net");
  for (const [key, value] of Object.entries({ embed: "1", proto: "json", sb: "0", libraries: "1", noSaveBtn: "1", noExitBtn: "1", saveAndExit: "0", dark: "0" })) assert.equal(url.searchParams.get(key), value);
  assert.equal(url.searchParams.has("chrome"), false);
});

test("自托管、只读和深色模式仍沿用原设置", () => {
  const url = new URL(drawioFrameUrl("https://draw.example.invalid/editor", false, true));
  assert.equal(url.origin, "https://draw.example.invalid");
  assert.equal(url.pathname, "/editor/");
  assert.equal(url.searchParams.get("chrome"), "0");
  assert.equal(url.searchParams.get("dark"), "1");
  assert.equal(url.searchParams.get("sb"), "0");
});
