import assert from "node:assert/strict";
import test from "node:test";
import { assertAttachmentType } from "./file-type.ts";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const pdf = Buffer.from("%PDF-1.7\n%aaa", "latin1");
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

test("魔数和声明对得上就放行", () => {
  assert.equal(assertAttachmentType("image/png", png), "image/png");
  assert.equal(assertAttachmentType("image/jpeg", jpeg), "image/jpeg");
  assert.equal(assertAttachmentType("application/pdf", pdf), "application/pdf");
  assert.equal(assertAttachmentType("application/zip", zip), "application/zip");
});

test("声明成 png 的 HTML 会被拦下来", () => {
  const html = Buffer.from("<html><script>alert(1)</script></html>", "utf8");
  assert.throws(() => assertAttachmentType("image/png", html), /不符/);
});

test("声明成 png 的 jpeg 也算不符", () => {
  assert.throws(() => assertAttachmentType("image/png", jpeg), /不符/);
});

test("白名单之外的类型直接拒绝", () => {
  assert.throws(() => assertAttachmentType("image/svg+xml", Buffer.from("<svg/>")), /不支持/);
  assert.throws(() => assertAttachmentType("text/html", Buffer.from("hi")), /不支持/);
});

test("文本附件里不能藏 HTML / SVG", () => {
  assert.throws(() => assertAttachmentType("text/plain", Buffer.from("<svg onload=alert(1)>")), /HTML/);
  assert.throws(() => assertAttachmentType("text/markdown", Buffer.from("<!DOCTYPE html><html>")), /HTML/);
  assert.throws(() => assertAttachmentType("text/plain", pdf), /实际是/);
});

test("正常文本照常通过", () => {
  assert.equal(assertAttachmentType("text/markdown", Buffer.from("# 标题\n\n正文 <b> 也没关系", "utf8")), "text/markdown");
});
