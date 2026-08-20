// 验收脚本共用的账号来源。只从环境变量取，任何凭据都不写进仓库。
export const KB_EMAIL = process.env.KB_EMAIL;
export const KB_PASSWORD = process.env.KB_PASSWORD;
if (!KB_EMAIL || !KB_PASSWORD) {
  throw new Error('请用环境变量提供验收账号，例如：KB_EMAIL=you@example.com KB_PASSWORD=... node scripts/verify-manage.mjs');
}

/**
 * 验收脚本里临时注册的账号用的密码。
 *
 * 每次运行随机生成，不再是写死的 `Password1234`：那些账号是**真的**建在库上的，
 * 跑完也不清理，一个写死的弱口令等于给每台跑过验收的实例留一批活账号。
 * 同一次运行内是同一个值，所以「注册完再登录」这种流程照样能用。
 */
export const TEST_PASSWORD = `Vf${crypto.randomUUID().replaceAll('-', '')}9z`;
