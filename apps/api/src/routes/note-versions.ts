import { Hono } from "hono";
import { and, count, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { noteVersions } from "../db/schema.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";
import { noteAccess } from "../lib/note-access.ts";

/**
 * 历史版本的改名 / 删除 / 列表（含 name）。
 * 挂在 knowledge 前面，这样 GET 列表会带上自定义名字；
 * 恢复仍走 notes.ts 里原来的 POST .../restore。
 * 删除只去掉 note_versions 行，绝不碰 notes。
 */
export const noteVersionRoutes = new Hono();

async function requireUser(c: Parameters<typeof currentUser>[0]) {
  const user = await currentUser(c);
  if (!user) throw fail("UNAUTHENTICATED", "未登录");
  return user;
}

function versionDto(v: { id: string; version: number; name: string | null; title: string; bodyMd: string; source: string; createdAt: Date }) {
  return { id: v.id, version: v.version, name: v.name, title: v.title, bodyMd: v.bodyMd, source: v.source, createdAt: v.createdAt };
}

noteVersionRoutes.get("/notes/:id/versions", async (c) => {
  const user = await requireUser(c);
  const { note } = await noteAccess(c.req.param("id"), user.id, "read");
  const [{ value: total }] = await db.select({ value: count() }).from(noteVersions).where(eq(noteVersions.noteId, note.id));
  const recent = await db.select().from(noteVersions).where(eq(noteVersions.noteId, note.id)).orderBy(desc(noteVersions.version)).limit(100);
  const named = await db.select().from(noteVersions).where(and(eq(noteVersions.noteId, note.id), isNotNull(noteVersions.name)));
  const byId = new Map(recent.map(v => [v.id, v]));
  for (const v of named) if (v.name?.trim()) byId.set(v.id, v);
  const rows = [...byId.values()].sort((a, b) => b.version - a.version);
  return ok(c, { total, versions: rows.map(versionDto) });
});

noteVersionRoutes.patch("/notes/:id/versions/:version", async (c) => {
  const user = await requireUser(c);
  const { note } = await noteAccess(c.req.param("id"), user.id, "edit");
  const version = Number(c.req.param("version"));
  if (!Number.isInteger(version) || version < 1) throw fail("VALIDATION", "版本号无效");
  const body = z.object({ name: z.string().max(80) }).parse(await c.req.json());
  const name = body.name.trim() ? body.name.trim() : null;
  const [row] = await db.select().from(noteVersions).where(and(eq(noteVersions.noteId, note.id), eq(noteVersions.version, version)));
  if (!row) throw fail("NOT_FOUND", "版本不存在");
  const [saved] = await db.update(noteVersions).set({ name }).where(eq(noteVersions.id, row.id)).returning();
  return ok(c, versionDto(saved));
});

noteVersionRoutes.delete("/notes/:id/versions/:version", async (c) => {
  const user = await requireUser(c);
  const { note } = await noteAccess(c.req.param("id"), user.id, "edit");
  const version = Number(c.req.param("version"));
  if (!Number.isInteger(version) || version < 1) throw fail("VALIDATION", "版本号无效");
  const [row] = await db.select({ id: noteVersions.id }).from(noteVersions).where(and(eq(noteVersions.noteId, note.id), eq(noteVersions.version, version)));
  if (!row) throw fail("NOT_FOUND", "版本不存在");
  // 只删历史行，绝不碰 notes：当前正文活在 notes.body_md，不在 note_versions。
  await db.delete(noteVersions).where(eq(noteVersions.id, row.id));
  return ok(c, {});
});
