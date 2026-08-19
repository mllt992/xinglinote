import assert from "node:assert/strict";
import { test } from "node:test";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { encryptPayload, generateVapidKeys, MAX_PAYLOAD_BYTES, sendPush, vapidHeader } from "./webpush.ts";

const b64u = (b: Buffer) => b.toString("base64url");

/** 扮演浏览器：生成一对订阅密钥。 */
function client() {
  const ecdh = createECDH("prime256v1");
  const pub = ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, p256dh: b64u(pub), pub, auth: b64u(auth), authRaw: auth };
}

/** 扮演浏览器：按 RFC 8291 把 aes128gcm 的记录解回明文。 */
function decrypt(body: Buffer, c: ReturnType<typeof client>) {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const serverPub = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  const shared = c.ecdh.computeSecret(serverPub);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), c.pub, serverPub]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, c.authRaw, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, "最后一字节应是记录分隔符 0x02");
  return plain.subarray(0, plain.length - 1).toString("utf8");
}

test("VAPID 密钥：公钥 65 字节未压缩点，私钥定长 32 字节", () => {
  for (let i = 0; i < 20; i++) {
    const k = generateVapidKeys();
    const pub = Buffer.from(k.publicKey, "base64url"), priv = Buffer.from(k.privateKey, "base64url");
    assert.equal(pub.length, 65);
    assert.equal(pub[0], 4);
    assert.equal(priv.length, 32, "前导零被剥掉的私钥会让 JWK 导入失败");
  }
});

test("VAPID 头：签名用公钥验得过，aud 只到 origin", () => {
  const keys = generateVapidKeys();
  const header = vapidHeader("https://fcm.googleapis.com/fcm/send/abc?x=1", keys, "mailto:ops@example.com", 1_760_000_000_000);
  const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
  assert.equal(k, keys.publicKey);
  const [h, p, s] = t!.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h!, "base64url").toString()), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
  assert.equal(claims.aud, "https://fcm.googleapis.com", "带上 path 会被网关 401");
  assert.equal(claims.sub, "mailto:ops@example.com");
  assert.equal(claims.exp, 1_760_000_000 + 12 * 3600);
  const pub = Buffer.from(keys.publicKey, "base64url");
  const pubKey = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
  assert.ok(verify("sha256", Buffer.from(`${h}.${p}`), { key: pubKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url")));
});

test("载荷加密：头部布局符合 RFC 8188，客户端能解回原文", () => {
  const c = client();
  const body = encryptPayload("提醒：季度对齐 · 08-19 15:00", c.p256dh, c.auth);
  assert.equal(body.readUInt32BE(16), 4096, "rs 固定 4096");
  assert.equal(body[20], 65, "idlen 是服务端公钥长度");
  assert.equal(body[21], 4, "服务端公钥同样是未压缩点");
  assert.equal(decrypt(body, c), "提醒：季度对齐 · 08-19 15:00");
});

test("同一份明文两次加密结果不同：salt 与临时密钥都是一次性的", () => {
  const c = client();
  const a = encryptPayload("x", c.p256dh, c.auth), b = encryptPayload("x", c.p256dh, c.auth);
  assert.notEqual(a.toString("base64"), b.toString("base64"));
  assert.equal(decrypt(a, c), "x");
  assert.equal(decrypt(b, c), "x");
});

test("注入固定 salt 与临时私钥时结果可复现", () => {
  const c = client();
  const salt = Buffer.alloc(16, 7), localPrivate = Buffer.from("11".repeat(32), "hex");
  const a = encryptPayload("hi", c.p256dh, c.auth, { salt, localPrivate });
  const b = encryptPayload("hi", c.p256dh, c.auth, { salt, localPrivate });
  assert.equal(a.toString("base64"), b.toString("base64"));
  assert.equal(decrypt(a, c), "hi");
});

test("坏的订阅密钥当场拒绝，不发出去", () => {
  const c = client();
  assert.throws(() => encryptPayload("x", b64u(Buffer.alloc(65)), c.auth), /未压缩/);
  assert.throws(() => encryptPayload("x", c.p256dh, b64u(Buffer.alloc(8))), /16 字节/);
  assert.throws(() => encryptPayload("x".repeat(MAX_PAYLOAD_BYTES + 1), c.p256dh, c.auth), /载荷超过/);
});

test("端点或密钥坏掉时，sendPush 直接判定永久失效而不是无限重试", async () => {
  const keys = generateVapidKeys();
  const r = await sendPush({ endpoint: "https://push.example.com/x", p256dh: "bm90LWEta2V5", auth: "bm90LWEta2V5" }, keys, "mailto:a@b.c", "x");
  assert.equal(r.ok, false);
  assert.equal(r.gone, true, "密钥本身是坏的，重试多少次都一样");
});
