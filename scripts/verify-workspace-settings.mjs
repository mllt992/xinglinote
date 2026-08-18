// 工作区设置页（成员 + 管理合并后）的接口验收：概览统计、改名、邀请生命周期、主动退出。
// 用法：KB_EMAIL=... KB_PASSWORD=... node scripts/verify-workspace-settings.mjs
// 账号需要是实例管理员：脚本要发注册码临时拉一个协作者进来。
import { KB_EMAIL as email, KB_PASSWORD as password } from './creds.mjs';
const base = (process.env.KB_BASE_URL ?? 'http://127.0.0.1:12098') + '/api/v1';

async function q(path, opt = {}, cookie = '') {
  const r = await fetch(base + path, { ...opt, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opt.headers || {}) } });
  const j = await r.json();
  if (!r.ok || !j.ok) { const e = new Error(j.error?.message ?? r.status); e.code = j.error?.code; e.status = r.status; throw e; }
  return { data: j.data, cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie };
}
/** 期望被拒：返回错误码，成功反而是 bug。 */
async function denied(path, opt = {}, cookie = '') {
  try { await q(path, opt, cookie); return 'NOT_DENIED'; } catch (e) { return e.code ?? String(e.status); }
}

const admin = (await q('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })).cookie;
const me = (await q('/me', {}, admin)).data;
const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
const code = (await q('/admin/registration-codes', { method: 'POST', body: JSON.stringify({ quantity: 1, maxUses: 1, skipEmailVerification: true }) }, admin)).data.codes[0];
const guest = await q('/auth/register', { method: 'POST', body: JSON.stringify({ email: `wsset-${suffix}@example.test`, password: 'Password1234', handle: `wsset${suffix}`, displayName: '设置页验收成员', registrationCode: code }) });
const gc = guest.cookie;
const guestMe = (await q('/me', {}, gc)).data;

const ws = (await q('/workspaces', { method: 'POST', body: JSON.stringify({ name: '设置页验收' }) }, admin)).data.workspace;
const result = {};
try {
  // —— 概览：空工作区的基线 ——
  const nb = (await q(`/workspaces/${ws.id}/notebooks`, {}, admin)).data.notebooks[0];
  const note = (await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, title: '验收笔记' }) }, admin)).data;
  let ov = (await q(`/workspaces/${ws.id}/overview`, {}, admin)).data;
  result.overviewCountsNotes = ov.stats.notes === 1 && ov.stats.notebooks === 1;
  result.overviewCountsMembers = ov.stats.members === 1 && ov.roles.owner === 1;
  result.overviewKnowsRole = ov.myRole === 'owner' && ov.canManage === true;
  result.overviewNamesOwner = ov.workspace.ownerHandle === me.handle;
  result.overviewBackupEmpty = ov.backup?.targets === 0 && ov.backup?.lastRunAt === null;

  // —— 改名：写库 + 落审计；空名字要挡住 ——
  result.renameWorks = (await q(`/workspaces/${ws.id}`, { method: 'PATCH', body: JSON.stringify({ name: '设置页验收（已改名）' }) }, admin)).data.name === '设置页验收（已改名）';
  result.renameShowsInOverview = (await q(`/workspaces/${ws.id}/overview`, {}, admin)).data.workspace.name === '设置页验收（已改名）';
  result.renameRejectsEmpty = (await denied(`/workspaces/${ws.id}`, { method: 'PATCH', body: JSON.stringify({ name: '   ' }) }, admin)) === 'VALIDATION';
  result.renameAudited = (await q(`/workspaces/${ws.id}/audit`, {}, admin)).data.logs.some(l => l.action === 'workspace.rename');
  // 个人工作区也能改名：它就是「我的库」的标题
  result.personalRenameWorks = (await q(`/workspaces/${me.personalWorkspaceId}`, { method: 'PATCH', body: JSON.stringify({ name: `我的库-${suffix}` }) }, admin)).data.name === `我的库-${suffix}`;

  // —— 邀请：建 → 列 → 作废 → 链接失效 ——
  const invite = (await q(`/workspaces/${ws.id}/invites`, { method: 'POST', body: JSON.stringify({ role: 'editor', expiresInDays: 7, maxUses: 1 }) }, admin)).data;
  let invites = (await q(`/workspaces/${ws.id}/invites`, {}, admin)).data.invites;
  result.inviteListed = invites.length === 1 && invites[0].status === 'active' && invites[0].role === 'editor' && invites[0].usedCount === 0;
  result.inviteHidesToken = !JSON.stringify(invites[0]).includes(invite.token) && invite.token.startsWith(invites[0].tokenPrefix);
  result.inviteCountedInOverview = (await q(`/workspaces/${ws.id}/overview`, {}, admin)).data.stats.activeInvites === 1;
  await q(`/invites/${invite.id}`, { method: 'DELETE' }, admin);
  invites = (await q(`/workspaces/${ws.id}/invites`, {}, admin)).data.invites;
  result.inviteRevoked = invites[0].status === 'revoked';
  result.revokedInviteUnusable = (await denied(`/invites/${invite.token}`)) === 'NOT_FOUND';
  result.revokeIsIdempotentGuarded = (await denied(`/invites/${invite.id}`, { method: 'DELETE' }, admin)) === 'VALIDATION';
  result.revokeAudited = (await q(`/workspaces/${ws.id}/audit`, {}, admin)).data.logs.some(l => l.action === 'workspace.invite_revoke');

  // —— 成员：加人、算写了几篇、非管理员看不到邀请也改不了名 ——
  await q(`/workspaces/${ws.id}/members`, { method: 'POST', body: JSON.stringify({ handle: guestMe.handle, role: 'viewer' }) }, admin);
  let members = (await q(`/workspaces/${ws.id}/members`, {}, admin)).data;
  result.membersHaveNoteCount = members.members.find(m => m.userId === me.id)?.noteCount === 1 && members.members.find(m => m.userId === guestMe.id)?.noteCount === 0;
  result.membersExposeOwnerAndRole = members.ownerId === me.id && members.canManage === true && members.myUserId === me.id;
  const guestView = (await q(`/workspaces/${ws.id}/members`, {}, gc)).data;
  result.viewerCannotManage = guestView.canManage === false && guestView.myRole === 'viewer';
  result.viewerCannotListInvites = (await denied(`/workspaces/${ws.id}/invites`, {}, gc)) === 'FORBIDDEN';
  result.viewerCannotRename = (await denied(`/workspaces/${ws.id}`, { method: 'PATCH', body: JSON.stringify({ name: '越权改名' }) }, gc)) === 'FORBIDDEN';
  const guestOv = (await q(`/workspaces/${ws.id}/overview`, {}, gc)).data;
  result.viewerOverviewHidesBackupAndAudit = guestOv.backup === null && guestOv.recentAudit.length === 0 && guestOv.stats.members === 2;

  // —— 分享统计：概览要能提醒「有几条没密码的对外链接」——
  await q(`/notes/${note.id}/shares`, { method: 'POST', body: JSON.stringify({}) }, admin);
  ov = (await q(`/workspaces/${ws.id}/overview`, {}, admin)).data;
  result.overviewCountsShares = ov.shares.active === 1 && ov.shares.noPassword === 1;

  // —— 退出：本人可以走，Owner 不行，个人工作区也不行 ——
  result.ownerCannotLeave = (await denied(`/workspaces/${ws.id}/leave`, { method: 'POST' }, admin)) === 'FORBIDDEN';
  result.personalCannotLeave = (await denied(`/workspaces/${me.personalWorkspaceId}/leave`, { method: 'POST' }, admin)) === 'FORBIDDEN';
  await q(`/workspaces/${ws.id}/leave`, { method: 'POST' }, gc);
  result.memberLeft = !(await q('/workspaces', {}, gc)).data.workspaces.some(w => w.id === ws.id);
  result.leaveDropsMember = (await q(`/workspaces/${ws.id}/members`, {}, admin)).data.members.length === 1;
  result.leaveAudited = (await q(`/workspaces/${ws.id}/audit`, {}, admin)).data.logs.some(l => l.action === 'workspace.member_leave');
  result.leaveIsNotReentry = (await denied(`/workspaces/${ws.id}/overview`, {}, gc)) === 'FORBIDDEN';
} finally {
  await q(`/workspaces/${ws.id}`, { method: 'DELETE', body: JSON.stringify({ confirmName: (await q(`/workspaces/${ws.id}/overview`, {}, admin)).data.workspace.name }) }, admin).catch(() => {});
}

console.log(JSON.stringify(result, null, 2));
if (!Object.values(result).every(Boolean)) process.exitCode = 1;
