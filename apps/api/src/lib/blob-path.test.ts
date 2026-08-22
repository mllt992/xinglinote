import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { blobRelPath, hashBytes, isBlobPath, resolveStoredRel, storedFilePath } from "./blob-path.ts";

test("sha256 是 64 位小写 hex，相同内容相同摘要", () => {
  const a = hashBytes(Buffer.from("hello"));
  const b = hashBytes(Buffer.from("hello"));
  const c = hashBytes(Buffer.from("world"));
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("blob 路径按哈希前两位分桶", () => {
  const sha = "ab".repeat(32);
  assert.equal(blobRelPath(sha), `blobs/ab/${sha}`);
});

test("识别新路径，兼容反斜杠", () => {
  assert.equal(isBlobPath("blobs/ab/abcd"), true);
  assert.equal(isBlobPath("blobs\\ab\\abcd"), true);
  assert.equal(isBlobPath("uuid-photo.png"), false);
  assert.equal(isBlobPath("attachments/ws/file.png"), false);
});

test("新附件走 blobs，老附件/动态附件仍按原目录解析", () => {
  const sha = "cd".repeat(32);
  const blob = blobRelPath(sha);
  assert.equal(resolveStoredRel({ storedName: blob, workspaceId: "ws1" }), blob);
  assert.equal(resolveStoredRel({ storedName: "uuid-a.png", workspaceId: "ws1" }), "attachments/ws1/uuid-a.png");
  assert.equal(resolveStoredRel({ storedName: "uuid-b.png", postAssetId: "p1" }), "feed/p1/uuid-b.png");
});

test("拼盘路径时 dataDir 在前", () => {
  assert.equal(storedFilePath("/data", { storedName: "blobs/aa/aa", workspaceId: "ws" }), join("/data", "blobs/aa/aa"));
  assert.equal(storedFilePath("/data", { storedName: "old.png", workspaceId: "ws" }), join("/data", "attachments", "ws", "old.png"));
});
