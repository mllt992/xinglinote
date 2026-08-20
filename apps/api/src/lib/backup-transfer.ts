import { createHash, createHmac } from "node:crypto";
import { safeFetch } from "./net-guard.ts";

type Cred = { username?: string; password?: string; accessKey?: string; secretKey?: string; bucket?: string; region?: string };

const h = (alg: string, x: string | Buffer) => createHash(alg).update(x).digest("hex");
const hm = (key: string | Buffer, x: string) => createHmac("sha256", key).update(x).digest();

function basic(c: Cred) {
  return "Basic " + Buffer.from(`${c.username ?? ""}:${c.password ?? ""}`).toString("base64");
}

async function s3(target: { endpoint: string; prefix: string }, c: Cred, path: string, method: string, body?: Buffer) {
  if (!c.accessKey || !c.secretKey || !c.bucket) throw new Error("S3 credentials incomplete");
  const u = new URL(`${target.endpoint}/${c.bucket}/${path}`);
  const now = new Date();
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = stamp.slice(0, 8);
  const region = c.region ?? "us-east-1";
  const payload = h("sha256", body ?? Buffer.alloc(0));
  const headers = `host:${u.host}\nx-amz-content-sha256:${payload}\nx-amz-date:${stamp}\n`;
  const canonical = `${method}\n${u.pathname}\n\n${headers}\nhost;x-amz-content-sha256;x-amz-date\n${payload}`;
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${h("sha256", canonical)}`;
  const kDate = hm("AWS4" + c.secretKey, day);
  const kRegion = hm(kDate, region);
  const kService = hm(kRegion, "s3");
  const key = hm(kService, "aws4_request");
  const sig = createHmac("sha256", key).update(toSign).digest("hex");
  return safeFetch(u.toString(), {
    method,
    headers: {
      "x-amz-date": stamp,
      "x-amz-content-sha256": payload,
      authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${sig}`,
    },
    body: body ? new Uint8Array(body) : undefined,
  }, "备份目标地址");
}

export async function upload(t: { type: string; endpoint: string; prefix: string }, c: Cred, path: string, data: Buffer) {
  const full = `${t.prefix.replace(/^\/+|\/+$/g, "")}/${path}`;
  if (t.type === "webdav") {
    const r = await safeFetch(`${t.endpoint}/${full}`, {
      method: "PUT",
      headers: { authorization: basic(c), "content-type": "application/octet-stream" },
      body: new Uint8Array(data),
    }, "备份目标地址");
    if (!r.ok) throw new Error(`WebDAV upload failed (${r.status})`);
    return;
  }
  const r = await s3(t, c, full, "PUT", data);
  if (!r.ok) throw new Error(`S3 upload failed (${r.status})`);
}

export async function remove(t: { type: string; endpoint: string; prefix: string }, c: Cred, path: string) {
  const full = `${t.prefix.replace(/^\/+|\/+$/g, "")}/${path}`;
  const r = t.type === "webdav"
    ? await safeFetch(`${t.endpoint}/${full}`, { method: "DELETE", headers: { authorization: basic(c) } }, "备份目标地址")
    : await s3(t, c, full, "DELETE");
  if (!r.ok && r.status !== 404) throw new Error(`remote delete failed (${r.status})`);
}
