import { test } from "node:test";
import assert from "node:assert/strict";
import { takeInputFiles } from "./file-input.ts";

/** 模拟 Chromium：清空 value 会原地清掉同一个 FileList。 */
function liveInput(names: string[]) {
  const list: File[] = names.map(n => new File(["# hi"], n, { type: "text/markdown" }));
  return {
    files: list as ArrayLike<File>,
    get value() { return list.length ? `C:\\fakepath\\${list[0]!.name}` : ""; },
    set value(v: string) { if (v === "") list.length = 0; },
  };
}

test("清空 input 之前先把文件拷出来，不会被活 FileList 清成空（#58）", () => {
  const input = liveInput(["a.md", "b.md"]);
  const files = takeInputFiles(input);
  assert.deepEqual(files.map(f => f.name), ["a.md", "b.md"]);
  assert.equal(input.value, "");
  assert.equal(input.files?.length, 0);
});

test("没选文件时返回空数组", () => {
  assert.deepEqual(takeInputFiles({ files: null, value: "" }), []);
});
