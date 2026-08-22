// 智能体：管理员 CRUD、动态 @、后台回复成评论（设计 20）。
// 用法：先起 pnpm dev 和 node scripts/mock-ai-provider.mjs
//       KB_EMAIL=... KB_PASSWORD=... node scripts/verify-agents.mjs
import { KB_EMAIL, KB_PASSWORD } from "./creds.mjs";

const base = (process.env.KB_BASE_URL ?? "http://127.0.0.1:12098") + "/api/v1";
async function q(path, opt = {}, cookie = "") {
  const r = await fetch(base + path, { ...opt, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(opt.headers || {}) } });
  const j = await r.json();
  if (!r.ok || !j.ok) {
    const e = new Error(j.error?.message ?? r.status);
    e.code = j.error?.code;
    e.status = r.status;
    throw e;
  }
  return { data: j.data, cookie: r.headers.get("set-cookie")?.split(";")[0] || cookie };
}

const login = await q("/auth/login", { method: "POST", body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) });
const c = login.cookie;
const me = (await q("/me", {}, c)).data;
const result = {};
const handle = `bot${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
let agentId = "";
let postId = "";

try {
  result.adminRequired = me.instanceRole === "admin";
  const created = (await q("/admin/agents", {
    method: "POST",
    body: JSON.stringify({
      handle,
      displayName: "验收助手",
      bio: "只在验收里说话",
      avatarEmoji: "🤖",
      systemPrompt: "用一句话回复用户。",
      allowSquare: true,
      allowCircle: true,
      knowledgeEnabled: false,
      baseUrl: "http://127.0.0.1:19091",
      chatModel: "mock-chat",
      apiKey: "test-key",
    }),
  }, c)).data;
  agentId = created.id;
  result.createReturnsHandle = created.handle === handle && created.keyConfigured === true && created.keySuffix.length === 4 && !String(created.apiKey ?? "").includes("test-key");

  const listed = (await q("/agents?scope=circle", {}, c)).data.agents;
  result.publicListIncludes = listed.some(a => a.id === agentId && a.handle === handle);

  const ws = (await q("/workspaces", { method: "POST", body: JSON.stringify({ name: "智能体验收" }) }, c)).data.workspace;
  const post = (await q("/posts", {
    method: "POST",
    body: JSON.stringify({ body: `请 @${handle} 看一下这段话`, visibility: "workspace", workspaceId: ws.id }),
  }, c)).data;
  postId = post.id;

  let reply = null;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const comments = (await q(`/posts/${post.id}/comments`, {}, c)).data.comments;
    reply = comments.find(x => x.authorKind === "agent" && x.authorHandle === handle);
    if (reply) break;
  }
  result.agentReplied = !!reply && typeof reply.body === "string" && reply.body.length > 0 && reply.agent?.id === agentId;

  const again = (await q(`/posts/${post.id}/comments`, {}, c)).data.comments.filter(x => x.authorKind === "agent" && x.authorHandle === handle);
  result.onlyOnce = again.length === 1;

  await q(`/admin/agents/${agentId}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) }, c);
  const hidden = (await q("/agents?scope=circle", {}, c)).data.agents;
  result.disableHidesFromPicker = !hidden.some(a => a.id === agentId);

  await q(`/admin/agents/${agentId}`, { method: "DELETE" }, c);
  const afterDelete = (await q("/admin/agents", {}, c)).data.agents;
  result.softDeleteHides = !afterDelete.some(a => a.id === agentId);

  let collide = false;
  try {
    await q("/admin/agents", {
      method: "POST",
      body: JSON.stringify({
        handle: me.handle,
        displayName: "撞名",
        systemPrompt: "x",
        baseUrl: "http://127.0.0.1:19091",
        chatModel: "mock-chat",
        apiKey: "test-key",
      }),
    }, c);
  } catch {
    collide = true;
  }
  result.handleCollisionBlocked = collide;
} catch (e) {
  result.error = e instanceof Error ? e.message : String(e);
}

console.log(JSON.stringify(result, null, 2));
if (result.error || !Object.entries(result).filter(([k]) => k !== "error").every(([, v]) => v === true)) process.exitCode = 1;
