import { Hono } from "hono";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { auditLogs, mcpTokens, notes, users, workspaceInvites, workspaceMembers, workspaces } from "../db/schema.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";
import { secureToken, tokenHash } from "../lib/tokens.ts";
import { memberRole,migratePrivateNotebooks } from "../lib/workspace.ts";

export const memberRoutes = new Hono();
async function userRequired(c: Parameters<typeof currentUser>[0]) { const u = await currentUser(c); if (!u) throw fail("UNAUTHENTICATED", "未登录"); return u; }
async function manage(c: Parameters<typeof currentUser>[0], wsId: string) { const u = await userRequired(c); const role = await memberRole(wsId, u.id); if (role !== "owner" && role !== "admin") throw fail("FORBIDDEN", "只有工作区管理员可管理成员"); return u; }

memberRoutes.get("/workspaces/:id/members", async c => {
  const u = await userRequired(c); const wsId = c.req.param("id"); if (!(await memberRole(wsId, u.id))) throw fail("FORBIDDEN", "不是工作区成员");
  const rows = await db.select({ userId: users.id, handle: users.handle, displayName: users.displayName, email: users.email, status: users.status, role: workspaceMembers.role, joinedAt: workspaceMembers.createdAt }).from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId)).where(eq(workspaceMembers.workspaceId, wsId));
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
  // 成员页要显示「谁写得最多」，一次 group by 拿全，别让前端按人再查一轮。
  const authored = rows.length ? await db.select({ userId: notes.createdBy, value: count() }).from(notes).where(and(eq(notes.workspaceId, wsId), isNull(notes.trashedAt), inArray(notes.createdBy, rows.map(r => r.userId)))).groupBy(notes.createdBy) : [];
  const role = await memberRole(wsId, u.id);
  return ok(c, {
    kind: ws?.kind, ownerId: ws?.ownerId, frozen: ws?.frozen ?? false, myRole: role, canManage: role === "owner" || role === "admin", myUserId: u.id,
    members: rows.map(m => ({ ...m, noteCount: authored.find(a => a.userId === m.userId)?.value ?? 0 })),
  });
});
memberRoutes.post("/workspaces/:id/members", async c => {
  await manage(c, c.req.param("id")); const wsId = c.req.param("id"); const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, wsId)); if (!ws) throw fail("NOT_FOUND", "工作区不存在"); if (ws.kind === "personal") throw fail("FORBIDDEN", "个人工作区不能添加成员");
  const body = z.object({ handle: z.string(), role: z.enum(["admin", "editor", "viewer"]) }).parse(await c.req.json()); const [target] = await db.select().from(users).where(eq(users.handle, body.handle)); if (!target || target.status !== "active") throw fail("NOT_FOUND", "未找到可添加的用户");
  await db.insert(workspaceMembers).values({ workspaceId: wsId, userId: target.id, role: body.role }).onConflictDoUpdate({ target: [workspaceMembers.workspaceId, workspaceMembers.userId], set: { role: body.role } }); return ok(c, {});
});
memberRoutes.patch("/workspaces/:id/members/:userId", async c => {
  const actor = await manage(c, c.req.param("id")); const wsId = c.req.param("id"), userId = c.req.param("userId"); const body = z.object({ role: z.enum(["admin", "editor", "viewer"]) }).parse(await c.req.json()); const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, wsId)); if (!ws) throw fail("NOT_FOUND", "工作区不存在"); if (userId === ws.ownerId) throw fail("FORBIDDEN", "请先转让工作区所有权"); if (actor.id === userId && body.role === "viewer") throw fail("FORBIDDEN", "不能把自己降为只读成员"); await db.update(workspaceMembers).set({ role: body.role }).where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, userId))); return ok(c, {});
});
memberRoutes.post("/workspaces/:id/transfer",async c=>{const actor=await userRequired(c);const wsId=c.req.param("id");const body=z.object({newOwnerUserId:z.string().uuid()}).parse(await c.req.json());const [ws]=await db.select().from(workspaces).where(eq(workspaces.id,wsId));if(!ws)throw fail("NOT_FOUND","工作区不存在");if(ws.kind==="personal")throw fail("FORBIDDEN","个人工作区不能转让");if(ws.ownerId!==actor.id)throw fail("FORBIDDEN","只有当前 Owner 可以转让");if(body.newOwnerUserId===actor.id)throw fail("VALIDATION","新 Owner 不能是自己");const [target]=await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId,wsId),eq(workspaceMembers.userId,body.newOwnerUserId)));if(!target)throw fail("VALIDATION","新 Owner 必须已经是工作区成员");await db.transaction(async tx=>{await tx.update(workspaceMembers).set({role:"admin"}).where(and(eq(workspaceMembers.workspaceId,wsId),eq(workspaceMembers.userId,actor.id)));await tx.update(workspaceMembers).set({role:"owner"}).where(and(eq(workspaceMembers.workspaceId,wsId),eq(workspaceMembers.userId,body.newOwnerUserId)));await tx.update(workspaces).set({ownerId:body.newOwnerUserId}).where(eq(workspaces.id,wsId));});return ok(c,{ownerId:body.newOwnerUserId});});

