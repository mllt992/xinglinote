import { Hono } from "hono";
import { and, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { instanceSettings, mcpTokens, moderationReviews, registrationCodes, serviceRequests, sessions, users, workspaces } from "../db/schema.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";
import { hashCode, registrationCode } from "../lib/tokens.ts";
import { assertSafeOutboundUrl } from "../lib/net-guard.ts";
import { seal } from "../lib/secrets.ts";
import { normalizeCategories } from "../lib/moderation-verdict.ts";
import { userStorageMany } from "../lib/quota.ts";
import { assignStorage, pendingOf, storageDto } from "../lib/service-requests.ts";
import { userAvatarUrl } from "../lib/user-avatar.ts";

function pageQuery(c: { req: { query: (k: string) => string | undefined } }) {
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query("pageSize") ?? 20) || 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function likeContains(raw: string | undefined) {
  const q = raw?.replace(/[%_]/g, "").trim() ?? "";
  return q ? `%${q}%` : null;
}

const externalHelpUrl = z.string().trim().max(2048).url().refine(raw => {
  const protocol = new URL(raw).protocol;
  return protocol === "http:" || protocol === "https:";
}, "帮助文档地址只支持 http 或 https");

/** 密文也别回前端，UI 只需要知道「配没配」。 */
function maskSettings(s: typeof instanceSettings.$inferSelect | undefined) {
  if (!s) return s;
  // VAPID 私钥一个字节都不该出这台机器；公钥要给前端订阅用，照常回。
  const { vapidPrivateKey, ...rest } = s;
  return { ...rest, smtpPassword: s.smtpPassword ? "••••••••" : null, moderationApiKey: s.moderationApiKey ? "••••••••" : null, vapidConfigured: !!vapidPrivateKey, moderationCategories: normalizeCategories(s.moderationCategories) };
}

function publicUser(row: typeof users.$inferSelect) {
  const { passwordHash: _, avatarSha256: __, avatarMime: ___, ...u } = row;
  return { ...u, avatarUrl: userAvatarUrl(row) };
}

export const adminRoutes = new Hono();
async function admin(c: Parameters<typeof currentUser>[0]) {
  const u = await currentUser(c);
  if (!u) throw fail("UNAUTHENTICATED", "未登录");
  if (u.roleInstance !== "admin") throw fail("FORBIDDEN", "仅实例管理员可操作");
  return u;
}

adminRoutes.get("/admin/overview", async c => {
  await admin(c);
  const [{ value: userCount }] = await db.select({ value: count() }).from(users);
  const [{ value: workspaceCount }] = await db.select({ value: count() }).from(workspaces);
  const [{ value: adminCount }] = await db.select({ value: count() }).from(users).where(and(eq(users.roleInstance, "admin"), eq(users.status, "active")));
  const [{ value: codeCount }] = await db.select({ value: count() }).from(registrationCodes);
  const [{ value: activeCodeCount }] = await db.select({ value: count() }).from(registrationCodes).where(eq(registrationCodes.status, "active"));
  const [{ value: pendingModerationCount }] = await db.select({ value: count() }).from(moderationReviews).where(eq(moderationReviews.status, "pending"));
  const [{ value: pendingServiceRequestCount }] = await db.select({ value: count() }).from(serviceRequests).where(eq(serviceRequests.status, "pending"));
  const recent = await db.select().from(users).orderBy(desc(users.createdAt)).limit(6);
  const [settings] = await db.select().from(instanceSettings);
  return ok(c, {
    userCount, workspaceCount, adminCount, codeCount, activeCodeCount, pendingModerationCount, pendingServiceRequestCount,
    recentUsers: recent.map(publicUser),
    settings: maskSettings(settings),
  });
});
adminRoutes.patch("/admin/settings", async c => {
  await admin(c);
  const body = z.object({ allowOpenRegistration: z.boolean().optional(), allowCodeRegistration: z.boolean().optional(), requireEmailVerification: z.boolean().optional(), allowUserCreateWorkspace: z.boolean().optional(), squareEnabled: z.boolean().optional(), aiEnabled: z.boolean().optional(), defaultUserStorageBytes: z.number().int().min(1048576).max(1099511627776).optional(), allowStorageRequests: z.boolean().optional(),
    mcpImageMaxBytes: z.number().int().min(262144).max(26214400).optional(), smtpHost:z.string().nullable().optional(),smtpPort:z.number().int().min(1).max(65535).nullable().optional(),smtpUser:z.string().nullable().optional(),smtpPassword:z.string().nullable().optional(),smtpFrom:z.string().nullable().optional(),smtpSecure:z.boolean().optional(),
    moderationEnabled: z.boolean().optional(), moderationSquare: z.boolean().optional(), moderationCircle: z.boolean().optional(), moderationArticle: z.boolean().optional(),
    moderationBaseUrl: z.string().url().nullable().optional(), moderationModel: z.string().max(120).nullable().optional(), moderationApiKey: z.string().max(400).nullable().optional(),
    moderationRules: z.string().max(4000).nullable().optional(),
    moderationCategories: z.array(z.union([
      z.string().min(1).max(40),
      z.object({ key: z.string().min(1).max(40), label: z.string().min(1).max(40) }),
    ])).max(30).optional(),
    moderationThreshold: z.number().int().min(1).max(100).optional(), moderationOnError: z.enum(["pass", "review"]).optional(),
    pushEnabled: z.boolean().optional(), vapidSubject: z.string().max(200).nullable().optional(),
    navEnabled: z.boolean().optional(), navPublic: z.boolean().optional(),
    navTitle: z.string().max(20).nullable().optional(), navSubtitle: z.string().max(80).nullable().optional(),
    helpSource: z.enum(["builtin", "external"]).optional(), helpUrl: externalHelpUrl.nullable().optional(),
  }).parse(await c.req.json());
  // 前端回填的是掩码，别把 •••••••• 当成新密钥存进去。
  // 两个密钥字段都要这么处理——以前只有 moderationApiKey 有这层保护。
  const secret = (raw: string | null | undefined) =>
    raw === undefined || raw?.startsWith("••") ? undefined : raw ? seal(raw) : null;
  const key = secret(body.moderationApiKey);
  const smtpPassword = secret(body.smtpPassword);
  // 审核模型也是服务端去 fetch 的用户填地址，同样要过出站护栏
  if (body.moderationBaseUrl) await assertSafeOutboundUrl(body.moderationBaseUrl, "审核模型地址");
  if (body.helpSource === "external") {
    const [current] = await db.select({ helpUrl: instanceSettings.helpUrl }).from(instanceSettings).where(eq(instanceSettings.id, 1));
    if (!(body.helpUrl ?? current?.helpUrl)) throw fail("VALIDATION", "选择外部帮助时必须填写帮助文档地址");
  }
  const values: Record<string, unknown> = { ...body, updatedAt: new Date() };
  if (key === undefined) delete values.moderationApiKey; else values.moderationApiKey = key;
  if (smtpPassword === undefined) delete values.smtpPassword; else values.smtpPassword = smtpPassword;
  if (body.moderationCategories) values.moderationCategories = normalizeCategories(body.moderationCategories);
  if (body.navTitle !== undefined) values.navTitle = body.navTitle?.trim() || null;
  if (body.navSubtitle !== undefined) values.navSubtitle = body.navSubtitle?.trim() || null;
  if (body.helpUrl !== undefined) values.helpUrl = body.helpUrl?.trim() || null;
  const [saved] = await db.update(instanceSettings).set(values).where(eq(instanceSettings.id, 1)).returning();
  return ok(c, maskSettings(saved));
});
adminRoutes.get("/admin/users", async c => {
  await admin(c);
  const { page, pageSize, offset } = pageQuery(c);
  const like = likeContains(c.req.query("q"));
  const role = z.enum(["admin", "user"]).optional().catch(undefined).parse(c.req.query("role") || undefined);
  const status = z.enum(["active", "banned", "pending_verification", "pending_deletion"]).optional().catch(undefined).parse(c.req.query("status") || undefined);
  const hasPending = c.req.query("hasPending") === "true";
  const pendingUserIds = hasPending
    ? [...new Set((await db.select({ userId: serviceRequests.userId }).from(serviceRequests).where(eq(serviceRequests.status, "pending"))).map(r => r.userId))]
    : null;
  if (hasPending && !pendingUserIds?.length) return ok(c, { users: [], total: 0, page, pageSize });
  const where = and(
    like ? or(ilike(users.displayName, like), ilike(users.handle, like), ilike(users.email, like)) : undefined,
    role ? eq(users.roleInstance, role) : undefined,
    status ? eq(users.status, status) : undefined,
    pendingUserIds ? inArray(users.id, pendingUserIds) : undefined,
  );
  const rows = await db.select().from(users).where(where).orderBy(desc(users.createdAt)).limit(pageSize).offset(offset);
  const [{ value: total }] = await db.select({ value: count() }).from(users).where(where);
  const ids = rows.map(r => r.id);
  const [usageMap, pending] = await Promise.all([userStorageMany(ids), pendingOf(ids)]);
  const pendingBy = new Map(pending.map(p => [p.userId, p]));
  return ok(c, {
    users: rows.map(r => ({
      ...publicUser(r),
      storage: usageMap.has(r.id) ? storageDto(usageMap.get(r.id)!) : null,
      pendingRequest: pendingBy.has(r.id) ? {
        id: pendingBy.get(r.id)!.id,
        kind: pendingBy.get(r.id)!.kind,
        requestedBytes: pendingBy.get(r.id)!.requestedBytes,
        createdAt: pendingBy.get(r.id)!.createdAt,
      } : null,
    })),
    total, page, pageSize,
  });
});
adminRoutes.patch("/admin/users/:id", async c => {
  const actor = await admin(c); const id = c.req.param("id");
  const [target] = await db.select().from(users).where(eq(users.id, id)); if (!target) throw fail("NOT_FOUND", "用户不存在");
  const body = z.object({ status: z.enum(["active", "banned"]).optional(), roleInstance: z.enum(["admin", "user"]).optional(), storageQuotaBytes: z.number().int().min(1048576).max(1099511627776).nullable().optional() }).parse(await c.req.json());
  if (target.id === actor.id && (body.status === "banned" || body.roleInstance === "user")) throw fail("FORBIDDEN", "不能停用或降级当前管理员账号");
  if (target.roleInstance === "admin" && (body.roleInstance === "user" || body.status === "banned")) {
    const admins = (await db.select().from(users).where(eq(users.roleInstance, "admin"))).filter(u => u.status === "active");
    if (admins.length <= 1) throw fail("FORBIDDEN", "实例必须至少保留一个有效管理员");
  }
  if(body.status==="banned"){const owned=await db.select().from(workspaces).where(eq(workspaces.ownerId,id));const activeTeam=owned.filter(w=>w.kind!=="personal"&&!w.frozen);if(activeTeam.length)throw fail("VALIDATION","该用户仍是未冻结团队工作区的 Owner，请先转让所有权或冻结工作区");}
  const { storageQuotaBytes, ...rest } = body;
  const [saved] = await db.update(users).set({ ...rest, updatedAt: new Date() }).where(eq(users.id, id)).returning();
  if (storageQuotaBytes !== undefined) await assignStorage(actor, id, storageQuotaBytes);
  if (body.status === "banned") await db.transaction(async tx=>{await tx.delete(sessions).where(eq(sessions.userId,id));await tx.update(mcpTokens).set({status:"revoked"}).where(eq(mcpTokens.userId,id));});
  const [fresh] = await db.select().from(users).where(eq(users.id, id));
  return ok(c, publicUser(fresh ?? saved));
});
adminRoutes.post("/admin/registration-codes", async c => {
  const actor = await admin(c);
  const body = z.object({ quantity: z.number().int().min(1).max(200), maxUses: z.number().int().min(1).max(1000).default(1), expiresInDays: z.number().int().min(1).max(3650).nullable().optional(), note: z.string().max(200).optional(), bindWorkspaceId: z.string().uuid().nullable().optional(), bindRole: z.enum(["admin", "editor", "viewer"]).nullable().optional(), skipEmailVerification: z.boolean().default(false) }).parse(await c.req.json());
  const plain = Array.from({ length: body.quantity }, registrationCode);
  await db.insert(registrationCodes).values(plain.map(code => ({ codeHash: hashCode(code), codePrefix: code, maxUses: body.maxUses, expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400000) : null, note: body.note, bindWorkspaceId: body.bindWorkspaceId, bindRole: body.bindRole, skipEmailVerification: body.skipEmailVerification, createdBy: actor.id })));
  return ok(c, { codes: plain }, 201);
});
adminRoutes.get("/admin/registration-codes", async c => {
  await admin(c);
  const { page, pageSize, offset } = pageQuery(c);
  const like = likeContains(c.req.query("q"));
  const status = z.enum(["active", "revoked", "exhausted", "expired"]).optional().catch(undefined).parse(c.req.query("status") || undefined);
  const bindRole = z.enum(["admin", "editor", "viewer"]).optional().catch(undefined).parse(c.req.query("bindRole") || undefined);
  const skipRaw = c.req.query("skipEmailVerification");
  const skipEmail = skipRaw === "true" ? true : skipRaw === "false" ? false : undefined;
  const where = and(
    like ? or(ilike(registrationCodes.codePrefix, like), ilike(registrationCodes.note, like)) : undefined,
    status ? eq(registrationCodes.status, status) : undefined,
    bindRole ? eq(registrationCodes.bindRole, bindRole) : undefined,
    skipEmail === undefined ? undefined : eq(registrationCodes.skipEmailVerification, skipEmail),
  );
  const rows = await db.select().from(registrationCodes).where(where).orderBy(desc(registrationCodes.createdAt)).limit(pageSize).offset(offset);
  const [{ value: total }] = await db.select({ value: count() }).from(registrationCodes).where(where);
  return ok(c, {
    codes: rows.map(r => ({
      id: r.id, prefix: r.codePrefix.slice(0, 9), code: r.codePrefix.length >= 24 ? r.codePrefix : null, maxUses: r.maxUses, usedCount: r.usedCount, expiresAt: r.expiresAt, note: r.note,
      bindWorkspaceId: r.bindWorkspaceId, bindRole: r.bindRole, skipEmailVerification: r.skipEmailVerification, status: r.status, createdAt: r.createdAt,
    })),
    total, page, pageSize,
  });
});
adminRoutes.delete("/admin/registration-codes/:id", async c => { await admin(c); await db.update(registrationCodes).set({ status: "revoked" }).where(eq(registrationCodes.id, c.req.param("id"))); return ok(c, {}); });
