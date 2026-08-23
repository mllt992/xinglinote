// 目录同级调序：新建排最后、整串重写 sort_key、换父后落到目标同级末尾、无权/跨本拒绝。
import { KB_EMAIL, KB_PASSWORD } from './creds.mjs';
const base = (process.env.KB_BASE_URL ?? 'http://127.0.0.1:12098') + '/api/v1';
async function request(path, options = {}, cookie = "") {
  const r = await fetch(base + path, { ...options, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(options.headers || {}) } });
  const set = r.headers.get("set-cookie");
  const json = await r.json();
  if (!r.ok || !json.ok) {
    const e = new Error(json.error?.message || `HTTP ${r.status}`);
    e.status = r.status;
    e.code = json.error?.code;
    throw e;
  }
  return { data: json.data, cookie: set?.split(";")[0] || cookie };
}
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);

const admin = (await request("/auth/login", { method: "POST", body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) })).cookie;
const ws = (await request("/workspaces", { method: "POST", body: JSON.stringify({ name: `目录调序验收-${suffix}` }) }, admin)).data;
const nbId = ws.notebook.id;
const a = (await request("/folders", { method: "POST", body: JSON.stringify({ notebookId: nbId, title: `甲${suffix}` }) }, admin)).data;
const b = (await request("/folders", { method: "POST", body: JSON.stringify({ notebookId: nbId, title: `乙${suffix}` }) }, admin)).data;
const c = (await request("/folders", { method: "POST", body: JSON.stringify({ notebookId: nbId, title: `丙${suffix}` }) }, admin)).data;
const createdLast = a.sortKey < b.sortKey && b.sortKey < c.sortKey;

const reversed = [c.id, b.id, a.id];
await request(`/notebooks/${nbId}/folders/order`, { method: "PATCH", body: JSON.stringify({ folderIds: reversed }) }, admin);
const tree = (await request(`/notebooks/${nbId}/tree`, {}, admin)).data;
const byId = Object.fromEntries(tree.folders.map((f) => [f.id, f]));
const reordered = byId[c.id].sortKey < byId[b.id].sortKey && byId[b.id].sortKey < byId[a.id].sortKey;

const parent = (await request("/folders", { method: "POST", body: JSON.stringify({ notebookId: nbId, title: `父${suffix}` }) }, admin)).data;
const child = (await request("/folders", { method: "POST", body: JSON.stringify({ notebookId: nbId, parentId: parent.id, title: `子先${suffix}` }) }, admin)).data;
const moved = (await request(`/folders/${a.id}`, { method: "PATCH", body: JSON.stringify({ parentId: parent.id }) }, admin)).data;
const movedLast = moved.parentId === parent.id && moved.sortKey > child.sortKey;

const other = (await request("/workspaces", { method: "POST", body: JSON.stringify({ name: `目录调序跨本-${suffix}` }) }, admin)).data;
const foreign = (await request("/folders", { method: "POST", body: JSON.stringify({ notebookId: other.notebook.id, title: `外${suffix}` }) }, admin)).data;
let foreignRejected = false;
try {
  await request(`/notebooks/${nbId}/folders/order`, { method: "PATCH", body: JSON.stringify({ folderIds: [foreign.id] }) }, admin);
} catch (e) { foreignRejected = e.status === 422 || e.status === 400; }
let otherNbRejected = false;
try {
  await request(`/notebooks/${other.notebook.id}/folders/order`, { method: "PATCH", body: JSON.stringify({ folderIds: [b.id] }) }, admin);
} catch (e) { otherNbRejected = e.status === 422 || e.status === 400; }

const result = { createdLast, reordered, movedLast, foreignRejected, otherNbRejected };
if (!Object.values(result).every(Boolean)) {
  console.error(result);
  process.exit(1);
}
console.log("ok", result);