memberRoutes.delete("/workspaces/:id/members/:userId", async c => {
  const actor = await manage(c, c.req.param("id")); const wsId = c.req.param("id"), userId = c.req.param("userId"); const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, wsId)); if (!ws) throw fail("NOT_FOUND", "工作区不存在"); if (ws.kind === "personal" || userId === ws.ownerId) throw fail("FORBIDDEN", "不能移除个人工作区或工作区 Owner"); if (actor.id === userId) throw fail("FORBIDDEN", "管理员不能在成员页移除自己"); const migratedNotebooks=await migratePrivateNotebooks(userId,wsId);await db.transaction(async tx=>{await tx.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, userId)));await tx.update(mcpTokens).set({status:"revoked"}).where(and(eq(mcpTokens.workspaceId,wsId),eq(mcpTokens.userId,userId)));await tx.update(workspaceInvites).set({status:"revoked"}).where(and(eq(workspaceInvites.workspaceId,wsId),eq(workspaceInvites.createdBy,userId),eq(workspaceInvites.status,"active")));}); return ok(c, {migratedNotebooks});
});
memberRoutes.post("/workspaces/:id/invites", async c => {
  const actor = await manage(c, c.req.param("id")); const wsId = c.req.param("id"); const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, wsId)); if (!ws || ws.kind === "personal") throw fail("FORBIDDEN", "个人工作区不能邀请成员"); const body = z.object({ role: z.enum(["admin", "editor", "viewer"]), expiresInDays: z.number().int().min(1).max(90).default(7), maxUses: z.number().int().min(1).max(100).nullable().default(1) }).parse(await c.req.json()); const token = secureToken(); const [invite] = await db.insert(workspaceInvites).values({ tokenHash: tokenHash(token), tokenPrefix: token.slice(0, 8), workspaceId: wsId, role: body.role, expiresAt: new Date(Date.now() + body.expiresInDays * 86400000), maxUses: body.maxUses, createdBy: actor.id }).returning(); return ok(c, { id: invite.id, token, url: `/invite/${token}` }, 201);
});
memberRoutes.get("/invites/:token", async c => { const [i] = await db.select().from(workspaceInvites).where(eq(workspaceInvites.tokenHash, tokenHash(c.req.param("token")))); if (!i || i.status !== "active" || i.expiresAt.getTime() <= Date.now() || (i.maxUses && i.usedCount >= i.maxUses)) throw fail("NOT_FOUND", "邀请不存在或已失效"); const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, i.workspaceId)); return ok(c, { workspace: ws?.name, role: i.role, expiresAt: i.expiresAt }); });
memberRoutes.post("/invites/:token/accept", async c => { const u = await userRequired(c);const hash=tokenHash(c.req.param("token"));const workspaceId=await db.transaction(async tx=>{const [i]=await tx.select().from(workspaceInvites).where(eq(workspaceInvites.tokenHash,hash)).for("update");if(!i||i.status!=="active"||i.expiresAt.getTime()<=Date.now()||(i.maxUses&&i.usedCount>=i.maxUses))throw fail("NOT_FOUND","邀请不存在或已失效");const[ws]=await tx.select().from(workspaces).where(eq(workspaces.id,i.workspaceId));if(!ws||ws.kind==="personal")throw fail("NOT_FOUND","工作区不存在");const existing=await tx.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId,ws.id),eq(workspaceMembers.userId,u.id)));if(!existing.length){await tx.insert(workspaceMembers).values({workspaceId:ws.id,userId:u.id,role:i.role});const used=i.usedCount+1;await tx.update(workspaceInvites).set({usedCount:used,status:i.maxUses&&used>=i.maxUses?"exhausted":"active"}).where(eq(workspaceInvites.id,i.id));}return ws.id;});return ok(c,{workspaceId}); });

