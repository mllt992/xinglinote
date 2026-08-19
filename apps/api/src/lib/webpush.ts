/**
 * Web Push：自签 VAPID + 自己加密载荷，直连浏览器厂商的推送网关（设计 16 §5.7）。
 * 不引 web-push 包，也不经任何第三方服务——自托管实例不该为了发个通知把日程标题交给别人。
 */
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const raw = (s: string) => Buffer.from(s, "base64url");
/** ECDH 的私钥可能被剥掉前导零，而 JWK 的 d 必须是定长 32 字节。 */
const pad32 = (b: Buffer) => (b.length >= 32 ? b.subarray(b.length - 32) : Buffer.concat([Buffer.alloc(32 - b.length), b]));

export type VapidKeys = { publicKey: string; privateKey: string };
export type PushTarget = { endpoint: string; p256dh: string; auth: string };

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  const publicKey = ecdh.generateKeys();
  return { publicKey: b64u(publicKey), privateKey: b64u(pad32(ecdh.getPrivateKey())) };
}

function privateKeyObject(keys: VapidKeys) {
  const pub = raw(keys.publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID 公钥不是未压缩的 P-256 点");
  return createPrivateKey({ format: "jwk", key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
}

/** exp 必须 ≤ 24 小时，取 12 小时留足容错；aud 只能是端点的 origin，带上 path 会被网关 401。 */
export function vapidHeader(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()) {
  const { origin } = new URL(endpoint);
  const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(Buffer.from(JSON.stringify({ aud: origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const signed = `${head}.${body}`;
  // 网关只认 P1363 的裸 r||s，不认 DER
  const sig = sign("sha256", Buffer.from(signed), { key: privateKeyObject(keys), dsaEncoding: "ieee-p1363" });
  return `vapid t=${signed}.${b64u(sig)}, k=${keys.publicKey}`;
}

const RECORD_SIZE = 4096;
/** 头是 salt(16)+rs(4)+idlen(1)+服务端公钥(65)，尾是 16 字节 GCM tag，正文再留一字节分隔符。 */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - 16 - 4 - 1 - 65 - 16 - 1;

/** RFC 8291 的 aes128gcm。salt 与临时私钥可注入，单测才能对着固定向量验。 */
export function encryptPayload(payload: string, p256dh: string, auth: string, seed?: { salt?: Buffer; localPrivate?: Buffer }) {
  const clientPub = raw(p256dh);
  if (clientPub.length !== 65 || clientPub[0] !== 4) throw new Error("p256dh 不是未压缩的 P-256 公钥");
  const authSecret = raw(auth);
  if (authSecret.length !== 16) throw new Error("auth 必须是 16 字节");
  const plain = Buffer.from(payload, "utf8");
  if (plain.length > MAX_PAYLOAD_BYTES) throw new Error(`推送载荷超过 ${MAX_PAYLOAD_BYTES} 字节`);

  const ecdh = createECDH("prime256v1");
  if (seed?.localPrivate) ecdh.setPrivateKey(seed.localPrivate);
  else ecdh.generateKeys();
  const localPub = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(clientPub);
  const salt = seed?.salt ?? randomBytes(16);

  // 先用 auth 当 salt 把 ECDH 结果拉成 IKM，再用随机 salt 导 CEK 与 nonce
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), clientPub, localPub]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 = 最后一条记录的分隔符；只有一条记录，所以固定 02
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, rs, Buffer.from([localPub.length]), localPub, sealed]);
}

export type PushResult = { ok: boolean; status: number; gone: boolean; error?: string };

/** 404 / 410 = 用户把这个端点删了，永久失效，别再重试（设计 16 §5.7 之 3）。 */
export async function sendPush(target: PushTarget, keys: VapidKeys, subject: string, payload: string, ttlSeconds = 24 * 3600): Promise<PushResult> {
  let body: Buffer;
  try { body = encryptPayload(payload, target.p256dh, target.auth); }
  catch (e) { return { ok: false, status: 0, gone: true, error: (e as Error).message }; }   // 密钥本身是坏的，重试多少次都一样
  try {
    const res = await fetch(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidHeader(target.endpoint, keys, subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(ttlSeconds),
        Urgency: "normal",
      },
      body: new Uint8Array(body),
    });
    return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410, error: res.ok ? undefined : `推送网关返回 ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: (e as Error).message };
  }
}
