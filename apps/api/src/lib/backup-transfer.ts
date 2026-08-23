import { createHash, createHmac } from "node:crypto";
import { safeFetch } from "./net-guard.ts";

export type BackupCred = {
  username?: string;
  password?: string;
  accessKey?: string;
  secretKey?: string;
  bucket?: string;
  region?: string;
};

export type BackupTargetRef = { type: string; endpoint: string; prefix: string };

export type RemoteObject = { name: string; bytes?: number; updatedAt?: Date };

const h = (alg: string, x: string | Buffer) => createHash(alg).update(x).digest("hex");
const hm = (key: string | Buffer, x: string) => createHmac("sha256", key).update(x).digest();

/** AWS 规定：`~` 不编码，`!'()*` 要编码。路径段里的 `/` 另外处理。 */
export function awsEncode(s: string) {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/g, "~");
}

export function joinRemotePath(...parts: string[]) {
  return parts
    .flatMap(p => p.replace(/\\/g, "/").split("/"))
    .map(p => p.trim())
    .filter(Boolean)
    .join("/");
}

export function remoteObjectName(full: string, prefix: string) {
  const norm = full.replace(/^\/+/, "");
  const head = prefix.replace(/^\/+|\/+$/g, "");
  if (head && (norm === head || norm.startsWith(`${head}/`))) return norm.slice(head.length).replace(/^\/+/, "");
  const slash = norm.lastIndexOf("/");
  return slash >= 0 ? norm.slice(slash + 1) : norm;
}

function endpointUrl(endpoint: string) {
  return endpoint.replace(/\/+$/, "");
}

function objectPath(t: BackupTargetRef, path: string) {
  return joinRemotePath(t.prefix, path);
}

function basic(c: BackupCred) {
  return "Basic " + Buffer.from(`${c.username ?? ""}:${c.password ?? ""}`).toString("base64");
}

function davUrl(t: BackupTargetRef, path = "") {
  const full = objectPath(t, path);
  return full ? `${endpointUrl(t.endpoint)}/${full}` : endpointUrl(t.endpoint);
}

async function ensureDavCollections(t: BackupTargetRef, c: BackupCred, path: string) {
  const prefix = objectPath(t, path);
  const segments = prefix.split("/").filter(Boolean);
  segments.pop();
  let soFar = "";
  for (const seg of segments) {
    soFar = soFar ? `${soFar}/${seg}` : seg;
    const r = await safeFetch(`${endpointUrl(t.endpoint)}/${soFar}`, {
      method: "MKCOL",
      headers: { authorization: basic(c) },
    }, "备份目标地址");
    if (!r.ok && r.status !== 405 && r.status !== 409 && r.status !== 301 && r.status !== 302) {
      // 405/409 = 已经是目录；别的才当真失败。目录已存在时继续往下建。
      if (r.status >= 500) throw new Error(`WebDAV MKCOL failed (${r.status})`);
    }
  }
}

function parseDavHrefs(xml: string) {
  const hrefs: string[] = [];
  const re = /<(?:[\w-]+:)?href[^>]*>([^<]+)<\/(?:[\w-]+:)?href>/gi;
  for (const m of xml.matchAll(re)) {
    try { hrefs.push(decodeURIComponent(m[1].trim())); }
    catch { hrefs.push(m[1].trim()); }
  }
  return hrefs;
}

function parseS3Keys(xml: string) {
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => {
    try { return decodeURIComponent(m[1]); }
    catch { return m[1]; }
  });
}

function xmlText(value: string) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

export function parseS3Objects(xml: string, prefix: string): RemoteObject[] {
  const out: RemoteObject[] = [];
  for (const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block[1])?.[1];
    if (!key) continue;
    const name = remoteObjectName(xmlText(key), prefix);
    if (!name || name.includes("/")) continue;
    const bytes = Number(/<Size>(\d+)<\/Size>/.exec(block[1])?.[1]);
    const updatedAt = new Date(xmlText(/<LastModified>([^<]+)<\/LastModified>/.exec(block[1])?.[1] ?? ""));
    out.push({ name, ...(Number.isFinite(bytes) ? { bytes } : {}), ...(!Number.isNaN(updatedAt.getTime()) ? { updatedAt } : {}) });
  }
  return out;
}

