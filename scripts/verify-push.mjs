// Web Push 投递闭环验收（设计 16 §5.7）：VAPID 头、载荷加密、多设备、失效端点自动停用。
// 先起假网关：node scripts/mock-push-gateway.mjs（:19093）
// 用法：KB_EMAIL=... KB_PASSWORD=... node --experimental-strip-types scripts/verify-push.mjs
//
// 端点走 http 是**故意的**：真网关是 https，但验收不该打到外网，也不该为了一个自签证书
// 把 fetch 的校验关掉。所以订阅行直接写库（同 verify-backup.mjs 的做法），绕开接口那层
// 「必须 https」的校验——那条校验本身由 verify-calendar-p2.mjs 盯着。
import { KB_EMAIL, KB_PASSWORD } from './creds.mjs';
// drizzle-orm 从 scripts/ 解析不到（pnpm 严格 node_modules），所以这里用底层的 sql 标签模板
import { sql as raw } from '../apps/api/src/db/client.ts';
import { pushToUser } from '../apps/api/src/lib/push.ts';

const base = (process.env.KB_BASE_URL ?? 'http://127.0.0.1:12098') + '/api/v1';
const gate = process.env.MOCK_PUSH_URL ?? 'http://127.0.0.1:19093';

async function q(path, opt = {}, cookie = '') {
  const r = await fetch(base + path, { ...opt, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opt.headers || {}) } });
  const j = await r.json();
  if (!r.ok || !j.ok) { const e = new Error(j.error?.message ?? r.status); e.code = j.error?.code; throw e; }
  return { data: j.data, cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie };
}
const g = (p, o) => fetch(gate + p, o).then(r => r.json());
const force = (id, status) => g('/_force', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, status }) });
const devicesOf = userId => raw`select id, status, fail_count, last_ok_at from push_subscriptions where user_id = ${userId}`;

const c = (await q('/auth/login', { method: 'POST', body: JSON.stringify({ email: KB_EMAIL, password: KB_PASSWORD }) })).cookie;
const me = (await q('/me', {}, c)).data;
const cfg = (await q('/push/config', {}, c)).data;
if (!cfg.enabled) {
  console.log(JSON.stringify({ pushEnabled: false, skipped: '实例没开推送：先到 /admin?tab=notifications 生成密钥并打开开关' }, null, 2));
  process.exitCode = 1;
  process.exit();
}

const result = { pushEnabled: true };
await g('/_reset', { method: 'POST' });
const made = [];
try {
  // 两台设备：验「任一台成功即算送达」，也验载荷是各自加密的
  const d1 = await g('/_device', { method: 'POST' });
  const d2 = await g('/_device', { method: 'POST' });
  for (const d of [d1, d2]) {
    const [row] = await raw`insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
      values (${me.id}, ${d.endpoint}, ${d.p256dh}, ${d.auth}, '验收假设备') returning id`;
    made.push(row.id);
  }

  const sent = await pushToUser(me.id, { title: '提醒：季度对齐', body: '08-19 15:00', href: '/w/x/calendar', tag: 'verify' });
  result.deliveredToBoth = sent.sent === 2 && sent.total === 2;

  const mine = (await g('/_received')).filter(x => x.id === d1.id || x.id === d2.id);
  result.bothGatewaysHit = mine.length === 2;
  result.vapidSignatureValid = mine.every(x => x.vapid?.ok === true);
  result.contentEncodingIsAes128gcm = mine.every(x => x.contentEncoding === 'aes128gcm');
  result.hasTtlAndUrgency = mine.every(x => Number(x.ttl) > 0 && x.urgency === 'normal');
  result.recordSizeAndKeyIdOk = mine.every(x => x.rs === 4096 && x.idlen === 65);
  result.paddingDelimiterIsTwo = mine.every(x => x.padding === 2);
  result.everyDeviceDecrypts = mine.every(x => !x.decryptError);
  // 载荷只放标题与时刻——通知会显示在锁屏上，正文一律不带
  result.payloadRoundTrips = mine.every(x => {
    try { const p = JSON.parse(x.text); return p.title === '提醒：季度对齐' && p.body === '08-19 15:00' && p.tag === 'verify'; }
    catch { return false; }
  });
  result.eachDeviceGetsOwnCiphertext = mine.length === 2 && mine[0].bytes > 0 && mine[1].bytes > 0;

  const okAfter = await devicesOf(me.id);
  result.successResetsFailCount = made.every(id => {
    const row = okAfter.find(x => x.id === id);
    return !!row && row.fail_count === 0 && !!row.last_ok_at;
  });

  // —— 410：用户把订阅删了，端点永久失效，立刻停用且不再重试 ——
  await force(d1.id, 410);
  const after = await pushToUser(me.id, { title: '再来一条' });
  result.goneDeviceSkippedOthersStillGet = after.sent === 1 && after.total === 2;
  const rows = await devicesOf(me.id);
  result.goneDeviceMarked = rows.find(x => x.id === made[0])?.status === 'gone';
  result.healthyDeviceUntouched = rows.find(x => x.id === made[1])?.status === 'active';

  await g('/_reset', { method: 'POST' });
  await pushToUser(me.id, { title: '第三条' });
  result.goneDeviceNoLongerCalled = !(await g('/_received')).some(x => x.id === d1.id);

  // —— 500：网关抽风不是永久失效，只累计失败次数 ——
  await force(d2.id, 500);
  await pushToUser(me.id, { title: '网关抽风' });
  const flaky = (await devicesOf(me.id)).find(x => x.id === made[1]);
  result.transientErrorOnlyCounts = flaky?.status === 'active' && flaky?.fail_count === 1;
} finally {
  for (const id of made) await raw`delete from push_subscriptions where id = ${id}`.catch(() => {});
}
console.log(JSON.stringify(result, null, 2));
if (!Object.values(result).every(Boolean)) process.exitCode = 1;
process.exit();
