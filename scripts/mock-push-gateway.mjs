// 假的浏览器推送网关（:19093）。verify-push.mjs 用它验证投递闭环：
// VAPID 头对不对、载荷能不能按 RFC 8291 解回原文、404/410 会不会让端点自动停用。
// 真网关是 FCM / Mozilla 那些，验收不该打到外网。
import { createDecipheriv, createECDH, hkdfSync, randomBytes, verify, createPublicKey } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.env.MOCK_PUSH_PORT ?? 19093);
const b64u = b => Buffer.from(b).toString('base64url');

/** 每个「设备」一对订阅密钥，POST /_device 领一份。 */
const devices = new Map();
/** 收到的推送，POST /_reset 清空，GET /_received 取出。 */
const received = [];
/** 指定某个端点下次返回什么状态码，用来验失效处理。 */
const forced = new Map();

function newDevice() {
  const id = randomBytes(8).toString('hex');
  const ecdh = createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const auth = randomBytes(16);
  devices.set(id, { ecdh, pub, auth });
  return { id, endpoint: `http://127.0.0.1:${port}/push/${id}`, p256dh: b64u(pub), auth: b64u(auth) };
}

/** 扮演浏览器解密。解不出来就把原因记下来，让验收看得见是哪一步坏了。 */
function decrypt(body, d) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const serverPub = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  const shared = d.ecdh.computeSecret(serverPub);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), d.pub, serverPub]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, d.auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const dec = createDecipheriv('aes-128-gcm', cek, nonce);
  dec.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([dec.update(sealed.subarray(0, sealed.length - 16)), dec.final()]);
  return { rs, idlen, padding: plain[plain.length - 1], text: plain.subarray(0, plain.length - 1).toString('utf8') };
}

/** VAPID 头：拆出 JWT 与公钥，用公钥验签，并核对 aud 只到 origin。 */
function checkVapid(header, expectOrigin) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header ?? '');
  if (!m) return { ok: false, why: 'Authorization 不是 vapid t=…, k=… 的形状' };
  const [head, payload, sig] = m[1].split('.');
  const pub = Buffer.from(m[2], 'base64url');
  if (pub.length !== 65 || pub[0] !== 4) return { ok: false, why: 'k= 不是未压缩的 P-256 公钥' };
  const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
  const good = verify('sha256', Buffer.from(`${head}.${payload}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  if (!good) return { ok: false, why: 'JWT 签名验不过' };
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (claims.aud !== expectOrigin) return { ok: false, why: `aud 应为 ${expectOrigin}，实际 ${claims.aud}` };
  if (!claims.sub) return { ok: false, why: 'sub 为空' };
  const alg = JSON.parse(Buffer.from(head, 'base64url').toString()).alg;
  if (alg !== 'ES256') return { ok: false, why: `alg 应为 ES256，实际 ${alg}` };
  return { ok: true, claims };
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/_device' && req.method === 'POST') return json(res, 200, newDevice());
  if (url.pathname === '/_received') return json(res, 200, received);
  if (url.pathname === '/_reset' && req.method === 'POST') { received.length = 0; forced.clear(); return json(res, 200, {}); }
  if (url.pathname === '/_force' && req.method === 'POST') {
    let raw = ''; req.on('data', d => (raw += d));
    return req.on('end', () => { const b = JSON.parse(raw || '{}'); forced.set(b.id, b.status); json(res, 200, {}); });
  }

  const hit = /^\/push\/([0-9a-f]+)$/.exec(url.pathname);
  if (!hit || req.method !== 'POST') { res.writeHead(404); return res.end('not found'); }
  const id = hit[1];
  const status = forced.get(id);
  if (status) { received.push({ id, forced: status }); res.writeHead(status); return res.end(); }
  const d = devices.get(id);
  if (!d) { res.writeHead(410); return res.end(); }

  const chunks = [];
  req.on('data', ch => chunks.push(ch));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const entry = {
      id,
      contentEncoding: req.headers['content-encoding'],
      ttl: req.headers.ttl,
      urgency: req.headers.urgency,
      vapid: checkVapid(req.headers.authorization, `http://127.0.0.1:${port}`),
      bytes: body.length,
    };
    try { Object.assign(entry, decrypt(body, d)); }
    catch (e) { entry.decryptError = e.message; }
    received.push(entry);
    res.writeHead(201);
    res.end();
  });
}).listen(port, '127.0.0.1', () => console.log(`mock push gateway http://127.0.0.1:${port}`));