export function parseDavObjects(xml: string, prefix: string): RemoteObject[] {
  const out: RemoteObject[] = [];
  for (const block of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
    const href = /<(?:[\w-]+:)?href[^>]*>([^<]+)<\/(?:[\w-]+:)?href>/i.exec(block[1])?.[1];
    if (!href) continue;
    let decoded = xmlText(href.trim());
    try { decoded = decodeURIComponent(decoded); } catch { /* 保留服务端原文 */ }
    const name = remoteObjectName(decoded.replace(/\/+$/, ""), prefix);
    if (!name || name.includes("/")) continue;
    const bytes = Number(/<(?:[\w-]+:)?getcontentlength[^>]*>(\d+)<\/(?:[\w-]+:)?getcontentlength>/i.exec(block[1])?.[1]);
    const updatedAt = new Date(xmlText(/<(?:[\w-]+:)?getlastmodified[^>]*>([^<]+)<\/(?:[\w-]+:)?getlastmodified>/i.exec(block[1])?.[1] ?? ""));
    out.push({ name, ...(Number.isFinite(bytes) ? { bytes } : {}), ...(!Number.isNaN(updatedAt.getTime()) ? { updatedAt } : {}) });
  }
  return out;
}

function parseS3Token(xml: string) {
  const m = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
  return m?.[1] ?? null;
}

export function buildS3Request(
  target: BackupTargetRef,
  c: BackupCred,
  path: string,
  method: string,
  body?: Buffer,
  query: Record<string, string> = {},
  opts: { bucketRoot?: boolean } = {},
) {
  if (!c.accessKey || !c.secretKey || !c.bucket) throw new Error("S3 credentials incomplete");
  const key = opts.bucketRoot ? "" : objectPath(target, path);
  const u = new URL(`${endpointUrl(target.endpoint)}/${joinRemotePath(c.bucket, key)}`);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) params.set(k, v);
  const canonicalQuery = [...params.entries()]
    .map(([k, v]) => [awsEncode(k), awsEncode(v)] as const)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  if (canonicalQuery) u.search = canonicalQuery;

  const now = new Date();
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = stamp.slice(0, 8);
  const region = c.region?.trim() || "us-east-1";
  const payload = h("sha256", body ?? Buffer.alloc(0));
  const host = u.host;
  const canonicalPath = "/" + joinRemotePath(c.bucket, key).split("/").map(awsEncode).join("/");
  const headers = `host:${host}\nx-amz-content-sha256:${payload}\nx-amz-date:${stamp}\n`;
  const canonical = `${method}\n${canonicalPath}\n${canonicalQuery}\n${headers}\nhost;x-amz-content-sha256;x-amz-date\n${payload}`;
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${h("sha256", canonical)}`;
  const kDate = hm("AWS4" + c.secretKey, day);
  const kRegion = hm(kDate, region);
  const kService = hm(kRegion, "s3");
  const signingKey = hm(kService, "aws4_request");
  const sig = createHmac("sha256", signingKey).update(toSign).digest("hex");
  return {
    url: u.toString(),
    headers: {
      "x-amz-date": stamp,
      "x-amz-content-sha256": payload,
      authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${sig}`,
    },
    canonical,
    scope,
  };
}

async function s3(
  target: BackupTargetRef,
  c: BackupCred,
  path: string,
  method: string,
  body?: Buffer,
  query?: Record<string, string>,
  opts?: { bucketRoot?: boolean },
) {
  const req = buildS3Request(target, c, path, method, body, query, opts);
  return safeFetch(req.url, {
    method,
    headers: req.headers,
    body: body ? new Uint8Array(body) : undefined,
  }, "备份目标地址");
}

export async function upload(t: BackupTargetRef, c: BackupCred, path: string, data: Buffer) {
  if (t.type === "webdav") {
    await ensureDavCollections(t, c, path);
    const r = await safeFetch(davUrl(t, path), {
      method: "PUT",
      headers: { authorization: basic(c), "content-type": "application/octet-stream" },
      body: new Uint8Array(data),
    }, "备份目标地址");
    if (!r.ok) throw new Error(`WebDAV 上传失败 (${r.status})`);
    return;
  }
  const r = await s3(t, c, path, "PUT", data);
  if (!r.ok) throw new Error(`S3 上传失败 (${r.status})`);
}

