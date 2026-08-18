import { Hono } from "hono";
import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import { hashPassword, validPassword, verifyPassword } from "@kb/core";
import { HANDLE_RE, fail } from "@kb/shared";
import { env } from "../env.ts";
import { db } from "../db/client.ts";
import { authTokens, backgroundJobs, instanceSettings, mcpTokens, registrationCodes, registrationCodeUsages, sessions, users, workspaceMembers, workspaces } from "../db/schema.ts";
import { secureToken, tokenHash } from "../lib/tokens.ts";
import { sendMail } from "../lib/mail.ts";
import { userStorage } from "../lib/quota.ts";
import { limit } from "../lib/rate-limit.ts";
import { ok } from "../http.ts";
import { clearSession, createSession, currentUser } from "../lib/session.ts";
import { createPersonalWorkspace } from "../lib/workspace.ts";

export const auth = new Hono();

const registerBody = z.object({
  email: z.string().email(),
  password: z.string(),
  handle: z.string(),
  displayName: z.string().min(1).max(32),
  registrationCode: z.string().optional(),
});

auth.get("/meta", async (c) => {
  const [{ value: userCount }] = await db.select({ value: count() }).from(users);
  const [settings] = await db.select().from(instanceSettings);
  return ok(c, {
    empty: userCount === 0,
    allowOpenRegistration: settings?.allowOpenRegistration ?? false,
    allowCodeRegistration: settings?.allowCodeRegistration ?? true,
    squareEnabled: settings?.squareEnabled ?? true,
    defaultThemeId: settings?.defaultThemeId ?? "mono-modern",
    defaultAccent: settings?.defaultAccent ?? null,
  });
});

auth.post("/auth/register", async (c) => {
  const body = registerBody.parse(await c.req.json());
  if (!HANDLE_RE.test(body.handle)) throw fail("VALIDATION", "handle 格式不正确", { handle: "小写字母开头，3–32 位" });
  if (!validPassword(body.password)) throw fail("VALIDATION", "密码至少 10 位且含字母和数字", { password: "太弱" });

  const [{ value: userCount }] = await db.select({ value: count() }).from(users);
  const [settings] = await db.select().from(instanceSettings);
  let code: typeof registrationCodes.$inferSelect | undefined;
  if (body.registrationCode) {
    [code] = await db.select().from(registrationCodes).where(eq(registrationCodes.codeHash, tokenHash(body.registrationCode)));
    if (!code || code.status !== "active") throw fail("VALIDATION", "注册码无效或已作废", { registrationCode: "无效" });
    if (code.expiresAt && code.expiresAt.getTime() <= Date.now()) throw fail("VALIDATION", "注册码已过期", { registrationCode: "已过期" });
    if (code.usedCount >= code.maxUses) throw fail("VALIDATION", "注册码已用完", { registrationCode: "已用完" });
  }
  const allow = userCount === 0 || settings?.allowOpenRegistration || (!!code && settings?.allowCodeRegistration);
  if (!allow) throw fail("FORBIDDEN", "目前不开放注册，请向管理员索取注册码");

  const email = body.email.toLowerCase();
  const exists = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (exists.length) throw fail("VALIDATION", "邮箱已被使用", { email: "已被使用" });
  const handleTaken = await db.select({ id: users.id }).from(users).where(eq(users.handle, body.handle));
  if (handleTaken.length) throw fail("VALIDATION", "handle 已被使用", { handle: "已被使用" });

  const isFirst = userCount === 0;
  const verifiedNow = isFirst || !settings?.requireEmailVerification || !!code?.skipEmailVerification;
  const [user] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(body.password),
      handle: body.handle,
      displayName: body.displayName,
      roleInstance: isFirst ? "admin" : "user",
      emailVerifiedAt: verifiedNow ? new Date() : null,
      status: "active",
    })
    .returning();

  if (isFirst) {
    await db.update(instanceSettings).set({ firstAdminUserId: user.id }).where(eq(instanceSettings.id, 1));
  }
  if (code) {
    const used = code.usedCount + 1;
    await db.update(registrationCodes).set({ usedCount: used, status: used >= code.maxUses ? "exhausted" : "active" }).where(eq(registrationCodes.id, code.id));
    await db.insert(registrationCodeUsages).values({ codeId: code.id, userId: user.id });
    if (code.bindWorkspaceId) {
      const [targetWs] = await db.select().from(workspaces).where(eq(workspaces.id, code.bindWorkspaceId));
      if (targetWs && targetWs.kind !== "personal") await db.insert(workspaceMembers).values({ workspaceId: targetWs.id, userId: user.id, role: code.bindRole ?? "viewer" }).onConflictDoNothing();
    }
  }
  await createPersonalWorkspace(user.id, user.displayName);
  if (!verifiedNow) {
    const token=secureToken(24);await db.insert(authTokens).values({userId:user.id,tokenHash:tokenHash(token),purpose:"verify_email",expiresAt:new Date(Date.now()+86400000)});
    const link=`${env.publicUrl}/verify-email?token=${token}`;const mail=await sendMail(user.email,"验证你的知识库账号",`请在 24 小时内打开：${link}`);
    return ok(c,{id:user.id,isFirst,requiresVerification:true,mailSent:mail.sent,developmentToken:mail.sent?undefined:token},201);
  }
  await createSession(c, user.id);
  return ok(c, { id: user.id, isFirst, requiresVerification:false }, 201);
});

