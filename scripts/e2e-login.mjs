import { KB_EMAIL, KB_PASSWORD } from './creds.mjs';
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-background-networking"],
});
const page = await browser.newPage();
const log = [];
page.on("console", (msg) => log.push(`console:${msg.type()}:${msg.text()}`));
page.on("pageerror", (err) => log.push(`pageerror:${err.message}`));
page.on("requestfailed", (req) => log.push(`failed:${req.url()}:${req.failure()?.errorText}`));

try {
  await page.goto("http://127.0.0.1:12098/login", { waitUntil: "domcontentloaded", timeout: 10000 });
  await page.getByRole("heading", { name: "登录" }).waitFor({ timeout: 10000 });
  await page.getByLabel("邮箱").fill(KB_EMAIL);
  await page.getByLabel("密码").fill(KB_PASSWORD);
  await Promise.all([
    page.waitForURL(/\/w\//, { timeout: 10000 }),
    page.getByRole("button", { name: "进入" }).click(),
  ]);
  const url = page.url();
  const title = await page.locator(".logo").textContent();
  const notebooks = await page.locator(".nbs").textContent();
  console.log(JSON.stringify({ ok: true, url, title, notebooks, log }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, url: page.url(), error: error.message, body: await page.locator("body").innerText(), log }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