export async function remove(t: BackupTargetRef, c: BackupCred, path: string) {
  const r = t.type === "webdav"
    ? await safeFetch(davUrl(t, path), { method: "DELETE", headers: { authorization: basic(c) } }, "备份目标地址")
    : await s3(t, c, path, "DELETE");
  if (!r.ok && r.status !== 404) throw new Error(`远端删除失败 (${r.status})`);
}

export async function download(t: BackupTargetRef, c: BackupCred, path: string) {
  const r = t.type === "webdav"
    ? await safeFetch(davUrl(t, path), { headers: { authorization: basic(c) } }, "备份目标地址")
    : await s3(t, c, path, "GET");
  if (!r.ok) throw new Error(`远端下载失败 (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

export async function listRemote(t: BackupTargetRef, c: BackupCred): Promise<RemoteObject[]> {
  const prefix = joinRemotePath(t.prefix);
  if (t.type === "webdav") {
    const r = await safeFetch(davUrl(t), {
      method: "PROPFIND",
      headers: { authorization: basic(c), depth: "1", "content-type": "application/xml" },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>`,
    }, "备份目标地址");
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`WebDAV 列举失败 (${r.status})`);
    const xml = await r.text();
    const parsed = parseDavObjects(xml, prefix);
    if (parsed.length) return [...new Map(parsed.map(item => [item.name, item])).values()];
    const names = new Set<string>();
    for (const href of parseDavHrefs(xml)) {
      const name = remoteObjectName(href.replace(/\/+$/, ""), prefix);
      if (name && !name.includes("/")) names.add(name);
    }
    return [...names].map(name => ({ name }));
  }

  const out: RemoteObject[] = [];
  let token: string | null = null;
  for (let i = 0; i < 20; i++) {
    const query: Record<string, string> = { "list-type": "2", prefix: prefix ? `${prefix}/` : "" };
    if (token) query["continuation-token"] = token;
    const r = await s3(t, c, "", "GET", undefined, query, { bucketRoot: true });
    if (!r.ok) throw new Error(`S3 列举失败 (${r.status})`);
    const xml = await r.text();
    const objects = parseS3Objects(xml, prefix);
    if (objects.length) out.push(...objects);
    else for (const key of parseS3Keys(xml)) {
      const name = remoteObjectName(key, prefix);
      if (name && !name.includes("/")) out.push({ name });
    }
    token = parseS3Token(xml);
    if (!token) break;
  }
  return out;
}

/** 按设计 13：保留最近 N 天各一份、最近 M 周各一份；删之前至少留 1 个最新包。 */
export function pickExpired(
  files: { name: string; at: Date }[],
  retainDaily: number,
  retainWeekly: number,
) {
  if (!files.length) return [];
  const newestFirst = [...files].sort((a, b) => b.at.getTime() - a.at.getTime());
  const keep = new Set<string>([newestFirst[0].name]);
  const days = new Set<string>();
  const weeks = new Set<string>();
  for (const f of newestFirst) {
    const day = f.at.toISOString().slice(0, 10);
    const week = isoWeek(f.at);
    if (!days.has(day) && days.size < retainDaily) {
      days.add(day);
      keep.add(f.name);
    }
    if (!weeks.has(week) && weeks.size < retainWeekly) {
      weeks.add(week);
      keep.add(f.name);
    }
  }
  return newestFirst.filter(f => !keep.has(f.name)).map(f => f.name);
}

export function parseBackupStamp(name: string) {
  const m = name.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.kbbackup$/);
  if (!m) return null;
  const [date, rest] = m[1].split("T");
  const [hh, mm, ss, msZ] = rest.split("-");
  const at = new Date(`${date}T${hh}:${mm}:${ss}.${msZ}`);
  return Number.isNaN(at.getTime()) ? null : at;
}

function isoWeek(d: Date) {
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export async function applyRetention(
  t: BackupTargetRef,
  c: BackupCred,
  retainDaily: number,
  retainWeekly: number,
) {
  const listed = await listRemote(t, c);
  const dated = listed
    .map(f => ({ name: f.name, at: parseBackupStamp(f.name) }))
    .filter((f): f is { name: string; at: Date } => !!f.at);
  for (const name of pickExpired(dated, retainDaily, retainWeekly)) {
    await remove(t, c, name);
    await remove(t, c, `${name}.manifest.json`);
  }
}
