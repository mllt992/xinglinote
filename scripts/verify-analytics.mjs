// 显式临时测试库 + 生产构建的统计验收：真实汇总、筛选/历史、暗色/360px 和中断状态。
// KB_TEST_DATABASE_URL=postgres://.../xxx_test DATABASE_URL=同值 node --import ./apps/api/node_modules/tsx/dist/loader.mjs scripts/verify-analytics.mjs
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';
import { db, sql } from '../apps/api/src/db/client.ts';
import { users, workspaces, workspaceMembers, notebooks, notes, noteVersions, sessions } from '../apps/api/src/db/schema.ts';
import { hashSecret } from '../apps/api/src/lib/tokens.ts';

const { eq, inArray } = createRequire(new URL('../apps/api/package.json', import.meta.url))('drizzle-orm');

assert.equal(process.env.DATABASE_URL, process.env.KB_TEST_DATABASE_URL);
assert.ok(process.env.KB_TEST_DATABASE_URL && new URL(process.env.KB_TEST_DATABASE_URL).pathname.endsWith('_test'));
const ids = { user: randomUUID(), other: randomUUID(), ws: randomUUID(), ws2: randomUUID(), research: randomUUID(), reading: randomUUID(), empty: randomUUID(), hidden: randomUUID() };
const suffix = randomUUID().slice(0, 8), token = randomBytes(32).toString('base64url');
const base = 'http://127.0.0.1:12152';
let server, browser;
try {
  await db.insert(users).values([ids.user, ids.other].map((id, i) => ({ id, email: `analytics-ui-${id}@example.invalid`, handle: `at${id.replaceAll('-', '').slice(0, 20)}`, displayName: `统计验收${i}`, passwordHash: 'not-a-login' })));
  await db.insert(workspaces).values([{ id: ids.ws, slug: `analytics-ui-${suffix}`, name: '知识生长实验室', kind: 'normal', ownerId: ids.user }, { id: ids.ws2, slug: `analytics-empty-${suffix}`, name: '空工作区', kind: 'normal', ownerId: ids.user }]);
  await db.insert(workspaceMembers).values([ids.ws, ids.ws2].map(workspaceId => ({ workspaceId, userId: ids.user, role: 'owner' })));
  await db.insert(notebooks).values([
    { id: ids.research, title: '研究与灵感', slug: 'research', createdBy: ids.user },
    { id: ids.reading, title: '阅读与摘录', slug: 'reading', createdBy: ids.user },
    { id: ids.empty, title: '等待第一篇', slug: 'empty', createdBy: ids.user },
    { id: ids.hidden, title: '不可泄漏的私密本', slug: 'hidden', createdBy: ids.other, visibility: 'private' },
  ].map(row => ({ workspaceId: ids.ws, ...row })));
  const now = new Date(), start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const noteRows = Array.from({ length: 42 }, (_, i) => ({
    id: randomUUID(), workspaceId: ids.ws, notebookId: i % 3 === 0 ? ids.reading : ids.research,
    title: `知识片段 ${i + 1}`, bodyMd: '每一次记录都让想法更清晰。'.repeat(12 + i), tags: i % 2 ? ['研究', '灵感'] : ['阅读'],
    createdBy: ids.user, updatedBy: ids.user, createdAt: new Date(start - (i % 30) * 86400000 + 3600000),
  }));
  await db.insert(notes).values([...noteRows, { id: randomUUID(), workspaceId: ids.ws, notebookId: ids.hidden, title: '秘密笔记', bodyMd: '绝密', createdBy: ids.other, updatedBy: ids.other }]);
  await db.insert(noteVersions).values(noteRows.flatMap((n, i) => Array.from({ length: i % 4 + 1 }, (_, v) => ({ noteId: n.id, version: v + 1, title: n.title, bodyMd: n.bodyMd, editorId: ids.user, source: 'edit', createdAt: new Date(n.createdAt.getTime() + v * 3600000) }))));
  await db.insert(sessions).values({ userId: ids.user, tokenHash: hashSecret(token), expiresAt: new Date(Date.now() + 3600000) });
  server = spawn(process.execPath, ['--import', './apps/api/node_modules/tsx/dist/loader.mjs', 'apps/api/src/index.ts'], { env: { ...process.env, PUBLIC_URL: base, API_PORT: '12152' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverError = ''; server.stderr.on('data', chunk => { serverError += chunk; }); server.stdout.resume();
  let started = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/healthz')).ok) { started = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(started, serverError);
  browser = await chromium.launch({ executablePath: process.env.KB_CHROMIUM_EXECUTABLE, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'kb_session', value: token, url: base }]);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const endpoint = '**/api/v1/workspaces/*/analytics*';
  const url = `${base}/w/${ids.ws}/analytics`;
  const ready = async () => {
    await page.getByRole('button', { name: '刷新统计', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('button[aria-label="刷新统计"]')?.disabled === false);
  };
  // 首屏骨架确实可见，真实请求放行后被数据取代。
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(endpoint, async route => { await gate; await route.continue(); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.getByRole('status', { name: '正在加载统计' }).waitFor();
  release(); await ready(); await page.unroute(endpoint);
  await page.getByRole('heading', { name: '记录的节奏', exact: true }).waitFor();
  assert.equal(await page.getByLabel('笔记本', { exact: true }).locator('option').count(), 4, '不可见笔记本不能出现在选择器');
  assert.ok(!(await page.locator('[data-testid="analytics-page"]').innerText()).includes('不可泄漏'));
  await page.getByText('查看每日数据', { exact: true }).click();
  assert.equal(await page.locator('table tbody tr').count(), 30);
  await page.getByLabel('笔记本对比指标', { exact: true }).selectOption('characters');
  await page.getByLabel('笔记本对比指标', { exact: true }).selectOption('edited');
  await page.getByLabel('笔记本对比指标', { exact: true }).selectOption('notes');
  await page.screenshot({ path: '/tmp/xingli-analytics-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '近 7 天', exact: true }).click(); await ready();
  assert.equal(new URL(page.url()).searchParams.get('days'), '7');
  await page.getByText('查看每日数据', { exact: true }).click();
  assert.equal(await page.locator('table tbody tr').count(), 7);
  await page.getByRole('button', { name: /^查看 研究与灵感 的统计/ }).click(); await ready();
  assert.equal(new URL(page.url()).searchParams.get('notebookId'), ids.research);
  await page.getByRole('heading', { name: '研究与灵感', exact: true }).waitFor();
  await page.goBack(); await ready();
  assert.equal(new URL(page.url()).searchParams.get('notebookId'), null);
  await page.getByRole('heading', { name: '全部可读笔记本', exact: true }).waitFor();
  // 故意延迟一个已过期的下钻请求，再快速选择下一本。
  await page.route(endpoint, async route => {
    if (new URL(route.request().url()).searchParams.get('notebookId') === ids.research) await new Promise(resolve => setTimeout(resolve, 500));
    try { await route.continue(); } catch { /* 已被 AbortController 取消 */ }
  });
  await page.getByLabel('笔记本', { exact: true }).selectOption(ids.research);
  await page.getByLabel('笔记本', { exact: true }).selectOption(ids.reading);
  await ready(); await page.waitForTimeout(600);
  await page.getByRole('heading', { name: '阅读与摘录', exact: true }).waitFor();
  await page.unroute(endpoint);
  await page.getByLabel('笔记本', { exact: true }).selectOption(ids.empty); await ready();
  await page.getByRole('heading', { name: '这片知识库还很安静', exact: true }).waitFor();
  // 错误必须清除旧统计，且可重试恢复。
  await page.route(endpoint, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: '统计暂时不可用' } }) }));
  await page.getByRole('button', { name: '刷新统计', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '统计暂时不可用' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '记录的节奏', exact: true }).count(), 0);
  await page.unroute(endpoint);
  await page.getByRole('button', { name: '重试', exact: true }).click(); await ready();
  // 无权深链不暴露名称，并有返回整体统计的恢复入口。
  await page.goto(`${url}?notebookId=${ids.hidden}`); await ready();
  await page.getByRole('alert').filter({ hasText: '没有读取权限' }).waitFor();
  assert.ok(!(await page.locator('[data-testid="analytics-page"]').innerText()).includes('不可泄漏'));
  await page.getByRole('button', { name: '返回工作区统计', exact: true }).click(); await ready();
  // 工作区切换不能闪现旧统计。
  await page.goto(`${base}/w/${ids.ws2}/analytics`); await ready();
  await page.getByRole('heading', { name: '还没有可读的笔记本', exact: true }).waitFor();
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(url); await ready();
  await page.waitForFunction(() => document.documentElement.dataset.mode === 'dark');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '360px 横向溢出');
  const runningAnimations = await page.locator('[data-testid="analytics-page"]').evaluate(el => [...el.querySelectorAll('*')].filter(node => getComputedStyle(node).animationName !== 'none').length);
  assert.equal(runningAnimations, 0, 'reduced-motion 下仍有统计动画');
  await page.screenshot({ path: '/tmp/xingli-analytics-dark-360.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ liveCharts: true, notebookAcl: true, notebookDrilldown: true, sevenAndThirtyDays: true, backNavigation: true, staleRequestsIgnored: true, loadingErrorEmpty: true, dark360: true, reducedMotion: true }, null, 2));
} finally {
  await browser?.close();
  if (server && server.exitCode === null) { const exit = once(server, 'exit'); server.kill('SIGTERM'); await exit; }
  const workspaceIds = [ids.ws, ids.ws2];
  await db.delete(sessions).where(eq(sessions.userId, ids.user));
  await db.delete(noteVersions).where(inArray(noteVersions.noteId, db.select({ id: notes.id }).from(notes).where(inArray(notes.workspaceId, workspaceIds))));
  await db.delete(notes).where(inArray(notes.workspaceId, workspaceIds));
  await db.delete(notebooks).where(inArray(notebooks.workspaceId, workspaceIds));
  await db.delete(workspaceMembers).where(inArray(workspaceMembers.workspaceId, workspaceIds));
  await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
  await db.delete(users).where(inArray(users.id, [ids.user, ids.other]));
  await sql.end();
}
