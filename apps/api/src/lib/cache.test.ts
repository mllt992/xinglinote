import assert from "node:assert/strict";
import test from "node:test";
import { cacheGet, cacheSet, embedCacheKey, encodeResp, parseRedisUrl, parseResp, redisAuthArgs, resetMemoryCache } from "./cache.ts";
import { NOTE_SLICE_DEFAULT, sliceNoteBody } from "./note-slice.ts";

test("embedCacheKey 同一文本同一模型稳定，换模型就变", () => {
  const a = embedCacheKey("http://x", "m1", "你好");
  const b = embedCacheKey("http://x", "m1", "你好");
  const c = embedCacheKey("http://x", "m2", "你好");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^kb:emb:v1:[0-9a-f]{64}$/);
});

test("进程内缓存读写与过期", async () => {
  resetMemoryCache();
  await cacheSet("kb:t:1", "hello", 60);
  assert.equal(await cacheGet("kb:t:1"), "hello");
  resetMemoryCache();
  assert.equal(await cacheGet("kb:t:1"), undefined);
});

test("REDIS_URL 认 requirepass、ACL 用户、百分号编码和引号", () => {
  const simple = parseRedisUrl("redis://:s3cret@10.0.0.8:6380/2");
  assert.deepEqual(simple, { host: "10.0.0.8", port: 6380, username: "", password: "s3cret", db: 2 });
  assert.deepEqual(redisAuthArgs(simple!), ["AUTH", "s3cret"]);

  const acl = parseRedisUrl("redis://cache:p%40ss%3Aword@redis.internal:6379");
  assert.equal(acl?.username, "cache");
  assert.equal(acl?.password, "p@ss:word");
  assert.deepEqual(redisAuthArgs(acl!), ["AUTH", "cache", "p@ss:word"]);

  const quoted = parseRedisUrl("\"redis://127.0.0.1:6379\"");
  assert.equal(quoted?.host, "127.0.0.1");
  assert.equal(quoted?.password, "");
  assert.equal(redisAuthArgs(quoted!), null);
  assert.equal(parseRedisUrl("rediss://x"), null);
});

test("encode / parse RESP bulk 与 null", () => {
  const buf = encodeResp(["GET", "kb:emb:v1:abc"]);
  assert.match(buf.toString("utf8"), /^\*2\r\n\$3\r\nGET\r\n/);
  const hello = Buffer.from("$5\r\nhello\r\n");
  const parsed = parseResp(hello);
  assert.equal(parsed?.value, "hello");
  assert.equal(parsed?.rest.length, 0);
  const nil = parseResp(Buffer.from("$-1\r\n"));
  assert.equal(nil?.value, null);
  assert.equal(parseResp(Buffer.from("$5\r\nhel")), null);
});

test("sliceNoteBody 默认窗口并标 truncated", () => {
  const body = "前".repeat(200) + "中".repeat(40) + "后".repeat(200);
  const first = sliceNoteBody(body, 0, 220);
  assert.equal(first.body_md.length, 220);
  assert.equal(first.truncated, true);
  assert.equal(first.total_chars, body.length);
  const next = sliceNoteBody(body, first.offset + first.body_md.length, 220);
  assert.equal(next.offset, 220);
  assert.ok(next.body_md.length > 0);
  const all = sliceNoteBody(body, 0, NOTE_SLICE_DEFAULT);
  assert.equal(all.truncated, false);
  assert.equal(all.body_md, body);
});
