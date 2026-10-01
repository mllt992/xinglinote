import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { neutralMeta, publicExcerpt, renderPublicMeta } from "./public-meta.ts";
import { mountWeb } from "./static-web.ts";

const template = '<html><head><title>知识库</title><meta name="description" content="old"></head><body><div id="root"></div></body></html>';
test("摘要移除代码、脚本与图片，安全截断 emoji", () => {
  assert.equal(publicExcerpt('# 标题\n<script>secret()</script>\n![private](https://example.test/x)\n[文字](https://example.test)\n```js\ncode\n```\n**正文**'), '标题 文字 正文');
  assert.equal(publicExcerpt('😀😀😀', 2), '😀😀…');
});
test("元数据转义、不重复旧 title、使用可信 origin", () => {
  const html = renderPublicMeta(template, { title: '"><script>alert(1)</script>&', description: '"<b>摘要</b>', allowRobots: false }, 'https://notes.example.test', '/p/token');
  assert.equal((html.match(/<title>/g) ?? []).length, 1);
  assert.equal((html.match(/name="description"/g) ?? []).length, 1);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('https://notes.example.test/brand/share-card.png'));
  assert.ok(html.includes('noindex, nofollow'));
  assert.ok(html.includes('summary_large_image'));
  assert.ok(html.includes('<div id="root">'));
});
test("公开 HTML 每次重验，不响应旧 ETag；失败关闭为中性元数据", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xingli-meta-"));
  try {
    await writeFile(join(dir, "index.html"), template);
    let reads = 0;
    const app = new Hono();
    mountWeb(app, { webDist: dir, publicUrl: 'https://notes.example.test', loadMeta: async () => {
      reads++;
      if (reads > 1) throw new Error('撤销 / 密码门 / 不存在');
      return { title: '公开食谱', description: '今天吃面', allowRobots: false };
    } });
    const first = await app.request('https://untrusted.test/p/token');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(first.headers.get('ETag'), null);
    assert.ok((await first.text()).includes('<title>公开食谱</title>'));
    const next = await app.request('https://untrusted.test/p/token', { headers: { 'If-None-Match': '*' } });
    assert.equal(next.status, 200);
    const html = await next.text();
    assert.ok(!html.includes('公开食谱'));
    assert.ok(html.includes(`<title>${neutralMeta().title}</title>`));
    assert.ok(!html.includes('untrusted.test'));
    const api = await app.request('https://untrusted.test/api/missing');
    assert.equal(api.status, 404);
    const malformed = await app.request('https://untrusted.test/p/%E0%A4%A');
    assert.equal(malformed.status, 404);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("元数据中的美元替换序列保持原文，不插入 HTML 模板", () => {
  const values = ["price $& markup", "prefix $`", "suffix $'", "literal $$", "$1"];
  for (const value of values) {
    const html = renderPublicMeta(template, { title: value, description: value, allowRobots: false }, "https://notes.example.test", "/p/token");
    assert.equal((html.match(/<head>/g) ?? []).length, 1);
    assert.equal((html.match(/<\/head>/g) ?? []).length, 1);
    assert.ok(html.includes(`<title>${value.replaceAll("&", "&amp;").replaceAll("'", "&#39;")}</title>`));
    assert.ok(!html.includes('content="prefix <html>'));
  }
});
