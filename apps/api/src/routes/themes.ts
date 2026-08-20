import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  BUILTIN_THEME_ID,
  HEX_RE,
  compareSemver,
  fail,
  resolveTheme,
  type Appearance,
  type ThemeManifest,
  validateManifest,
} from "@kb/shared";
import { db } from "../db/client.ts";
import { instanceSettings, themes, users } from "../db/schema.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";

export const themeRoutes = new Hono();

themeRoutes.get("/themes", async (c) => {
  const list = await db.select().from(themes);
  return ok(c, {
    themes: list.map((t) => ({
      id: t.id,
      name: t.name,
      author: t.author,
      version: t.version,
      builtin: t.builtin,
      description: t.description,
    })),
  });
});

themeRoutes.get("/theme/resolved", async (c) => {
  const systemDark = c.req.query("dark") === "1";
  const user = await currentUser(c);
  const [settings] = await db.select().from(instanceSettings);
  const themeId = user?.themeId ?? settings?.defaultThemeId ?? BUILTIN_THEME_ID;
  const appearance = (user?.appearance ?? "system") as Appearance;
  const accent = user?.accent ?? settings?.defaultAccent ?? null;
  const [row] = await db.select().from(themes).where(eq(themes.id, themeId));
  const fallback = await db.select().from(themes).where(eq(themes.id, BUILTIN_THEME_ID));
  const manifest = (row?.manifest ?? fallback[0]?.manifest) as ThemeManifest;
  return ok(c, resolveTheme(manifest, appearance, systemDark, accent));
});

themeRoutes.patch("/me/appearance", async (c) => {
  const user = await currentUser(c);
  if (!user) throw fail("UNAUTHENTICATED", "未登录");
  const body = z
    .object({
      appearance: z.enum(["system", "light", "dark"]).optional(),
      themeId: z.string().optional(),
      accent: z.string().nullable().optional(),
    })
    .parse(await c.req.json());
  if (body.accent && !HEX_RE.test(body.accent)) throw fail("VALIDATION", "accent 必须是 hex");
  if (body.themeId) {
    const [t] = await db.select().from(themes).where(eq(themes.id, body.themeId));
    if (!t) throw fail("NOT_FOUND", "主题不存在");
  }
  const [saved] = await db
    .update(users)
    .set({
      appearance: body.appearance ?? user.appearance,
      themeId: body.themeId ?? user.themeId,
      accent: body.accent === undefined ? user.accent : body.accent,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id))
    .returning();
  return ok(c, { appearance: saved.appearance, themeId: saved.themeId, accent: saved.accent });
});

themeRoutes.post("/themes/import", async (c) => {
  const user = await currentUser(c);
  if (!user) throw fail("UNAUTHENTICATED", "未登录");
  const [settings] = await db.select().from(instanceSettings);
  if (!settings?.allowUserInstallThemes && user.roleInstance !== "admin") {
    throw fail("FORBIDDEN", "管理员关闭了自行安装主题");
  }
  const json = await c.req.json();
  const checked = validateManifest(json);
  if (!checked.ok) throw fail("VALIDATION", checked.issues.map((i) => i.message).join("；"));
  const m = checked.value;
  if (m.id === BUILTIN_THEME_ID) throw fail("VALIDATION", "不能覆盖出厂主题 id，请换一个 id");
  const [old] = await db.select().from(themes).where(eq(themes.id, m.id));
  if (old) {
    // themes 是**实例级共享表**：装同一个 id 的新版本会改掉所有正在用它的人的界面。
    // 以前谁都能这么干（只要 semver 更高），等于 A 用户能改 B 用户的配色。
    if (old.builtin) throw fail("FORBIDDEN", "出厂主题不能被覆盖");
    const mine = old.installedBy === user.id;
    if (!mine && user.roleInstance !== "admin") {
      throw fail("FORBIDDEN", "这个主题 id 是别人装的，升级它请找实例管理员，或者换一个 id");
    }
    if (compareSemver(m.version, old.version) <= 0) {
      throw fail("VALIDATION", "版本必须比已安装的更高才能升级");
    }
  }
  await db
    .insert(themes)
    .values({
      id: m.id,
      name: m.name,
      description: m.description ?? null,
      author: m.author ?? null,
      version: m.version,
      builtin: false,
      enabled: true,
      manifest: m,
      installedBy: user.id,
    })
    .onConflictDoUpdate({
      target: themes.id,
      set: { name: m.name, description: m.description ?? null, author: m.author ?? null, version: m.version, manifest: m, installedBy: user.id },
    });
  return ok(c, { id: m.id }, old ? 200 : 201);
});
