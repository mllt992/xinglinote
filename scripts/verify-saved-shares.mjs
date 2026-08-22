// 收到的分享：登录打开后自动收下、自己的不自动收、移出不救活、手工可再存。
import { KB_EMAIL, KB_PASSWORD, TEST_PASSWORD } from "./creds.mjs";

const base = (process.env.KB_BASE_URL ?? "http://127.0.0.1:12098") + "/api/v1";
async function q(path, opt = {}, cookie = "") {
  const r = await fetch(base + path, { ...opt, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(opt.headers || {}) } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) { const e = new Error(j?.error?.message ?? r.status); e.status = r.status; e.code = j?.error?.code; throw e; }
  return { data: j.data, cookie: r.headers.get("set-cookie")?.split(";")[0] || cookie };
}

const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
const owner = (await q("/auth/login", { method: "POST", body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) })).cookie;
const ws = (await q("/workspaces", { method: "POST", body: JSON.stringify({ name: `收到分享-${suffix}` }) }, owner)).data.workspace;
const result = {};
try {
  const nb = (await q(`/workspaces/${ws.id}/notebooks`, {}, owner)).data.notebooks[0];
  const note = (await q("/notes", { method: "POST", body: JSON.stringify({ notebookId: nb.id, title: `外人可读 ${suffix}` }) }, owner)).data;
  const share = (await q(`/notes/${note.id}/shares`, { method: "POST", body: JSON.stringify({}) }, owner)).data;

  const guest = await fetch(`${base}/public/shares/${share.token}`);
  const guestJson = await guest.json();
  result.guestNoSave = guest.ok && guestJson.data?.savedShare == null;

  const ownerOpen = (await q(`/public/shares/${share.token}`, {}, owner)).data;
  result.ownerNotAutoSaved = ownerOpen.savedShare == null;
  const ownerList = (await q("/me/saved-shares", {}, owner)).data.items;
  result.ownerListEmpty = !ownerList.some(i => i.title.includes(suffix));

  const code = (await q("/admin/registration-codes", { method: "POST", body: JSON.stringify({ quantity: 1, maxUses: 1, skipEmailVerification: true }) }, owner)).data.codes[0];
  const receiver = (await q("/auth/register", { method: "POST", body: JSON.stringify({ email: `recv-${suffix}@example.test`, password: TEST_PASSWORD, handle: `recv${suffix}`, displayName: "接收者", registrationCode: code }) })).cookie;
  const opened = (await q(`/public/shares/${share.token}`, {}, receiver)).data;
  result.receiverAutoSaved = opened.savedShare?.status === "active" && !!opened.savedShare.id;
  const listed = (await q("/me/saved-shares", {}, receiver)).data.items;
  result.receiverSeesOne = listed.some(i => i.id === opened.savedShare.id && i.live === true);
  result.listHasNoToken = listed.every(i => !("token" in i) && !("shareToken" in i));

  const content = (await q(`/me/saved-shares/${opened.savedShare.id}/content`, {}, receiver)).data;
  result.contentHasBody = typeof content.bodyMd === "string" && !("shareToken" in content);

  await q(`/me/saved-shares/${opened.savedShare.id}`, { method: "DELETE" }, receiver);
  const afterDismiss = (await q("/me/saved-shares", {}, receiver)).data.items;
  result.dismissedGone = !afterDismiss.some(i => i.id === opened.savedShare.id);

  const reopen = (await q(`/public/shares/${share.token}`, {}, receiver)).data;
  result.noAutoRevive = reopen.savedShare?.status === "dismissed";
  const stillGone = (await q("/me/saved-shares", {}, receiver)).data.items;
  result.stillGoneAfterReopen = !stillGone.some(i => i.id === opened.savedShare.id);

  const again = (await q("/me/saved-shares", { method: "POST", body: JSON.stringify({ shareToken: share.token }) }, receiver)).data;
  result.manualRestore = again.status === "active";
  const back = (await q("/me/saved-shares", {}, receiver)).data.items;
  result.restoredVisible = back.some(i => i.id === again.id);

  await q(`/shares/${share.id}`, { method: "DELETE" }, owner);
  const dead = (await q("/me/saved-shares", {}, receiver)).data.items.find(i => i.id === again.id);
  result.revokedStaysListed = !!dead && dead.live === false;
  let contentGone = false;
  try { await q(`/me/saved-shares/${again.id}/content`, {}, receiver); } catch (e) { contentGone = e.status === 404; }
  result.revokedContent404 = contentGone;
} finally {
  await q(`/workspaces/${ws.id}`, { method: "DELETE", body: JSON.stringify({ confirmName: ws.name }) }, owner).catch(() => {});
}

console.log(JSON.stringify(result, null, 2));
if (!Object.values(result).every(Boolean)) {
  console.error("失败：" + Object.entries(result).filter(([, v]) => !v).map(([k]) => k).join(", "));
  process.exitCode = 1;
}
