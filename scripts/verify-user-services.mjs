// 用户存储配额与服务申请：用量、申请、审批、直接分配、恢复默认。
// 用法：KB_EMAIL=... KB_PASSWORD=... node scripts/verify-user-services.mjs
import { KB_EMAIL as email, KB_PASSWORD as password } from "./creds.mjs";

const base = (process.env.KB_BASE_URL ?? "http://127.0.0.1:12098") + "/api/v1";

async function q(path, opt = {}, cookie = "") {
  const r = await fetch(base + path, {
    ...opt,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(opt.headers || {}) },
  });
  const j = await r.json();
  if (!r.ok || !j.ok) {
    const e = new Error(j.error?.message ?? r.status);
    e.code = j.error?.code;
    e.status = r.status;
    throw e;
  }
  return { data: j.data, cookie: r.headers.get("set-cookie")?.split(";")[0] || cookie };
}

const GB = 1073741824;
const login = await q("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
const c = login.cookie;
const me = (await q("/me", {}, c)).data;
const result = {};

try {
  const storage = (await q("/me/storage", {}, c)).data;
  result.meStorageShape = typeof storage.usedBytes === "number" && typeof storage.quotaBytes === "number"
    && typeof storage.noteBytes === "number" && typeof storage.canRequest === "boolean";
  result.meIncludesStorage = typeof me.storage?.quotaBytes === "number";

  const users = (await q("/admin/users?pageSize=20", {}, c)).data;
  result.adminListHasStorage = Array.isArray(users.users) && users.users.every(u => u.storage && typeof u.storage.quotaBytes === "number");
  const self = users.users.find(u => u.id === me.id);
  result.selfOnList = !!self;

  const detail = (await q(`/admin/users/${me.id}`, {}, c)).data;
  result.adminDetail = detail.user?.id === me.id && Array.isArray(detail.requests);

  // 清掉自己可能残留的 pending，避免验收互相踩
  for (const r of (await q("/me/service-requests", {}, c)).data.requests.filter(x => x.status === "pending")) {
    await q(`/me/service-requests/${r.id}`, { method: "DELETE" }, c);
  }

  const want = Math.max(storage.quotaBytes * 2, 2 * GB);
  const created = (await q("/me/service-requests", {
    method: "POST",
    body: JSON.stringify({ kind: "storage", requestedBytes: want, reason: "验收脚本申请扩容" }),
  }, c)).data;
  result.submitPending = created.status === "pending" && created.requestedBytes === want;

  let dup = false;
  try {
    await q("/me/service-requests", { method: "POST", body: JSON.stringify({ kind: "storage", requestedBytes: want + GB }) }, c);
  } catch (e) { dup = e.code === "VALIDATION"; }
  result.rejectDuplicatePending = dup;

  await q(`/me/service-requests/${created.id}`, { method: "DELETE" }, c);
  result.cancelPending = (await q("/me/service-requests", {}, c)).data.requests.find(x => x.id === created.id)?.status === "cancelled";

  let smallDenied = false;
  try { await q("/me/service-requests", { method: "POST", body: JSON.stringify({ kind: "storage", requestedBytes: 1024 }) }, c); }
  catch (e) { smallDenied = e.code === "VALIDATION"; }
  result.rejectBelowMin = smallDenied;

  const again = (await q("/me/service-requests", {
    method: "POST",
    body: JSON.stringify({ kind: "storage", requestedBytes: want, reason: "第二次，用来审批" }),
  }, c)).data;

  const queue = (await q("/admin/service-requests?status=pending", {}, c)).data;
  result.queueSeesMine = queue.requests.some(r => r.id === again.id && r.user?.id === me.id);

  const granted = want;
  const decided = (await q(`/admin/service-requests/${again.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "approved", grantedQuotaBytes: granted, adminNote: "验收通过" }),
  }, c)).data;
  result.approveSetsStatus = decided.status === "approved" && decided.grantedQuotaBytes === granted;

  const after = (await q("/me/storage", {}, c)).data;
  result.approveRaisesQuota = after.quotaBytes === granted && after.quotaOverride === true;

  const assigned = 5 * GB;
  await q(`/admin/users/${me.id}/storage`, { method: "POST", body: JSON.stringify({ storageQuotaBytes: assigned }) }, c);
  result.directAssign = (await q("/me/storage", {}, c)).data.quotaBytes === assigned;

  await q(`/admin/users/${me.id}/storage`, { method: "POST", body: JSON.stringify({ storageQuotaBytes: null }) }, c);
  const restored = (await q("/me/storage", {}, c)).data;
  result.restoreDefault = restored.quotaOverride === false && restored.quotaBytes === restored.defaultQuotaBytes;

  const overview = (await q("/admin/overview", {}, c)).data;
  result.overviewCountsRequests = typeof overview.pendingServiceRequestCount === "number";

  const settings = (await q("/admin/settings", { method: "PATCH", body: JSON.stringify({ allowStorageRequests: false }) }, c)).data;
  result.settingsToggle = settings.allowStorageRequests === false;
  let closed = false;
  try { await q("/me/service-requests", { method: "POST", body: JSON.stringify({ kind: "storage", requestedBytes: 10 * GB }) }, c); }
  catch (e) { closed = e.code === "FORBIDDEN"; }
  result.closedBlocksSubmit = closed;
  await q("/admin/settings", { method: "PATCH", body: JSON.stringify({ allowStorageRequests: true }) }, c);
} finally {
  // 把验收账号配额拨回默认，免得留下一个巨大覆盖
  await q(`/admin/users/${me.id}/storage`, { method: "POST", body: JSON.stringify({ storageQuotaBytes: null }) }, c).catch(() => {});
}

const failed = Object.entries(result).filter(([, v]) => v !== true);
console.log(JSON.stringify(result, null, 2));
if (failed.length) {
  console.error("失败项：", failed.map(([k]) => k).join(", "));
  process.exit(1);
}
console.log("user-services ok");
