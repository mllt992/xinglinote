import assert from "node:assert/strict";
import test from "node:test";
import { attr, isIconRel, parseIconCandidates, parseNavUrl, sniffNavIcon } from "./nav-icon.ts";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const ico = Buffer.from([0x00, 0x00, 0x01, 0x00, 1, 0, 0, 0]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

test("魔数识别 png / ico / jpeg", () => {
  assert.equal(sniffNavIcon(png), "image/png");
  assert.equal(sniffNavIcon(ico), "image/x-icon");
  assert.equal(sniffNavIcon(jpeg), "image/jpeg");
});

test("SVG 和图太短都丢掉", () => {
  assert.equal(sniffNavIcon(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>")), null);
  assert.equal(sniffNavIcon(Buffer.from("<?xml version='1.0'?><svg/>")), null);
  assert.equal(sniffNavIcon(Buffer.from([1, 2, 3])), null);
});

test("isIconRel 认 shortcut icon 和 apple-touch", () => {
  assert.equal(isIconRel("icon"), true);
  assert.equal(isIconRel("shortcut icon"), true);
  assert.equal(isIconRel("APPLE-TOUCH-ICON"), true);
  assert.equal(isIconRel("stylesheet"), false);
  assert.equal(isIconRel("canonical"), false);
});

test("attr 能读双引号、单引号和裸值", () => {
  assert.equal(attr(`<link rel="icon" href="/a.ico">`, "href"), "/a.ico");
  assert.equal(attr(`<link rel='icon' href='/b.png'>`, "href"), "/b.png");
  assert.equal(attr(`<link rel=icon href=/c.webp>`, "href"), "/c.webp");
});

test("parseIconCandidates 解析相对地址并按尺寸排序", () => {
  const html = `
    <link rel="stylesheet" href="/app.css">
    <link rel="icon" href="/favicon-32.png" sizes="32x32">
    <link rel="apple-touch-icon" href="/apple.png" sizes="180x180">
    <link rel="icon" href="https://cdn.example.com/mark.svg" sizes="any">
    <meta property="og:image" content="/og.jpg">
  `;
  const list = parseIconCandidates(html, "https://notes.example.com/path/");
  assert.deepEqual(list.map(c => c.href), [
    "https://notes.example.com/apple.png",
    "https://cdn.example.com/mark.svg",
    "https://notes.example.com/og.jpg",
    "https://notes.example.com/favicon-32.png",
  ]);
});

test("parseNavUrl 接受站内路径和 http(s)", () => {
  assert.deepEqual(parseNavUrl("/w/abc"), { href: "/w/abc", kind: "internal" });
  assert.equal(parseNavUrl("https://github.com/x").kind, "external");
  assert.equal(parseNavUrl("https://github.com/x").href, "https://github.com/x");
});

test("parseNavUrl 拒绝 javascript、双斜杠和空串", () => {
  assert.throws(() => parseNavUrl("javascript:alert(1)"), /http/);
  assert.throws(() => parseNavUrl("//evil.test"), /http|路径/);
  assert.throws(() => parseNavUrl(""), /填写/);
  assert.throws(() => parseNavUrl("ftp://x"), /http/);
});