auth.post("/auth/verify-email",async c=>{const body=z.object({token:z.string().min(20)}).parse(await c.req.json());const [t]=await db.select().from(authTokens).where(eq(authTokens.tokenHash,tokenHash(body.token)));if(!t||t.purpose!=="verify_email"||t.usedAt||t.expiresAt.getTime()<=Date.now())throw fail("EXPIRED","验证链接无效或已过期");await db.transaction(async tx=>{await tx.update(users).set({emailVerifiedAt:new Date()}).where(eq(users.id,t.userId));await tx.update(authTokens).set({usedAt:new Date()}).where(eq(authTokens.id,t.id));});await createSession(c,t.userId);return ok(c,{});});
auth.post("/auth/forgot-password",async c=>{const body=z.object({email:z.string().email()}).parse(await c.req.json());const [u]=await db.select().from(users).where(eq(users.email,body.email.toLowerCase()));if(u){const token=secureToken(24);await db.insert(authTokens).values({userId:u.id,tokenHash:tokenHash(token),purpose:"reset_password",expiresAt:new Date(Date.now()+3600000)});const link=`${env.publicUrl}/reset-password?token=${token}`;await sendMail(u.email,"重置知识库密码",`请在 1 小时内打开：${link}`);}return ok(c,{message:"如果邮箱存在，重置说明已经发送"});});
auth.post("/auth/reset-password",async c=>{const body=z.object({token:z.string().min(20),password:z.string()}).parse(await c.req.json());if(!validPassword(body.password))throw fail("VALIDATION","密码至少 10 位且含字母和数字");const [t]=await db.select().from(authTokens).where(eq(authTokens.tokenHash,tokenHash(body.token)));if(!t||t.purpose!=="reset_password"||t.usedAt||t.expiresAt.getTime()<=Date.now())throw fail("EXPIRED","重置链接无效或已过期");await db.transaction(async tx=>{await tx.update(users).set({passwordHash:await hashPassword(body.password),updatedAt:new Date()}).where(eq(users.id,t.userId));await tx.update(authTokens).set({usedAt:new Date()}).where(eq(authTokens.id,t.id));await tx.delete(sessions).where(eq(sessions.userId,t.userId));});return ok(c,{});});

auth.post("/auth/login", async (c) => {
  limit(`login:${c.req.header("x-forwarded-for")??"local"}`,10,60000);
  const body = z.object({ email: z.string().email(), password: z.string() }).parse(await c.req.json());
  const [user] = await db.select().from(users).where(eq(users.email, body.email.toLowerCase()));
  if (!user || !(await verifyPassword(user.passwordHash, body.password))) {
    throw fail("UNAUTHENTICATED", "邮箱或密码不对");
  }
  if (user.status === "banned") throw fail("FORBIDDEN", "账号已被停用");
  if (user.status === "deleted") throw fail("FORBIDDEN", "账号已注销");
  if (!user.emailVerifiedAt) throw fail("FORBIDDEN", "邮箱尚未验证，请检查邮件或重发验证信");
  await createSession(c, user.id);
  return ok(c, { id: user.id });
});

auth.post("/account/request-deletion",async c=>{const user=await currentUser(c);if(!user)throw fail("UNAUTHENTICATED","未登录");const body=z.object({password:z.string()}).parse(await c.req.json());if(!(await verifyPassword(user.passwordHash,body.password)))throw fail("UNAUTHENTICATED","密码不正确");const owned=(await db.select().from(workspaces).where(eq(workspaces.ownerId,user.id))).filter(w=>w.kind!=="personal");if(owned.length)throw fail("VALIDATION",`请先转让或删除这些工作区：${owned.map(w=>w.name).join("、")}`);if(user.roleInstance==="admin"){const admins=(await db.select().from(users).where(eq(users.roleInstance,"admin"))).filter(u=>u.status==="active");if(admins.length<=1)throw fail("FORBIDDEN","最后一个实例管理员不能注销");}const now=new Date(),scheduled=new Date(Date.now()+7*86400000);await db.transaction(async tx=>{await tx.update(users).set({status:"pending_deletion",deletionRequestedAt:now,deletionScheduledAt:scheduled,updatedAt:now}).where(eq(users.id,user.id));await tx.update(mcpTokens).set({status:"revoked"}).where(eq(mcpTokens.userId,user.id));await tx.insert(backgroundJobs).values({type:"delete_user",payload:{userId:user.id},runAfter:scheduled});});await clearSession(c);return ok(c,{scheduledAt:scheduled});});
auth.post("/account/cancel-deletion",async c=>{const user=await currentUser(c);if(!user)throw fail("UNAUTHENTICATED","未登录");if(user.status!=="pending_deletion")throw fail("VALIDATION","账号未处于注销宽限期");await db.update(users).set({status:"active",deletionRequestedAt:null,deletionScheduledAt:null,updatedAt:new Date()}).where(eq(users.id,user.id));return ok(c,{});});

auth.post("/auth/logout", async (c) => {
  await clearSession(c);
  return ok(c, {});
});

auth.get("/me", async (c) => {
  const user = await currentUser(c);
  if (!user) throw fail("UNAUTHENTICATED", "未登录");
  const { workspaces } = await import("../db/schema.ts");
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.personalUserId, user.id));
  const storage = await userStorage(user.id);
  return ok(c, {
    id: user.id,
    email: user.email,
    handle: user.handle,
    displayName: user.displayName,
    instanceRole: user.roleInstance,
    appearance: user.appearance,
    themeId: user.themeId,
    accent: user.accent,
    status:user.status,
    deletionScheduledAt:user.deletionScheduledAt,
    personalWorkspaceId: ws?.id ?? null,
    storage,
  });
});
