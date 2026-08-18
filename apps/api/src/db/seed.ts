import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { BUILTIN_THEME_ID, type ThemeManifest, validateManifest } from "@kb/shared";
import { env } from "../env.ts";
import { db } from "./client.ts";
import { instanceSettings, themes } from "./schema.ts";

export async function seedBuiltin() {
  const path = resolve(env.repoRoot, "themes/mono-modern/theme.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const checked = validateManifest(raw);
  if (!checked.ok) throw new Error(checked.issues.map((i) => i.message).join("; "));
  const m = checked.value as ThemeManifest;
  await db
    .insert(themes)
    .values({
      id: BUILTIN_THEME_ID,
      name: m.name,
      description: m.description ?? null,
      author: m.author ?? "official",
      version: m.version,
      builtin: true,
      enabled: true,
      manifest: m,
    })
    .onConflictDoUpdate({
      target: themes.id,
      set: { name: m.name, version: m.version, manifest: m, description: m.description ?? null },
    });

  const existing = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1));
  if (existing.length === 0) {
    await db.insert(instanceSettings).values({ id: 1 });
  }
}
