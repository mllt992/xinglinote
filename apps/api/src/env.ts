import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv() {
  for (const file of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
}
loadDotEnv();

const repoRoot = existsSync(resolve(process.cwd(), "pnpm-workspace.yaml"))
  ? process.cwd()
  : resolve(process.cwd(), "../..");

export const env = {
  appSecret: process.env.APP_SECRET ?? "dev-only-change-me",
  publicUrl: process.env.PUBLIC_URL ?? "http://127.0.0.1:12098",
  port: Number(process.env.API_PORT ?? 12099),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://kb:kb@127.0.0.1:5432/knowledge",
  dataDir: resolve(process.env.DATA_DIR ?? resolve(repoRoot, "data")),
  webDist: resolve(process.env.WEB_DIST ?? resolve(repoRoot, "apps/web/dist")),
  repoRoot,
};
