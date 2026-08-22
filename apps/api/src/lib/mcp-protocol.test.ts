import assert from "node:assert/strict";
import test from "node:test";
import { likeContains } from "./like.ts";
import { decodeImageData } from "./image-data.ts";
import { isWriteTool, toolAllowed, toolsFor } from "./mcp-protocol.ts";

test("只读钥匙看不到写工具，看得到搜索和今天", () => {
  const names = toolsFor({ rw: "read", allowDelete: false, feedPublic: false, feedWorkspace: false }).map(t => t.name);
  assert.ok(names.includes("search_notes"));
  assert.ok(names.includes("today"));
  assert.ok(names.includes("list_recent"));
  assert.equal(names.includes("create_note"), false);
  assert.equal(names.includes("replace_in_note"), false);
  assert.equal(names.includes("trash_note"), false);
  assert.equal(names.includes("post_to_feed"), false);
});

test("读写钥匙有 create / replace，没有 trash 和 move", () => {
  const names = toolsFor({ rw: "write", allowDelete: false, feedPublic: false, feedWorkspace: false }).map(t => t.name);
  assert.ok(names.includes("create_note"));
  assert.ok(names.includes("replace_in_note"));
  assert.ok(names.includes("upload_image"));
  assert.equal(names.includes("trash_note"), false);
  assert.equal(names.includes("move_note"), false);
});

test("管理+删除+动态才挂 trash 和 post_to_feed", () => {
  const names = toolsFor({ rw: "manage", allowDelete: true, feedPublic: true, feedWorkspace: false }).map(t => t.name);
  assert.ok(names.includes("trash_note"));
  assert.ok(names.includes("move_note"));
  assert.ok(names.includes("post_to_feed"));
  assert.ok(toolsFor({ rw: "manage", allowDelete: false, feedPublic: false, feedWorkspace: false }).every(t => t.name !== "trash_note"));
});

test("get_note 带翻页参数，search_notes 默认 8 条", () => {
  const tools = toolsFor({ rw: "read", allowDelete: false, feedPublic: false, feedWorkspace: false });
  const get = tools.find(t => t.name === "get_note");
  const search = tools.find(t => t.name === "search_notes");
  assert.ok(get?.inputSchema.properties && "offset" in get.inputSchema.properties);
  assert.ok(get?.inputSchema.properties && "max_chars" in get.inputSchema.properties);
  const limit = (search?.inputSchema.properties as { limit?: { default?: number } } | undefined)?.limit;
  assert.equal(limit?.default, 8);
});

test("每个列出的工具都带注解", () => {
  for (const t of toolsFor({ rw: "manage", allowDelete: true, feedPublic: true, feedWorkspace: true })) {
    assert.equal(typeof t.annotations.readOnlyHint, "boolean");
    assert.ok(t.inputSchema.type === "object");
  }
  assert.equal(isWriteTool("get_note"), false);
  assert.equal(isWriteTool("create_note"), true);
  assert.equal(toolAllowed({ rw: "read", allowDelete: false, feedPublic: false, feedWorkspace: false }, "create_note"), false);
});

test("ILIKE 通配符按字面量转义", () => {
  assert.equal(likeContains("100%_off\\x"), "%100\\%\\_off\\\\x%");
});

test("只读钥匙没有 upload_image，读写才有；list_attachments 只读也有", () => {
  const read = toolsFor({ rw: "read", allowDelete: false, feedPublic: false, feedWorkspace: false }).map(t => t.name);
  const write = toolsFor({ rw: "write", allowDelete: false, feedPublic: false, feedWorkspace: false }).map(t => t.name);
  assert.ok(read.includes("list_attachments"));
  assert.equal(read.includes("upload_image"), false);
  assert.ok(write.includes("upload_image"));
});

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("decodeImageData 认裸 base64 和 data URL", () => {
  const a = decodeImageData(TINY_PNG);
  const b = decodeImageData(`data:image/png;base64,${TINY_PNG}`);
  assert.equal(a[0], 0x89);
  assert.deepEqual(a, b);
});

test("decodeImageData 拒空串", () => {
  assert.throws(() => decodeImageData("   "), /空/);
});
