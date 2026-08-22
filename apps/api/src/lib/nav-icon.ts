import { fail } from "@kb/shared";
import { assertSafeOutboundUrl } from "./net-guard.ts";

const HTML_MAX = 400_000;
const ICON_MAX = 256_000;
const HOPS = 4;
const TIMEOUT_MS = 8_000;
const UA = "KnowledgeNav/1.0";

const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

/** 导航图标只认这五种。SVG 可执行，一律丢掉。 */
export function sniffNavIcon(bytes: Uint8Array): string | null {
  if (bytes.length < 8) return null;
  if (starts(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (starts(bytes, [0x52, 0x49, 0x46, 0x46]) && starts(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  const head = Buffer.from(bytes.subarray(0, 80)).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml") || head.startsWith("<!doctype svg")) return null;
  return null;
}

export function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  return m?.[2] ?? m?.[3] ?? m?.[4];
}

export function isIconRel(rel: string): boolean {
  const n = rel.toLowerCase().replace(/\s+/g, " ").trim();
  if (n === "shortcut icon") return true;
  return n.split(" ").some(p => p === "icon" || p === "apple-touch-icon" || p === "apple-touch-icon-precomposed");
}

function sizeScore(size: number): number {
  if (size >= 64 && size <= 180) return 1000 - Math.abs(128 - size);
  if (size > 180) return 500 - Math.min(size, 512);
  return size;
}

export type IconCandidate = { href: string; size: number };

/** 从 HTML 里抽出图标候选，按接近 128px 排序。相对地址相对 base 解析。 */
export function parseIconCandidates(html: string, base: string): IconCandidate[] {
  const origin = new URL(base);
  const found: IconCandidate[] = [];
  const linkRe = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    const rel = attr(tag, "rel");
    if (!rel || !isIconRel(rel)) continue;
    const href = attr(tag, "href");
    if (!href) continue;
    const sizes = attr(tag, "sizes") ?? "";
    const size = sizes.toLowerCase() === "any" ? 256 : Number.parseInt(sizes.split("x")[0] ?? "", 10) || 32;
    try {
      found.push({ href: new URL(href, origin).href, size });
    } catch { /* 坏 href 丢掉 */ }
  }
  const metaRe = /<meta\b[^>]*>/gi;
  while ((m = metaRe.exec(html))) {
    const tag = m[0];
    const prop = (attr(tag, "property") ?? attr(tag, "name") ?? "").toLowerCase();
    if (prop !== "og:image" && prop !== "twitter:image") continue;
    const href = attr(tag, "content");
    if (!href) continue;
    try {
      found.push({ href: new URL(href, origin).href, size: 48 });
    } catch { /* 同上 */ }
  }
  const seen = new Set<string>();
  return found
    .filter(c => {
      if (seen.has(c.href)) return false;
      seen.add(c.href);
      return true;
    })
    .sort((a, b) => sizeScore(b.size) - sizeScore(a.size));
}

export function parseNavUrl(raw: string): { href: string; kind: "internal" | "external" } {
  const s = raw.trim();
  if (!s) throw fail("VALIDATION", "请填写地址", { url: "必填" });
  if (s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\")) {
    if (s.length > 2000) throw fail("VALIDATION", "地址太长", { url: "太长" });
    return { href: s, kind: "internal" };
  }
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw fail("VALIDATION", "请输入 http(s) 地址或站内路径", { url: "不合法" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw fail("VALIDATION", "只支持 http/https 或站内路径", { url: "协议不对" });
  }
  if (url.href.length > 2000) throw fail("VALIDATION", "地址太长", { url: "太长" });
  return { href: url.href, kind: "external" };
}

async function fetchHop(start: URL, what: string, maxBytes: number, accept: string): Promise<{ url: URL; bytes: Buffer }> {
  let current = start;
  for (let i = 0; i < HOPS; i++) {
    await assertSafeOutboundUrl(current.href, what);
    const res = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": UA, accept },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw fail("VALIDATION", `${what}重定向没有 Location`);
      current = new URL(loc, current);
      continue;
    }
    if (!res.ok) throw fail("VALIDATION", `${what}返回 ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw fail("VALIDATION", `${what}太大`);
    return { url: current, bytes };
  }
  throw fail("VALIDATION", `${what}重定向过多`);
}

/** 按设计 19 §5.1 抓一张图标。失败回 null，不抛——站点仍可保存。 */
export async function fetchSiteIcon(rawUrl: string): Promise<{ bytes: Buffer; mime: string } | null> {
  const page = await assertSafeOutboundUrl(rawUrl, "站点地址");
  let html: string | null = null;
  let finalPage = page;
  try {
    const got = await fetchHop(page, "站点页面", HTML_MAX, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1");
    finalPage = got.url;
    html = got.bytes.toString("utf8");
  } catch {
    html = null;
  }

  const candidates: string[] = [];
  if (html) for (const c of parseIconCandidates(html, finalPage.href)) candidates.push(c.href);
  candidates.push(new URL("/favicon.ico", finalPage).href);

  const seen = new Set<string>();
  for (const href of candidates) {
    if (seen.has(href)) continue;
    seen.add(href);
    try {
      const got = await fetchHop(new URL(href), "站点图标", ICON_MAX, "image/*,*/*;q=0.1");
      const mime = sniffNavIcon(got.bytes);
      if (mime) return { bytes: got.bytes, mime };
    } catch {
      continue;
    }
  }
  return null;
}
