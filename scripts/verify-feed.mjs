// 圈子动态、泄漏检查、转正、公开主页、评论回复与验证码的验收（规格 08 / 09）。
// 用法：KB_EMAIL=... KB_PASSWORD=... node scripts/verify-feed.mjs
import { KB_EMAIL, KB_PASSWORD } from './creds.mjs';
const base = (process.env.KB_BASE_URL??'http://127.0.0.1:12098')+'/api/v1';
async function q(path, opt = {}, cookie = '') {
  const r = await fetch(base + path, { ...opt, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opt.headers || {}) } });
  const j = await r.json();
  if (!r.ok || !j.ok) { const e = new Error(j.error?.message ?? r.status); e.code = j.error?.code; e.status = r.status; throw e; }
  return { data: j.data, cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie };
}
const anon = (path, opt = {}) => fetch(base + path, { ...opt, headers: { 'content-type': 'application/json', ...(opt.headers || {}) } }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
const c = (await q('/auth/login', { method: 'POST', body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) })).cookie;
const me = (await q('/me', {}, c)).data;
const ws = (await q('/workspaces', { method: 'POST', body: JSON.stringify({ name: '动态验收' }) }, c)).data.workspace;
const result = {};
const madePosts = [];
try {
  const nb = (await q(`/workspaces/${ws.id}/notebooks`, {}, c)).data.notebooks[0];
  const secret = (await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, title: '没公开的笔记' }) }, c)).data;

  // 圈子动态
  const post = (await q('/posts', { method: 'POST', body: JSON.stringify({ body: '圈子里的第一条想法', visibility: 'workspace', workspaceId: ws.id }) }, c)).data;
  madePosts.push(post.id);
  const feed = (await q(`/feed/workspaces/${ws.id}`, {}, c)).data;
  result.workspaceFeedLists = feed.posts.some(p => p.id === post.id);
  result.feedMarksMine = feed.posts.find(p => p.id === post.id)?.mine === true;
  result.publicFeedExcludesWorkspacePost = !(await q('/feed/public', {}, c)).data.posts.some(p => p.id === post.id);

  // 编辑
  await q(`/posts/${post.id}`, { method: 'PATCH', body: JSON.stringify({ body: '圈子里的第一条想法（改过）' }) }, c);
  const edited = (await q(`/feed/workspaces/${ws.id}`, {}, c)).data.posts.find(p => p.id === post.id);
  result.postEditMarksEdited = edited.body.includes('改过') && !!edited.editedAt;

  // 泄漏检查
  const scan = (await q('/posts/leak-check', { method: 'POST', body: JSON.stringify({ body: `看看 [[${secret.title}]] 这篇` }) }, c)).data;
  result.leakScanFlagsPrivate = scan.links.length === 1 && scan.links[0].publiclyVisible === false;

  // 圈子 → 广场：不确认要报错，确认后链接打成纯文本，圈子原帖还在
  const linked = (await q('/posts', { method: 'POST', body: JSON.stringify({ body: `圈子里提到 [[${secret.title}]]`, visibility: 'workspace', workspaceId: ws.id }) }, c)).data;
  madePosts.push(linked.id);
  let blocked = false;
  try { await q(`/posts/${linked.id}/publish-to-square`, { method: 'POST', body: JSON.stringify({}) }, c); } catch (e) { blocked = e.code === 'VALIDATION' && e.message.includes(secret.title); }
  result.squareCopyWarnsAboutLeaks = blocked;
  const copied = (await q(`/posts/${linked.id}/publish-to-square`, { method: 'POST', body: JSON.stringify({ confirmStripLinks: true }) }, c)).data;
  madePosts.push(copied.id);
  const square = (await q('/feed/public', {}, c)).data.posts.find(p => p.id === copied.id);
  result.squareCopyStripsLinks = !!square && !square.body.includes('[[') && square.body.includes(secret.title);
  result.squareCopyKeepsOriginal = (await q(`/feed/workspaces/${ws.id}`, {}, c)).data.posts.some(p => p.id === linked.id);

  // 转正为笔记
  const promoted = (await q(`/posts/${post.id}/promote`, { method: 'POST', body: JSON.stringify({ notebookId: nb.id }) }, c)).data;
  const promotedNote = (await q(`/notes/${promoted.noteId}`, {}, c)).data;
  result.promoteCreatesNote = promotedNote.title.includes('圈子里的第一条想法');
  result.promoteKeepsSource = promotedNote.bodyMd.startsWith('> 来自圈子动态');

  // 公开主页
  const profile = (await anon(`/public/users/${me.handle}`)).json.data;
  result.profileReadableAnonymously = profile.handle === me.handle && Array.isArray(profile.posts);
  result.profileShowsSquarePost = profile.posts.some(p => p.id === copied.id);
  result.profileHidesWorkspacePost = !profile.posts.some(p => p.id === post.id);
  result.profileUnknownHandle404 = (await anon('/public/users/nobody-here-at-all')).status === 404;

  // 评论：分享链接上的一层回复、5 分钟编辑、访客验证码
  const shareNote = (await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, title: '带评论的分享' }) }, c)).data;
  await q(`/notes/${shareNote.id}`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: shareNote.version, bodyMd: '原文有一句会被纠错的话。' }) }, c);
  const share = (await q(`/notes/${shareNote.id}/shares`, { method: 'POST', body: JSON.stringify({ commentsEnabled: true, correctionsEnabled: true }) }, c)).data;
  const root = (await q(`/public/notes/${shareNote.id}/comments?shareToken=${share.token}`, { method: 'POST', body: JSON.stringify({ body: '登录用户的评论' }) }, c)).data;
  const reply = (await q(`/public/notes/${shareNote.id}/comments?shareToken=${share.token}`, { method: 'POST', body: JSON.stringify({ body: '一层回复', parentId: root.id }) }, c)).data;
  result.commentReplyAccepted = !!reply.id;
  let twoLevels = false;
  try { await q(`/public/notes/${shareNote.id}/comments?shareToken=${share.token}`, { method: 'POST', body: JSON.stringify({ body: '二层回复', parentId: reply.id }) }, c); } catch (e) { twoLevels = e.code === 'VALIDATION'; }
  result.commentRejectsSecondLevel = twoLevels;
  const listed = (await q(`/public/notes/${shareNote.id}/comments?shareToken=${share.token}`, {}, c)).data.comments;
  result.commentListCarriesParent = listed.find(x => x.id === reply.id)?.parentId === root.id;
  await q(`/public/comments/${root.id}`, { method: 'PATCH', body: JSON.stringify({ body: '改过的评论' }) }, c);
  result.commentEditableWithin5min = (await q(`/public/notes/${shareNote.id}/comments?shareToken=${share.token}`, {}, c)).data.comments.find(x => x.id === root.id)?.body === '改过的评论';

  // 访客一路是限流的（同一 IP 10 分钟 5 条），连着跑几次脚本会撞上，撞上也算限流生效
  const limited = r => r.json?.error?.code === 'RATE_LIMIT';
  const guestComment = (body, extra) => anon(`/public/notes/${shareNote.id}/comments?shareToken=${share.token}`, { method: 'POST', body: JSON.stringify({ body, guestName: '路人', ...extra }) });
  const challenge = (await anon('/public/captcha')).json.data;
  const [x, y] = challenge.question.match(/\d+/g).map(Number);
  const withCaptcha = await guestComment('访客带了验证码', { challengeToken: challenge.token, challengeAnswer: String(x + y) });
  result.guestPassesWithCaptcha = limited(withCaptcha) || (withCaptcha.status === 201 && withCaptcha.json.data.status === 'pending');
  const noCaptcha = await guestComment('访客不带验证码', {});
  result.guestNeedsCaptcha = noCaptcha.status !== 201;
  const wrong = (await anon('/public/captcha')).json.data;
  const bad = await guestComment('答错了', { challengeToken: wrong.token, challengeAnswer: '99999' });
  result.guestWrongCaptchaRejected = bad.status !== 201;

  // 纠错要看分享自己的开关
  const noFix = (await q(`/notes/${shareNote.id}/shares`, { method: 'POST', body: JSON.stringify({ correctionsEnabled: false }) }, c)).data;
  const fixBlocked = await anon(`/public/notes/${shareNote.id}/corrections?shareToken=${noFix.token}`, { method: 'POST', body: JSON.stringify({ originalExcerpt: '原文有一句', suggested: '改一下', guestName: '路人' }) });
  result.correctionsRespectFlag = fixBlocked.status === 403;
} finally {
  for (const id of madePosts) await q(`/posts/${id}`, { method: 'DELETE' }, c).catch(() => {});
  await q(`/workspaces/${ws.id}`, { method: 'DELETE', body: JSON.stringify({ confirmName: ws.name }) }, c).catch(() => {});
}
console.log(JSON.stringify(result, null, 2));
const failed = Object.entries(result).filter(([, v]) => !v).map(([k]) => k);
if (failed.length) { console.error('失败：' + failed.join(', ')); process.exitCode = 1; }
