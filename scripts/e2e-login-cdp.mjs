import { KB_EMAIL, KB_PASSWORD } from './creds.mjs';
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();
const log = [];
page.on("console", (msg) => log.push(`console:${msg.type()}:${msg.text()}`));
page.on("pageerror", (err) => log.push(`pageerror:${err.message}`));
page.on("requestfailed", (req) => log.push(`failed:${req.url()}:${req.failure()?.errorText}`));
try {
  await page.goto("http://127.0.0.1:12098/login", { waitUntil: "domcontentloaded", timeout: 10000 });
  await page.getByRole("heading", { name: "登录" }).waitFor({ timeout: 10000 });
  await page.getByLabel("邮箱").fill(KB_EMAIL);
  await page.getByLabel("密码").fill(KB_PASSWORD);
  await page.getByRole("button", { name: "进入" }).click();
  await page.waitForURL(/\/w\//, { timeout: 10000 });
  await page.locator(".logo").waitFor({ timeout: 10000 });
  console.log(JSON.stringify({ ok: true, url: page.url(), logo: await page.locator(".logo").innerText(), notebooks: await page.locator(".nbs").innerText(), log }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, url: page.url(), error: error.message, body: await page.locator("body").innerText(), log }, null, 2));
  process.exitCode = 1;
} finally {
  await page.close();
  await browser.close();
}
