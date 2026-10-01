import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, sql } from "../db/client.ts";
import { users, workspaces, notebooks, notes, shareLinks } from "../db/schema.ts";
import { mountWeb } from "./static-web.ts";

// 只对显式指定的临时测试数据库执行；正常单测不要求数据库。
test("真实数据库：公开 HTML 的分享范围、密码、删除、撤销与站点发布边界", { skip: !process.env.KB_TEST_DATABASE_URL }, async () => {
  assert.equal(process.env.DATABASE_URL, process.env.KB_TEST_DATABASE_URL);
  assert.ok(new URL(process.env.KB_TEST_DATABASE_URL!).pathname.endsWith('_test'));
  const suffix = randomUUID();
  const dir = await mkdtemp(join(tmpdir(), 'xingli-meta-integration-'));
  const ids = { user: randomUUID(), ws: randomUUID(), nb: randomUUID(), note: randomUUID(), secret: randomUUID() };
  try {
    await writeFile(join(dir, 'index.html'), '<html><head><title>知识库</title></head><body><div id="root"></div></body></html>');
    await db.insert(users).values({ id: ids.user, email: `${suffix}@example.invalid`, handle: `t${suffix.replaceAll('-', '').slice(0, 20)}`, displayName: '验收', passwordHash: 'not-a-login' });
    await db.insert(workspaces).values({ id: ids.ws, slug: `test-${suffix}`, name: '验收工作区', ownerId: ids.user, kind: "normal" });
    await db.insert(notebooks).values({ id: ids.nb, workspaceId: ids.ws, slug: 'public', title: '公开食谱', createdBy: ids.user, sitePublished: true });
    await db.insert(notes).values([
      { id: ids.note, workspaceId: ids.ws, notebookId: ids.nb, title: '面条 <script>bad</script>', bodyMd: '# 公开\n公开配方\n# 隐藏章节\n另一节正文', createdBy: ids.user, updatedBy: ids.user, published: true },
      { id: ids.secret, workspaceId: ids.ws, notebookId: ids.nb, title: '不应泄漏的标题', bodyMd: '私密正文', createdBy: ids.user, updatedBy: ids.user, published: false },
    ]);
    const token = suffix.replaceAll('-', '');
    await db.insert(shareLinks).values({ token, workspaceId: ids.ws, targetType: 'heading', targetId: ids.note, headingAnchor: '公开', createdBy: ids.user });
    const app = new Hono();
    mountWeb(app, { webDist: dir, publicUrl: 'https://notes.example.test' });
    const get = async (path: string) => (await app.request(`https://fake-host.invalid${path}`)).text();
    let html = await get(`/p/${token}`);
    assert.ok(html.includes('面条 &lt;script&gt;bad&lt;/script&gt;'));
    assert.ok(html.includes('公开配方'));
    assert.ok(!html.includes('另一节正文'));
    assert.ok(!html.includes('不应泄漏的标题'));
    await db.update(shareLinks).set({ passwordHash: 'locked' }).where(eq(shareLinks.token, token));
    html = await get(`/p/${token}`);
    assert.ok(html.includes('<title>星璃笔记</title>'));
    assert.ok(!html.includes('面条'));
    await db.update(shareLinks).set({ passwordHash: null, status: 'revoked' }).where(eq(shareLinks.token, token));
    assert.ok(!(await get(`/p/${token}`)).includes('面条'));
    await db.update(shareLinks).set({ status: 'active', expiresAt: new Date(0) }).where(eq(shareLinks.token, token));
    assert.ok(!(await get(`/p/${token}`)).includes('面条'));
    await db.update(shareLinks).set({ expiresAt: null }).where(eq(shareLinks.token, token));
    await db.update(notes).set({ trashedAt: new Date() }).where(eq(notes.id, ids.note));
    assert.ok(!(await get(`/p/${token}`)).includes('面条'));
    await db.update(notes).set({ trashedAt: null }).where(eq(notes.id, ids.note));
    assert.ok((await get(`/p/${token}`)).includes('面条'));
    const site = `/s/test-${suffix}/public`;
    assert.ok((await get(site)).includes('<title>公开食谱</title>'));
    assert.ok((await get(`${site}/${ids.note}`)).includes('公开配方'));
    assert.ok(!(await get(`${site}/${ids.secret}`)).includes('不应泄漏'));
    await db.update(notes).set({ moderationStatus: 'pending_review' }).where(eq(notes.id, ids.note));
    assert.ok(!(await get(`${site}/${ids.note}`)).includes('面条'));
    await db.update(notebooks).set({ sitePublished: false }).where(eq(notebooks.id, ids.nb));
    assert.ok(!(await get(site)).includes('公开食谱'));
  } finally {
    await db.delete(shareLinks).where(eq(shareLinks.workspaceId, ids.ws));
    await db.delete(notes).where(eq(notes.workspaceId, ids.ws));
    await db.delete(notebooks).where(eq(notebooks.workspaceId, ids.ws));
    await db.delete(workspaces).where(eq(workspaces.id, ids.ws));
    await db.delete(users).where(eq(users.id, ids.user));
    await rm(dir, { recursive: true, force: true });
    await sql.end();
  }
});
