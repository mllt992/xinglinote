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

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}：请在仓库根的 .env 里配置（参考 .env.example）`);
  return v;
}

const DEV_SECRET = "dev-only-change-me";
const isProduction = process.env.NODE_ENV === "production";

/**
 * APP_SECRET 是 lib/secrets.ts 的 AES 密钥（加密 SMTP 密码、AI Key、VAPID 私钥、
 * 备份凭据）和验证码 HMAC 的根。生产忘了设就等于这些密文人人可解，
 * 所以宁可起不来也不能悄悄用默认值。
 */
function requireAppSecret() {
  const value = process.env.APP_SECRET;
  if (!isProduction) return value || DEV_SECRET;
  if (!value || value === DEV_SECRET || value.length < 32) {
    throw new Error("APP_SECRET 必须设置为至少 32 位的随机串（生产环境不接受默认值）");
  }
  return value;
}

export const env = {
  isProduction,
  appSecret: requireAppSecret(),
  publicUrl: process.env.PUBLIC_URL ?? "http://127.0.0.1:12098",
  port: Number(process.env.API_PORT ?? 12099),
  // 不给默认值：凭据不写死在代码里，缺了就早失败，别让人以为连上了其实连的是别的库。
  databaseUrl: requireEnv("DATABASE_URL"),
  // 相对路径一律按仓库根解析，不按 cwd：api 的 cwd 是 apps/api、worker 的是 apps/worker，
  // 按 cwd 解析会让两个进程各写各的 data，附件抽文本、回收站清盘、块锚回写全都对不上。
  // 绝对路径（生产的 DATA_DIR=/data）不受影响，resolve 遇到绝对的尾段会直接采用它。
  dataDir: resolve(repoRoot, process.env.DATA_DIR ?? "data"),
  webDist: resolve(repoRoot, process.env.WEB_DIST ?? "apps/web/dist"),
  repoRoot,
};
