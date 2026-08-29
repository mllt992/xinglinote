import assert from "node:assert/strict";
import test from "node:test";
import { mcpToolErrorResult, versionConflict } from "./mcp-errors.ts";

test("版本冲突同时暴露期望版本和数据库当前版本", () => {
  const error = versionConflict(33, 35);
  assert.match(error.message, /expected_version=33/);
  assert.match(error.message, /current_version=35/);
  assert.deepEqual(error.fields, {
    version: "35",
    expected_version: "33",
    current_version: "35",
  });
});

test("HTTP 409 还可带对方是谁和当前正文，给编辑器横幅用", () => {
  const error = versionConflict(11, 12, { updatedBy: "星璃", title: "手册", bodyMd: "服务端正文" });
  assert.equal(error.fields?.updatedBy, "星璃");
  assert.equal(error.fields?.title, "手册");
  assert.equal(error.fields?.bodyMd, "服务端正文");
});

test("工具业务错误用 isError 结果把结构化信息交给 Agent", () => {
  const data = {
    code: "CONFLICT_VERSION",
    message: "版本冲突：expected_version=33，current_version=35",
    expected_version: "33",
    current_version: "35",
  };
  const result = mcpToolErrorResult(data);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, data);
  assert.deepEqual(JSON.parse(result.content[0].text), data);
});