/** 邀请链接列表：明文 token 只在创建那一刻返回一次，这里只能给前缀，用来对上是哪一条。 */
memberRoutes.get("/workspaces/:id/invites", async c => {
  await manage(c, c.req.param("id")); const wsId = c.req.param("id");
  const rows = await db.select({ id: workspaceInvites.id, tokenPrefix: workspaceInvites.tokenPrefix, role: workspaceInvites.role, expiresAt: workspaceInvites.expiresAt, maxUses: workspaceInvites.maxUses, usedCount: workspaceInvites.usedCount, status: workspaceInvites.status, createdAt: workspaceInvites.createdAt, createdByName: users.displayName }).from(workspaceInvites).innerJoin(users, eq(users.id, workspaceInvites.createdBy)).where(eq(workspaceInvites.workspaceId, wsId));
  const now = Date.now();
  const invites = rows
    .map(i => ({ ...i, status: i.status === "active" && i.expiresAt.getTime() <= now ? "expired" : i.status }))
    .sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) || b.createdAt.getTime() - a.createdAt.getTime());
  return ok(c, { invites });
});

/** 作废一条邀请：链接立刻打不开，已经用它进来的人不受影响。 */
memberRoutes.delete("/invites/:id", async c => {
  const u = await userRequired(c); const id = c.req.param("id");
  const [invite] = await db.select().from(workspaceInvites).where(eq(workspaceInvites.id, id));
  if (!invite) throw fail("NOT_FOUND", "邀请不存在");
  const role = await memberRole(invite.workspaceId, u.id);
  if (role !== "owner" && role !== "admin") throw fail("FORBIDDEN", "只有工作区管理员可作废邀请");
  if (invite.status !== "active") throw fail("VALIDATION", "这条邀请已经失效了");
  await db.update(workspaceInvites).set({ status: "revoked" }).where(eq(workspaceInvites.id, id));
  await db.insert(auditLogs).values({ userId: u.id, workspaceId: invite.workspaceId, actorType: "user", action: "workspace.invite_revoke", targetType: "invite", targetId: invite.id, result: "ok", details: { role: invite.role } });
  return ok(c, {});
});

/**
 * 主动退出工作区。管理员在成员页移不掉自己（那是别人的操作），但本人得有出口，
 * 否则「被加进来」就成了单向门。私密笔记本按移除成员的同一条规则迁回个人库。
 */
memberRoutes.post("/workspaces/:id/leave", async c => {
  const u = await userRequired(c); const wsId = c.req.param("id");
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
  if (!ws) throw fail("NOT_FOUND", "工作区不存在");
  if (ws.kind === "personal") throw fail("FORBIDDEN", "个人工作区不能退出");
  const role = await memberRole(wsId, u.id);
  if (!role) throw fail("FORBIDDEN", "不是工作区成员");
  if (role === "owner") throw fail("FORBIDDEN", "Owner 请先把工作区转让给别人，再退出");
  const migratedNotebooks = await migratePrivateNotebooks(u.id, wsId);
  await db.transaction(async tx => {
    await tx.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, u.id)));
    await tx.update(mcpTokens).set({ status: "revoked" }).where(and(eq(mcpTokens.workspaceId, wsId), eq(mcpTokens.userId, u.id)));
    await tx.update(workspaceInvites).set({ status: "revoked" }).where(and(eq(workspaceInvites.workspaceId, wsId), eq(workspaceInvites.createdBy, u.id), eq(workspaceInvites.status, "active")));
    await tx.insert(auditLogs).values({ userId: u.id, workspaceId: wsId, actorType: "user", action: "workspace.member_leave", result: "ok", details: { role } });
  });
  return ok(c, { migratedNotebooks });
});
