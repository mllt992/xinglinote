// 笔记换本：落到目标本根 / 指定目录、同名拒绝、跨区拒绝、无权目标本拒绝。
import { KB_EMAIL, KB_PASSWORD, TEST_PASSWORD } from './creds.mjs';
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
const ws = (await request("/workspaces", { method: "POST", body: JSON.stringify({ name: `笔记搬家验收-${suffix}` }) }, admin)).data;
const srcId = ws.notebook.id;
const dst = (await request(`/workspaces/${ws.workspace.id}/notebooks`, { method: "POST", body: JSON.stringify({ title: "目标本" }) }, admin)).data;
const folder = (await request("/folders", { method: "POST", body: JSON.stringify({ notebookId: srcId, title: "资料" }) }, admin)).data;
const destFolder = (await request("/folders", { method: "POST", body: JSON.stringify({ notebookId: dst.id, title: "归档" }) }, admin)).data;
const note = (await request("/notes", { method: "POST", body: JSON.stringify({ notebookId: srcId, folderId: folder.id, title: `搬家笔记${suffix}` }) }, admin)).data;
await request(`/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ expectedVersion: note.version, bodyMd: "换本之后正文还在。" }) }, admin);

// 没给 folderId：从「资料」换到目标本，应落到根上。
const moved = (await request(`/notes/${note.id}/move`, { method: "POST", body: JSON.stringify({ notebookId: dst.id }) }, admin)).data;
const afterRoot = (await request(`/notes/${note.id}`, {}, admin)).data;
const srcTree = (await request(`/notebooks/${srcId}/tree`, {}, admin)).data;
const dstTree = (await request(`/notebooks/${dst.id}/tree`, {}, admin)).data;

// 再指定目录搬回去。
const back = (await request(`/notes/${note.id}/move`, { method: "POST", body: JSON.stringify({ notebookId: srcId, folderId: folder.id }) }, admin)).data;

// 目标目录同名拒绝。
const twin = (await request("/notes", { method: "POST", body: JSON.stringify({ notebookId: dst.id, folderId: destFolder.id, title: `搬家笔记${suffix}` }) }, admin)).data;
let clashRejected = false;
try {
  await request(`/notes/${note.id}/move`, { method: "POST", body: JSON.stringify({ notebookId: dst.id, folderId: destFolder.id }) }, admin);
} catch (e) { clashRejected = e.status === 422; }

// 跨工作区拒绝。
const other = (await request("/workspaces", { method: "POST", body: JSON.stringify({ name: `笔记搬家跨区-${suffix}` }) }, admin)).data;
let crossWorkspaceRejected = false;
try {
  await request(`/notes/${note.id}/move`, { method: "POST", body: JSON.stringify({ notebookId: other.notebook.id }) }, admin);
} catch (e) { crossWorkspaceRejected = e.status === 422; }

// 无权的目标本：指定成员本，编辑者看不见。
const locked = (await request(`/workspaces/${ws.workspace.id}/notebooks`, { method: "POST", body: JSON.stringify({ title: "私密目标", visibility: "private" }) }, admin)).data;
const code = (await request("/admin/registration-codes", { method: "POST", body: JSON.stringify({ quantity: 1, maxUses: 1, skipEmailVerification: true, bindWorkspaceId: ws.workspace.id, bindRole: "editor" }) }, admin)).data.codes[0];
const member = (await request("/auth/register", { method: "POST", body: JSON.stringify({ email: `nmove-${suffix}@example.test`, password: TEST_PASSWORD, handle: `nmove${suffix}`, displayName: "笔记搬家成员", registrationCode: code }) })).cookie;
const editable = (await request("/notes", { method: "POST", body: JSON.stringify({ notebookId: srcId, title: `成员可编${suffix}` }) }, member)).data;
let forbiddenTarget = false;
try {
  await request(`/notes/${editable.id}/move`, { method: "POST", body: JSON.stringify({ notebookId: locked.id }) }, member);
} catch (e) { forbiddenTarget = e.status === 404 || e.status === 403; }

const search = (await request(`/search?q=搬家笔记${suffix}&workspaceId=${ws.workspace.id}`, {}, admin)).data.hits;

const result = {
  landedInTargetRoot: moved.notebookId === dst.id && moved.folderId === null,
  bodyIntact: afterRoot.bodyMd.includes("换本之后正文还在"),
  goneFromSource: !srcTree.notes.some(n => n.id === note.id),
  appearedInTarget: dstTree.notes.some(n => n.id === note.id && (n.folderId ?? null) === null),
  versionBumped: moved.version === note.version + 2 && afterRoot.version === moved.version,
  movedBackToFolder: back.notebookId === srcId && back.folderId === folder.id,
  clashRejected,
  crossWorkspaceRejected,
  forbiddenTarget,
  searchStillFinds: search.some(h => h.id === note.id),
  leftoverTwin: twin.id !== note.id,
};
console.log(JSON.stringify(result, null, 2));
if (!Object.values(result).every(Boolean)) process.exitCode = 1;
