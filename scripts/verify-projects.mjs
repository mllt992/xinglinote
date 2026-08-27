// 项目面板验收（设计 23 §6）：建项目/任务、看板挪列、计时、ACL、归档。
// 用法：KB_EMAIL=... KB_PASSWORD=... node scripts/verify-projects.mjs
import { KB_EMAIL, KB_PASSWORD, TEST_PASSWORD } from './creds.mjs';
const base = (process.env.KB_BASE_URL ?? 'http://127.0.0.1:12098') + '/api/v1';

async function q(path, opt = {}, cookie = '') {
  const r = await fetch(base + path, { ...opt, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opt.headers || {}) } });
  const j = await r.json();
  if (!r.ok || !j.ok) { const e = new Error(j.error?.message ?? r.status); e.code = j.error?.code; e.status = r.status; throw e; }
  return { data: j.data, cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie };
}
const rejects = async (fn, code) => { try { await fn(); return false; } catch (e) { return code ? e.code === code : true; } };

const c = (await q('/auth/login', { method: 'POST', body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) })).cookie;
const ws = (await q('/workspaces', { method: 'POST', body: JSON.stringify({ name: '项目面板验收' }) }, c)).data.workspace;
const result = {};
try {
  const listed0 = (await q(`/workspaces/${ws.id}/projects`, {}, c)).data;
  result.emptyListOk = Array.isArray(listed0.projects) && listed0.projects.length === 0 && listed0.canEdit === true;

  const created = (await q(`/workspaces/${ws.id}/projects`, { method: 'POST', body: JSON.stringify({ title: '交付面板', description: '不是第二个待办', status: 'active' }) }, c)).data;
  result.createProject = created.title === '交付面板' && created.health?.score === 100 && created.health?.band === 'steady';

  const listed = (await q(`/workspaces/${ws.id}/projects`, {}, c)).data;
  result.listShowsNew = listed.projects.some(p => p.id === created.id);

  const task = (await q(`/projects/${created.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: '第一件要交的事', status: 'todo', estimateMin: 60 }) }, c)).data;
  result.createTask = task.title === '第一件要交的事' && task.status === 'todo';

  const moved = (await q(`/project-tasks/${task.id}/move`, { method: 'POST', body: JSON.stringify({ status: 'doing' }) }, c)).data;
  result.boardMove = moved.status === 'doing';

  const child = (await q(`/projects/${created.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: '子任务一层', parentId: task.id }) }, c)).data;
  result.oneLevelChild = child.parentId === task.id;
  result.noGrandchild = await rejects(() => q(`/projects/${created.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: '不能再挂', parentId: child.id }) }, c), 'VALIDATION');

  const nb = (await q(`/workspaces/${ws.id}/notebooks`, { method: 'POST', body: JSON.stringify({ title: '项目挂笔记本' }) }, c)).data;
  let note = (await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, title: '交付说明' }) }, c)).data;
  note = (await q(`/notes/${note.id}`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: note.version, bodyMd: '项目任务不回写这一行 - [ ] 待办' }) }, c)).data;
  const linked = (await q(`/project-tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ sourceNoteId: note.id }) }, c)).data;
  result.linkNote = linked.sourceNoteId === note.id;
  const afterLink = (await q(`/notes/${note.id}`, {}, c)).data;
  result.noteNotRewritten = typeof afterLink.bodyMd === 'string' && afterLink.bodyMd.includes('- [ ] 待办') && afterLink.version === note.version;

  const dueDay = new Date(Date.now() + 3 * 86400000).toISOString();
  const mile = (await q(`/projects/${created.id}/milestones`, { method: 'POST', body: JSON.stringify({ title: '可点面板', dueAt: dueDay }) }, c)).data;
  result.milestoneCreate = mile.title === '可点面板' && !!mile.dueAt;

  const due = new Date(Date.now() + 4 * 86400000).toISOString();
  const start = new Date(Date.now() + 86400000).toISOString();
  const dated = (await q(`/project-tasks/${task.id}/reschedule`, { method: 'POST', body: JSON.stringify({ startAt: start, dueAt: due }) }, c)).data;
  result.reschedule = !!dated.startAt && !!dated.dueAt;

  const started = (await q(`/projects/${created.id}/time/start`, { method: 'POST', body: JSON.stringify({ taskId: task.id }) }, c)).data;
  result.timerStart = !!started.running?.id && started.running.taskId === task.id;
  await new Promise(r => setTimeout(r, 1100));
  const stopped = (await q(`/projects/${created.id}/time/stop`, { method: 'POST', body: '{}' }, c)).data;
  result.timerStopPersists = stopped.entry.seconds >= 1 && !!stopped.entry.endedAt;

  const other = (await q(`/projects/${created.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: '第二件' }) }, c)).data;
  const first = (await q(`/projects/${created.id}/time/start`, { method: 'POST', body: JSON.stringify({ taskId: task.id }) }, c)).data;
  const second = (await q(`/projects/${created.id}/time/start`, { method: 'POST', body: JSON.stringify({ taskId: other.id }) }, c)).data;
  result.oneTimerPerUser = first.running.taskId === task.id && second.running.taskId === other.id && second.stopped.length === 1;
  await q(`/projects/${created.id}/time/stop`, { method: 'POST', body: '{}' }, c);

  const code = (await q('/admin/registration-codes', { method: 'POST', body: JSON.stringify({ quantity: 1, maxUses: 1, skipEmailVerification: true, bindWorkspaceId: ws.id, bindRole: 'viewer' }) }, c)).data.codes[0];
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const viewer = (await q('/auth/register', { method: 'POST', body: JSON.stringify({ email: `proj-${suffix}@example.test`, password: TEST_PASSWORD, handle: `proj${suffix}`, displayName: '项目验收只读', registrationCode: code }) })).cookie;
  result.viewerWriteForbidden = await rejects(() => q(`/workspaces/${ws.id}/projects`, { method: 'POST', body: JSON.stringify({ title: '只读不能建' }) }, viewer), 'FORBIDDEN');
  const seen = (await q(`/workspaces/${ws.id}/projects`, {}, viewer)).data;
  result.viewerCanReadWorkspace = seen.projects.some(p => p.id === created.id);

  const secret = (await q(`/workspaces/${ws.id}/projects`, { method: 'POST', body: JSON.stringify({ title: '仅自己', visibility: 'private' }) }, c)).data;
  result.privateHidden = await rejects(() => q(`/projects/${secret.id}`, {}, viewer), 'NOT_FOUND');
  result.privateMissingFromList = !(await q(`/workspaces/${ws.id}/projects`, {}, viewer)).data.projects.some(p => p.id === secret.id);

  await q(`/projects/${created.id}/archive`, { method: 'POST' }, c);
  const afterArchive = (await q(`/workspaces/${ws.id}/projects`, {}, c)).data;
  const archivedList = (await q(`/workspaces/${ws.id}/projects?archived=1`, {}, c)).data;
  const detail = (await q(`/projects/${created.id}`, {}, c)).data;
  result.archiveHidesFromDefault = !afterArchive.projects.some(p => p.id === created.id)
    && archivedList.projects.some(p => p.id === created.id)
    && detail.canEdit === false
    && detail.project.status === 'archived';
  result.archivedWriteForbidden = await rejects(() => q(`/projects/${created.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: '归档后不能写' }) }, c), 'FORBIDDEN');
} finally {
  await q(`/workspaces/${ws.id}`, { method: 'DELETE' }, c).catch(() => {});
}
console.log(JSON.stringify(result, null, 2));
if (!Object.values(result).every(Boolean)) process.exitCode = 1;
