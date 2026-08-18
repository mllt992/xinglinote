// 验收脚本共用的账号来源。只从环境变量取，任何凭据都不写进仓库。
export const KB_EMAIL = process.env.KB_EMAIL;
export const KB_PASSWORD = process.env.KB_PASSWORD;
if (!KB_EMAIL || !KB_PASSWORD) {
  throw new Error('请用环境变量提供验收账号，例如：KB_EMAIL=you@example.com KB_PASSWORD=... node scripts/verify-manage.mjs');
}
