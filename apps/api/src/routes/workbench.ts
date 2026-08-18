import { Hono } from "hono";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { noteFavorites, notes, noteVisits, users } from "../db/schema.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";
import { noteAccess } from "../lib/note-access.ts";

export const workbenchRoutes = new Hono();
const RECENT_KEEP = 50;
const PRESENCE_WINDOW = 60_000;                 // 心跳 20 秒一次，60 秒内算还在看

async function requireUser(c: Parameters<typeof currentUser>[0]) {
  const user = await currentUser(c);
  if (!user) throw fail("UNAUTHENTICATED", "未登录");
  return user;
}
/** 逐条过 ACL：收藏或最近里的笔记可能已经被移出权限或删掉。 */
async function visible(ids: string[], userId: string) {
  const rows = ids.length ? await db.select().from(notes).where(and(inArray(notes.id, ids), isNull(notes.trashedAt))) : [];
  const out = [];
  for (const n of rows) { try { await noteAccess(n.id, userId, "read"); out.push(n); } catch { /* 看不到就当没有 */ } }
  return out;
}
const brief = (n: typeof notes.$inferSelect) => ({ id: n.id, title: n.title, workspaceId: n.workspaceId, notebookId: n.notebookId, updatedAt: n.updatedAt });

workbenchRoutes.get("/me/favorites", async c => {
  const user = await requireUser(c);
  const rows = await db.select().from(noteFavorites).where(eq(noteFavorites.userId, user.id)).orderBy(desc(noteFavorites.createdAt));
  const live = await visible(rows.map(r => r.noteId), user.id);
  return ok(c, { notes: rows.map(r => live.find(n => n.id === r.noteId)).filter(Boolean).map(n => brief(n!)) });
});

workbenchRoutes.put("/notes/:id/favorite", async c => {
  const user = await requireUser(c);
  const { note } = await noteAccess(c.req.param("id"), user.id, "read");
  await db.insert(noteFavorites).values({ userId: user.id, noteId: note.id }).onConflictDoNothing();
  return ok(c, { favorited: true });
});

workbenchRoutes.delete("/notes/:id/favorite", async c => {
  const user = await requireUser(c);
  await db.delete(noteFavorites).where(and(eq(noteFavorites.userId, user.id), eq(noteFavorites.noteId, c.req.param("id"))));
  return ok(c, { favorited: false });
});

workbenchRoutes.get("/me/recent", async c => {
  const user = await requireUser(c);
  const rows = await db.select().from(noteVisits).where(eq(noteVisits.userId, user.id)).orderBy(desc(noteVisits.seenAt)).limit(RECENT_KEEP);
  const live = await visible(rows.map(r => r.noteId), user.id);
  return ok(c, { notes: rows.map(r => live.find(n => n.id === r.noteId)).filter(Boolean).map(n => brief(n!)) });
});

/** 打开笔记时调一次，之后每 20 秒再调：既写「最近」，也报「我还在看」。 */
workbenchRoutes.post("/notes/:id/visit", async c => {
  const user = await requireUser(c);
  const { note } = await noteAccess(c.req.param("id"), user.id, "read");
  const now = new Date();
  await db.insert(noteVisits).values({ userId: user.id, noteId: note.id, seenAt: now })
    .onConflictDoUpdate({ target: [noteVisits.userId, noteVisits.noteId], set: { seenAt: now } });
  const others = await db.select({ userId: noteVisits.userId }).from(noteVisits)
    .where(and(eq(noteVisits.noteId, note.id), gt(noteVisits.seenAt, new Date(Date.now() - PRESENCE_WINDOW))));
  const ids = others.map(o => o.userId).filter(id => id !== user.id);
  const people = ids.length ? await db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, ids)) : [];
  const favorited = (await db.select().from(noteFavorites).where(and(eq(noteFavorites.userId, user.id), eq(noteFavorites.noteId, note.id)))).length > 0;
  return ok(c, { viewers: people.map(p => p.displayName), favorited });
});

/** 只保留最近 50 条，多出来的定期清掉；写入路径上顺手做，免得再起一个任务。 */
workbenchRoutes.post("/me/recent/trim", async c => {
  const user = await requireUser(c);
  await db.execute(sql`DELETE FROM note_visits WHERE user_id = ${user.id} AND note_id NOT IN (SELECT note_id FROM note_visits WHERE user_id = ${user.id} ORDER BY seen_at DESC LIMIT ${RECENT_KEEP})`);
  return ok(c, {});
});
