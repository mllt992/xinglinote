import assert from "node:assert/strict";
import test from "node:test";
import {
  awsEncode,
  buildS3Request,
  joinRemotePath,
  parseBackupStamp,
  parseDavObjects,
  parseS3Objects,
  pickExpired,
  remoteObjectName,
} from "./backup-transfer.ts";

test("路径拼接去掉首尾斜杠和空段", () => {
  assert.equal(joinRemotePath("/knowledge/", "a/b.kbbackup"), "knowledge/a/b.kbbackup");
  assert.equal(joinRemotePath("knowledge", "/x/"), "knowledge/x");
  assert.equal(joinRemotePath("", "file"), "file");
});

test("从完整远端路径抽出对象名", () => {
  assert.equal(remoteObjectName("knowledge/workspace-1.kbbackup", "knowledge"), "workspace-1.kbbackup");
  assert.equal(remoteObjectName("/dav/knowledge/a.kbbackup", "knowledge"), "a.kbbackup");
  assert.equal(remoteObjectName("a.kbbackup", "knowledge"), "a.kbbackup");
});

test("文件名时间戳能还原", () => {
  const at = parseBackupStamp("workspace-abc-2026-04-08T12-30-00-000Z.kbbackup");
  assert.ok(at);
  assert.equal(at.toISOString(), "2026-04-08T12:30:00.000Z");
  assert.equal(parseBackupStamp("readme.txt"), null);
});

test("保留策略：最近 N 天 + 最近 M 周，至少留最新一份", () => {
  const day = (n: number) => new Date(Date.UTC(2026, 0, n, 8));
  const files = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 17, 24, 31].map(n => ({
    name: `p-${String(n).padStart(2, "0")}.kbbackup`,
    at: day(n),
  }));
  const gone = pickExpired(files, 3, 2);
  // 最新是 31 日。daily 留 31/24/17，weekly 再覆盖更早的一周。1–10 应被清掉。
  assert.ok(gone.includes("p-01.kbbackup"));
  assert.ok(gone.includes("p-10.kbbackup"));
  assert.ok(!gone.includes("p-31.kbbackup"));
  assert.ok(!gone.includes("p-24.kbbackup"));
  assert.ok(!gone.includes("p-17.kbbackup"));
});

test("一份都没有时不删", () => {
  assert.deepEqual(pickExpired([], 7, 4), []);
});

test("S3 签名：路径编码、查询串排序、host 进签名", () => {
  const req = buildS3Request(
    { type: "s3", endpoint: "https://s3.example.com", prefix: "knowledge" },
    { accessKey: "AKIA", secretKey: "secret", bucket: "backups", region: "us-east-1" },
    "workspace x.kbbackup",
    "PUT",
    Buffer.from("hi"),
  );
  assert.match(req.url, /https:\/\/s3\.example\.com\/backups\/knowledge\/workspace/);
  assert.match(req.canonical, /^PUT\n\/backups\/knowledge\/workspace%20x\.kbbackup\n\nhost:s3\.example\.com\n/);
  assert.match(req.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIA\//);
  assert.equal(awsEncode("a b"), "a%20b");
});

test("S3 列举走 list-type=2 且查询串进签名", () => {
  const req = buildS3Request(
    { type: "s3", endpoint: "https://s3.example.com", prefix: "knowledge" },
    { accessKey: "AKIA", secretKey: "secret", bucket: "backups", region: "auto" },
    "",
    "GET",
    undefined,
    { "list-type": "2", prefix: "knowledge/" },
    { bucketRoot: true },
  );
  assert.match(req.url, /\/backups\?/);
  assert.match(req.canonical, /^GET\n\/backups\n/);
  assert.match(req.canonical, /list-type=2/);
  assert.match(req.canonical, /prefix=knowledge%2F/);
});

test("S3 与 WebDAV 列举解析远端大小和时间", () => {
  const s3 = parseS3Objects("<ListBucketResult><Contents><Key>knowledge/a.kbbackup</Key><LastModified>2026-08-24T01:02:03.000Z</LastModified><Size>42</Size></Contents></ListBucketResult>", "knowledge");
  assert.equal(s3[0]?.name, "a.kbbackup");
  assert.equal(s3[0]?.bytes, 42);
  assert.equal(s3[0]?.updatedAt?.toISOString(), "2026-08-24T01:02:03.000Z");

  const dav = parseDavObjects("<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/dav/knowledge/a.kbbackup</d:href><d:propstat><d:prop><d:getcontentlength>84</d:getcontentlength><d:getlastmodified>Mon, 24 Aug 2026 01:02:03 GMT</d:getlastmodified></d:prop></d:propstat></d:response></d:multistatus>", "knowledge");
  assert.equal(dav[0]?.name, "a.kbbackup");
  assert.equal(dav[0]?.bytes, 84);
  assert.equal(dav[0]?.updatedAt?.toISOString(), "2026-08-24T01:02:03.000Z");
});
