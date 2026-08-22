/**
 * 导航页验收：公开读、管理员写、权限、图标 404、排序。
 * 需要 pnpm dev 起着，账号 $KB_EMAIL / $KB_PASSWORD。
 *
 *   node scripts/verify-nav.mjs
 */
import { KB_EMAIL, KB_PASSWORD } from "./creds.mjs";

const base = (process.env.KB_BASE_URL ?? "http://127.0.0.1:12098") + "/api/v1";
const results = {};

async function q(path, opt = {}, cookie = "") {
  const r = await fetch(base + path, {
    ...opt,
    headers: { "content-type": "application/json", "x-requested-with": "fetch", ...(cookie ? { cookie } : {}), ...(opt.headers || {}) },
  });
  let body = null;
  try { body = await r.json(); } catch { /* 二进制或空 */ }
  return { status: r.status, body, cookie: r.headers.get("set-cookie")?.split(";")[0] || cookie };
}

const login = await q("/auth/login", { method: "POST", body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) });
if (login.status !== 200) throw new Error(`登录失败（${login.status}）：${login.body?.error?.message ?? ""}`);
const cookie = login.cookie;
const me = (await q("/me", {}, cookie)).body.data;
if (me.instanceRole !== "admin") throw new Error("验收账号必须是实例管理员，才能改导航配置");

const meta = await q("/meta");
results.metaHasNav = meta.body?.data?.navEnabled !== undefined;

const pub = await q("/nav");
results.publicRead = pub.status === 200 && Array.isArray(pub.body?.data?.groups);

const guestIcon = await fetch(base + "/nav/icons/" + "a".repeat(64));
results.unknownIcon404 = guestIcon.status === 404;

const stamp = Date.now();
const created = await q("/admin/nav/groups", { method: "POST", body: JSON.stringify({ title: `验收组${stamp}`, description: "verify-nav" }) }, cookie);
results.createGroup = created.status === 201;
const groupId = created.body?.data?.id;

const link = await q("/admin/nav/links", {
  method: "POST",
  body: JSON.stringify({ groupId, title: "工作区入口", url: "/app", description: "站内路径", fetchIcon: false }),
}, cookie);
results.createInternalLink = link.status === 201 && link.body?.data?.url === "/app" && link.body?.data?.iconUrl === null;
const linkId = link.body?.data?.id;

const badUrl = await q("/admin/nav/links", {
  method: "POST",
  body: JSON.stringify({ groupId, title: "坏的", url: "javascript:alert(1)" }),
}, cookie);
results.rejectJavascript = badUrl.status === 422;

const listed = await q("/admin/nav", {}, cookie);
const group = listed.body?.data?.groups?.find(g => g.id === groupId);
results.adminSeesLink = !!group?.links?.some(l => l.id === linkId);

const publicAfter = await q("/nav");
const pubGroup = publicAfter.body?.data?.groups?.find(g => g.id === groupId);
results.publicSeesLink = !!pubGroup?.links?.some(l => l.id === linkId);

if (linkId) {
  const moved = await q("/admin/nav/reorder", { method: "POST", body: JSON.stringify({ links: [{ id: linkId, sortKey: 99 }] }) }, cookie);
  results.reorder = moved.status === 200;
  const del = await q(`/admin/nav/links/${linkId}`, { method: "DELETE" }, cookie);
  results.deleteLink = del.status === 200;
}
if (groupId) {
  const delG = await q(`/admin/nav/groups/${groupId}`, { method: "DELETE" }, cookie);
  results.deleteGroup = delG.status === 200;
}

const leftover = (await q("/admin/nav", {}, cookie)).body?.data?.groups?.some(g => g.id === groupId);
results.cleaned = leftover === false;

const failed = Object.entries(results).filter(([, v]) => !v);
console.log(results);
if (failed.length) {
  console.error("失败：", failed.map(([k]) => k).join(", "));
  process.exit(1);
}
console.log("verify-nav ok");
