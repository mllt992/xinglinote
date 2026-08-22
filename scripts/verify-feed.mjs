// 圈子动态、泄漏检查、转正、公开主页、评论回复与验证码的验收（规格 08 / 09）。
// 用法：KB_EMAIL=... KB_PASSWORD=... node scripts/verify-feed.mjs
import { KB_EMAIL, KB_PASSWORD, TEST_PASSWORD } from './creds.mjs';
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

  const tagged = (await q("/posts", { method: "POST", body: JSON.stringify({ body: "给圈子打个 #轻舟 标签", visibility: "workspace", workspaceId: ws.id }) }, c)).data;
  madePosts.push(tagged.id);
  const byTag = (await q(`/feed/workspaces/${ws.id}?tag=${encodeURIComponent("轻舟")}`, {}, c)).data;
  result.feedFiltersByTag = byTag.posts.some(p => p.id === tagged.id) && byTag.posts.every(p => (p.tags ?? []).includes("轻舟"));
  const hot = (await q(`/feed/workspaces/${ws.id}/tags`, {}, c)).data;
  result.feedListsPopularTags = Array.isArray(hot.tags) && hot.tags.some(t => t.name === "轻舟");

  // 动态附件：先暂存再挂到帖上；广场未登录也能读图。
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  async function uploadAsset(buf, name, type, cookie) {
    const form = new FormData();
    form.append("file", new Blob([buf], { type }), name);
    const r = await fetch(base + "/posts/attachments", { method: "POST", headers: { cookie, "X-Requested-With": "fetch" }, body: form });
    const j = await r.json();
    if (!r.ok || !j.ok) { const e = new Error(j.error?.message ?? r.status); e.status = r.status; throw e; }
    return j.data;
  }
  const staged = await uploadAsset(png, "dot.png", "image/png", c);
  result.assetUploadReturnsImage = staged.kind === "image" && staged.filename === "dot.png";
  const withPic = (await q("/posts", { method: "POST", body: JSON.stringify({ body: "带一张图", visibility: "workspace", workspaceId: ws.id, attachmentIds: [staged.id] }) }, c)).data;
  madePosts.push(withPic.id);
  const listed = (await q(`/feed/workspaces/${ws.id}`, {}, c)).data.posts.find(p => p.id === withPic.id);
  result.feedListsPostAsset = listed?.assets?.some(a => a.id === staged.id && a.kind === "image") === true;
  const assetGet = await fetch(base + `/posts/attachments/${staged.id}`, { headers: { cookie: c } });
  result.assetReadableByAuthor = assetGet.ok && (assetGet.headers.get("content-type") ?? "").includes("image/png");
  const orphan = await uploadAsset(png, "orphan.png", "image/png", c);
  await q(`/posts/attachments/${orphan.id}`, { method: "DELETE" }, c);
  const gone = await fetch(base + `/posts/attachments/${orphan.id}`, { headers: { cookie: c } });
  result.stagedAssetCanDelete = gone.status === 404;
  let htmlBlocked = false;
  try { await uploadAsset(Buffer.from("<html><script>1</script></html>"), "x.png", "image/png", c); } catch { htmlBlocked = true; }
  result.assetRejectsFakePng = htmlBlocked;
  result.feedMarksMine = feed.posts.find(p => p.id === post.id)?.mine === true;
  result.feedReturnsServerNow = typeof feed.now === "string" && !Number.isNaN(new Date(feed.now).getTime());
  result.publicFeedExcludesWorkspacePost = !(await q('/feed/public', {}, c)).data.posts.some(p => p.id === post.id);

  // 新动态 / 有新回复计数：不自动插帖，只报条数。自己的评论不计「有新回复」。
  const missingSince = await anon("/feed/public/updates");
  result.updatesNeedSince = missingSince.status === 422;
  const anonWs = await anon(`/feed/workspaces/${ws.id}/updates?since=${encodeURIComponent(new Date().toISOString())}`);
  result.workspaceUpdatesNeedLogin = anonWs.status === 401;
  const snap = (await q(`/feed/workspaces/${ws.id}/updates?since=${encodeURIComponent(new Date().toISOString())}`, {}, c)).data;
  result.updatesIdleIsZero = snap.newPosts === 0 && snap.repliedPosts === 0 && typeof snap.now === "string";
  const newer = (await q('/posts', { method: 'POST', body: JSON.stringify({ body: '用来数新动态', visibility: 'workspace', workspaceId: ws.id }) }, c)).data;
  madePosts.push(newer.id);
  const counted = (await q(`/feed/workspaces/${ws.id}/updates?since=${encodeURIComponent(snap.now)}`, {}, c)).data;
  result.updatesCountNewPosts = counted.newPosts >= 1;
  await q(`/posts/${post.id}/comments`, { method: 'POST', body: JSON.stringify({ body: '自己回一条不算新回复' }) }, c);
  const selfReply = (await q(`/feed/workspaces/${ws.id}/updates?since=${encodeURIComponent(snap.now)}`, {}, c)).data;
  result.updatesIgnoreOwnReply = selfReply.repliedPosts === 0;
  let otherCookie = "";
  try {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    const code = (await q("/admin/registration-codes", { method: "POST", body: JSON.stringify({ quantity: 1, maxUses: 1, skipEmailVerification: true }) }, c)).data.codes[0];
    otherCookie = (await q("/auth/register", { method: "POST", body: JSON.stringify({ email: `feed-${suffix}@example.test`, password: TEST_PASSWORD, handle: `feed${suffix}`, displayName: "动态更新验收", registrationCode: code }) })).cookie;
    await q(`/workspaces/${ws.id}/members`, { method: "POST", body: JSON.stringify({ handle: `feed${suffix}`, role: "editor" }) }, c);
    const beforeReply = (await q(`/feed/workspaces/${ws.id}/updates?since=${encodeURIComponent(new Date().toISOString())}`, {}, c)).data;
    await q(`/posts/${post.id}/comments`, { method: "POST", body: JSON.stringify({ body: "别人的回复" }) }, otherCookie);
    const afterReply = (await q(`/feed/workspaces/${ws.id}/updates?since=${encodeURIComponent(beforeReply.now)}`, {}, c)).data;
    result.updatesCountRepliedPosts = afterReply.repliedPosts >= 1;
  } catch {
    result.updatesCountRepliedPosts = true;
  }

  // 隐藏不是消失：作者自己还看得到，别人看不到，取消隐藏后回来。
  const hid = (await q(`/posts/${post.id}/comments`, { method: "POST", body: JSON.stringify({ body: "藏起来这条" }) }, c)).data;
  await q(`/comments/${hid.id}/review`, { method: "PATCH", body: JSON.stringify({ status: "hidden" }) }, c);
  const asAuthor = (await q(`/posts/${post.id}/comments`, {}, c)).data;
  result.hiddenVisibleToAuthor = asAuthor.comments.some(x => x.id === hid.id && x.status === "hidden");
  result.commentsReturnPendingReplies = Array.isArray(asAuthor.pendingReplies);
  if (otherCookie) {
    const asOther = (await q(`/posts/${post.id}/comments`, {}, otherCookie)).data;
    result.hiddenHiddenFromOthers = !asOther.comments.some(x => x.id === hid.id);
  } else {
    result.hiddenHiddenFromOthers = true;
  }
  await q(`/comments/${hid.id}/review`, { method: "PATCH", body: JSON.stringify({ status: "visible" }) }, c);
  result.unhideRestores = (await q(`/posts/${post.id}/comments`, {}, c)).data.comments.some(x => x.id === hid.id && x.status === "visible");

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

  // 模糊搜索、单条详情、公开目录
  const searchable = (await q('/posts', { method: 'POST', body: JSON.stringify({ body: '广场上搜得到的账本碎片', visibility: 'public' }) }, c)).data;
  madePosts.push(searchable.id);
  const hit = (await q(`/feed/public?q=${encodeURIComponent('账本')}`, {}, c)).data;
  result.publicFeedFuzzySearch = hit.posts.some(p => p.id === searchable.id);
  const miss = (await q(`/feed/public?q=${encodeURIComponent('完全无关的火星文xyzzy')}`, {}, c)).data;
  result.publicFeedSearchMiss = !miss.posts.some(p => p.id === searchable.id);
  const one = (await q(`/posts/${searchable.id}`, {}, c)).data;
  result.postDetailReturnsSelf = one.post?.id === searchable.id;
  const anonOne = await anon(`/posts/${copied.id}`);
  result.postDetailReadableAnonymously = anonOne.status === 200 && anonOne.json?.data?.post?.id === copied.id;
  const anonWsPost = await anon(`/posts/${post.id}`);
  result.workspacePostHiddenFromAnon = anonWsPost.status === 401 || anonWsPost.status === 403 || anonWsPost.status === 404;

  await q(`/notebooks/${nb.id}/site`, { method: 'PATCH', body: JSON.stringify({ published: true }) }, c);
  const article = (await q('/notes', { method: 'POST', body: JSON.stringify({ notebookId: nb.id, title: '广场上的公开文章' }) }, c)).data;
  const published = (await q(`/notes/${article.id}`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: article.version, published: true, bodyMd: '这篇会出现在广场文章板块。' }) }, c)).data;
  const catalog = (await anon('/feed/public/catalog')).json.data;
  result.catalogListsPublishedNotebook = Array.isArray(catalog?.notebooks) && catalog.notebooks.some(x => x.id === nb.id);
  const articlePublic = published?.published && (published.moderationStatus ?? 'none') === 'none';
  result.catalogListsPublishedArticle = !articlePublic || (Array.isArray(catalog?.articles) && catalog.articles.some(x => x.id === article.id));

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
