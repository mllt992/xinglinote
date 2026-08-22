import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { asc, count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { blobStore, instanceSettings, navGroups, navLinks } from "../db/schema.ts";
import { env } from "../env.ts";
import { ok } from "../http.ts";
import { putBlob, releaseBlob } from "../lib/blobs.ts";
import { fetchSiteIcon, parseNavUrl } from "../lib/nav-icon.ts";
import { limit } from "../lib/rate-limit.ts";
import { currentUser } from "../lib/session.ts";

const TITLE_GROUP = z.string().trim().min(1, "请填写分组名").max(24);
const TITLE_LINK = z.string().trim().min(1, "请填写名称").max(40);
const DESC = z.string().trim().max(120).optional().nullable();
const SHA = z.string().regex(/^[a-f0-9]{64}$/);

const MAX_GROUPS = 30;
const MAX_LINKS = 400;
const MAX_PER_GROUP = 80;

export const navRoutes = new Hono();

async function adminOf(c: Parameters<typeof currentUser>[0]) {
  const u = await currentUser(c);
  if (!u) throw fail("UNAUTHENTICATED", "未登录");
  if (u.roleInstance !== "admin") throw fail("FORBIDDEN", "仅实例管理员可操作");
  return u;
}

async function settingsRow() {
  const [row] = await db.select().from(instanceSettings).limit(1);
  return row;
}

function linkDto(row: typeof navLinks.$inferSelect) {
  return {
    id: row.id,
    groupId: row.groupId,
    title: row.title,
    url: row.url,
    description: row.description,
    iconUrl: row.iconSha256 ? `/api/v1/nav/icons/${row.iconSha256}` : null,
    sortKey: row.sortKey,
  };
}

async function catalog() {
  const groups = await db.select().from(navGroups).orderBy(asc(navGroups.sortKey), asc(navGroups.createdAt));
  const links = await db.select().from(navLinks).orderBy(asc(navLinks.sortKey), asc(navLinks.createdAt));
  const byGroup = new Map<string, typeof links>();
  for (const link of links) {
    const list = byGroup.get(link.groupId) ?? [];
    list.push(link);
    byGroup.set(link.groupId, list);
  }
  return groups.map(g => ({
    id: g.id,
    title: g.title,
    description: g.description,
    sortKey: g.sortKey,
    links: (byGroup.get(g.id) ?? []).map(linkDto),
  }));
}

function heading(s: Awaited<ReturnType<typeof settingsRow>>) {
  return {
    enabled: s?.navEnabled ?? true,
    public: s?.navPublic ?? true,
    title: s?.navTitle?.trim() || "导航",
    subtitle: s?.navSubtitle?.trim() || "实例里的常用去处。点开即走。",
  };
}

navRoutes.get("/nav", async c => {
  const s = await settingsRow();
  const head = heading(s);
  if (!head.enabled) return ok(c, { ...head, groups: [] });
  if (!head.public) {
    const u = await currentUser(c);
    if (!u) throw fail("UNAUTHENTICATED", "请先登录");
  }
  return ok(c, { ...head, groups: await catalog() });
});

navRoutes.get("/nav/icons/:sha256", async c => {
  const sha256 = c.req.param("sha256");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw fail("NOT_FOUND", "图标不存在");
  const [used] = await db.select({ id: navLinks.id, mime: navLinks.iconMime }).from(navLinks).where(eq(navLinks.iconSha256, sha256)).limit(1);
  if (!used) {
    const u = await currentUser(c);
    if (u?.roleInstance !== "admin") throw fail("NOT_FOUND", "图标不存在");
  }
  const [blob] = await db.select().from(blobStore).where(eq(blobStore.sha256, sha256)).limit(1);
  if (!blob) throw fail("NOT_FOUND", "图标不存在");
  const bytes = await readFile(join(env.dataDir, blob.path));
  c.header("Content-Type", used?.mime || "image/png");
  c.header("Cache-Control", "public, max-age=86400");
  c.header("X-Content-Type-Options", "nosniff");
  return c.body(bytes);
});

navRoutes.get("/admin/nav", async c => {
  await adminOf(c);
  const s = await settingsRow();
  return ok(c, { ...heading(s), groups: await catalog() });
});

navRoutes.post("/admin/nav/groups", async c => {
  await adminOf(c);
  const body = z.object({ title: TITLE_GROUP, description: DESC }).parse(await c.req.json());
  const [{ value: total }] = await db.select({ value: count() }).from(navGroups);
  if (total >= MAX_GROUPS) throw fail("VALIDATION", `分组最多 ${MAX_GROUPS} 个`);
  const [last] = await db.select({ sortKey: navGroups.sortKey }).from(navGroups).orderBy(desc(navGroups.sortKey)).limit(1);
  const [row] = await db.insert(navGroups).values({
    title: body.title,
    description: body.description ?? null,
    sortKey: (last?.sortKey ?? 0) + 10,
  }).returning();
  return ok(c, { id: row.id, title: row.title, description: row.description, sortKey: row.sortKey, links: [] }, 201);
});

navRoutes.patch("/admin/nav/groups/:id", async c => {
  await adminOf(c);
  const id = c.req.param("id");
  const [cur] = await db.select().from(navGroups).where(eq(navGroups.id, id));
  if (!cur) throw fail("NOT_FOUND", "分组不存在");
  const body = z.object({ title: TITLE_GROUP.optional(), description: DESC }).parse(await c.req.json());
  const [saved] = await db.update(navGroups).set({
    title: body.title ?? cur.title,
    description: body.description === undefined ? cur.description : body.description,
    updatedAt: new Date(),
  }).where(eq(navGroups.id, id)).returning();
  return ok(c, { id: saved.id, title: saved.title, description: saved.description, sortKey: saved.sortKey });
});

navRoutes.delete("/admin/nav/groups/:id", async c => {
  await adminOf(c);
  const id = c.req.param("id");
  const [cur] = await db.select().from(navGroups).where(eq(navGroups.id, id));
  if (!cur) throw fail("NOT_FOUND", "分组不存在");
  const links = await db.select().from(navLinks).where(eq(navLinks.groupId, id));
  await db.delete(navGroups).where(eq(navGroups.id, id));
  for (const link of links) if (link.iconSha256) await releaseBlob(link.iconSha256);
  return ok(c, {});
});

async function takeIcon(url: string, fetchIcon: boolean, existing?: { sha256: string | null; mime: string | null }) {
  if (!fetchIcon) return { sha256: existing?.sha256 ?? null, mime: existing?.mime ?? null };
  const parsed = parseNavUrl(url);
  if (parsed.kind !== "external") return { sha256: null, mime: null };
  const icon = await fetchSiteIcon(parsed.href);
  if (!icon) return { sha256: existing?.sha256 ?? null, mime: existing?.mime ?? null };
  const blob = await putBlob(icon.bytes);
  if (existing?.sha256 && existing.sha256 !== blob.sha256) await releaseBlob(existing.sha256);
  return { sha256: blob.sha256, mime: icon.mime };
}

navRoutes.post("/admin/nav/links", async c => {
  const actor = await adminOf(c);
  const body = z.object({
    groupId: z.string().uuid(),
    title: TITLE_LINK,
    url: z.string().min(1).max(2000),
    description: DESC,
    iconSha256: SHA.optional().nullable(),
    iconMime: z.string().max(40).optional().nullable(),
    fetchIcon: z.boolean().optional(),
  }).parse(await c.req.json());
  const [group] = await db.select().from(navGroups).where(eq(navGroups.id, body.groupId));
  if (!group) throw fail("NOT_FOUND", "分组不存在");
  const [{ value: total }] = await db.select({ value: count() }).from(navLinks);
  if (total >= MAX_LINKS) throw fail("VALIDATION", `站点最多 ${MAX_LINKS} 个`);
  const [{ value: inGroup }] = await db.select({ value: count() }).from(navLinks).where(eq(navLinks.groupId, group.id));
  if (inGroup >= MAX_PER_GROUP) throw fail("VALIDATION", `每个分组最多 ${MAX_PER_GROUP} 个站点`);
  const parsed = parseNavUrl(body.url);
  const [last] = await db.select({ sortKey: navLinks.sortKey }).from(navLinks).where(eq(navLinks.groupId, group.id)).orderBy(desc(navLinks.sortKey)).limit(1);
  const sortKey = (last?.sortKey ?? 0) + 10;

  let iconSha256 = body.iconSha256 ?? null;
  let iconMime = body.iconMime ?? null;
  if (iconSha256) {
    const [blob] = await db.select().from(blobStore).where(eq(blobStore.sha256, iconSha256));
    if (!blob) throw fail("VALIDATION", "图标不存在，请重新获取");
  } else {
    const got = await takeIcon(parsed.href, body.fetchIcon !== false);
    iconSha256 = got.sha256;
    iconMime = got.mime;
  }

  const [row] = await db.insert(navLinks).values({
    groupId: group.id,
    title: body.title,
    url: parsed.href,
    description: body.description ?? null,
    iconSha256,
    iconMime,
    sortKey,
    createdBy: actor.id,
  }).returning();
  return ok(c, linkDto(row), 201);
});

navRoutes.patch("/admin/nav/links/:id", async c => {
  await adminOf(c);
  const id = c.req.param("id");
  const [cur] = await db.select().from(navLinks).where(eq(navLinks.id, id));
  if (!cur) throw fail("NOT_FOUND", "站点不存在");
  const body = z.object({
    groupId: z.string().uuid().optional(),
    title: TITLE_LINK.optional(),
    url: z.string().min(1).max(2000).optional(),
    description: DESC,
    iconSha256: SHA.optional().nullable(),
    iconMime: z.string().max(40).optional().nullable(),
    fetchIcon: z.boolean().optional(),
  }).parse(await c.req.json());

  let groupId = cur.groupId;
  if (body.groupId && body.groupId !== cur.groupId) {
    const [group] = await db.select().from(navGroups).where(eq(navGroups.id, body.groupId));
    if (!group) throw fail("NOT_FOUND", "分组不存在");
    const [{ value: inGroup }] = await db.select({ value: count() }).from(navLinks).where(eq(navLinks.groupId, group.id));
    if (inGroup >= MAX_PER_GROUP) throw fail("VALIDATION", `每个分组最多 ${MAX_PER_GROUP} 个站点`);
    groupId = group.id;
  }

  const url = body.url !== undefined ? parseNavUrl(body.url).href : cur.url;
  let iconSha256 = cur.iconSha256;
  let iconMime = cur.iconMime;
  if (body.iconSha256 !== undefined) {
    if (body.iconSha256) {
      const [blob] = await db.select().from(blobStore).where(eq(blobStore.sha256, body.iconSha256));
      if (!blob) throw fail("VALIDATION", "图标不存在，请重新获取");
    }
    if (cur.iconSha256 && cur.iconSha256 !== body.iconSha256) await releaseBlob(cur.iconSha256);
    iconSha256 = body.iconSha256;
    iconMime = body.iconMime ?? (body.iconSha256 === cur.iconSha256 ? cur.iconMime : null);
  } else if (body.fetchIcon) {
    const got = await takeIcon(url, true, { sha256: cur.iconSha256, mime: cur.iconMime });
    iconSha256 = got.sha256;
    iconMime = got.mime;
  }

  const [saved] = await db.update(navLinks).set({
    groupId,
    title: body.title ?? cur.title,
    url,
    description: body.description === undefined ? cur.description : body.description,
    iconSha256,
    iconMime,
    updatedAt: new Date(),
  }).where(eq(navLinks.id, id)).returning();
  return ok(c, linkDto(saved));
});

navRoutes.delete("/admin/nav/links/:id", async c => {
  await adminOf(c);
  const [cur] = await db.select().from(navLinks).where(eq(navLinks.id, c.req.param("id")));
  if (!cur) throw fail("NOT_FOUND", "站点不存在");
  await db.delete(navLinks).where(eq(navLinks.id, cur.id));
  if (cur.iconSha256) await releaseBlob(cur.iconSha256);
  return ok(c, {});
});

navRoutes.post("/admin/nav/reorder", async c => {
  await adminOf(c);
  const body = z.object({
    groups: z.array(z.object({ id: z.string().uuid(), sortKey: z.number().int().min(0).max(100000) })).max(MAX_GROUPS).optional(),
    links: z.array(z.object({
      id: z.string().uuid(),
      groupId: z.string().uuid().optional(),
      sortKey: z.number().int().min(0).max(100000),
    })).max(MAX_LINKS).optional(),
  }).parse(await c.req.json());

  if (body.groups) {
    for (const g of body.groups) {
      await db.update(navGroups).set({ sortKey: g.sortKey, updatedAt: new Date() }).where(eq(navGroups.id, g.id));
    }
  }
  if (body.links) {
    for (const l of body.links) {
      const patch: { sortKey: number; groupId?: string; updatedAt: Date } = { sortKey: l.sortKey, updatedAt: new Date() };
      if (l.groupId) patch.groupId = l.groupId;
      await db.update(navLinks).set(patch).where(eq(navLinks.id, l.id));
    }
  }
  return ok(c, { groups: await catalog() });
});

navRoutes.post("/admin/nav/favicon", async c => {
  const actor = await adminOf(c);
  limit(`nav-favicon:${actor.id}`, 20, 600_000);
  const body = z.object({ url: z.string().min(1).max(2000) }).parse(await c.req.json());
  const parsed = parseNavUrl(body.url);
  if (parsed.kind !== "external") return ok(c, { sha256: null, mime: null });
  const icon = await fetchSiteIcon(parsed.href);
  if (!icon) return ok(c, { sha256: null, mime: null });
  const blob = await putBlob(icon.bytes);
  return ok(c, { sha256: blob.sha256, mime: icon.mime });
});
