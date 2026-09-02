import assert from "node:assert/strict";
import test from "node:test";
import { nextNoteSavedAt } from "./note-save.ts";

test("相同内容保存时，最后保存时间至少向后推进 1ms", () => {
  const previous = new Date("2026-09-02T00:00:00.000Z");

  assert.equal(
    nextNoteSavedAt(previous, new Date("2026-09-02T00:00:00.000Z")).toISOString(),
    "2026-09-02T00:00:00.001Z",
  );
});

test("相同内容保存时优先采用更晚的当前时间", () => {
  const previous = new Date("2026-09-02T00:00:00.000Z");
  const now = new Date("2026-09-02T00:00:10.000Z");

  assert.equal(nextNoteSavedAt(previous, now).getTime(), now.getTime());
});
