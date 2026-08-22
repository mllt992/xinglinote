export const HASHTAG_MAX = 32;
export const HASHTAG_CAP = 8;

/** 前面要有边界，避免把标题 `# 一级` 或颜色 `#fff` 当成话题。 */
const HASHTAG_RE = /(^|[\s([（「『"'“‘])#([\p{L}\p{N}_]{1,32})#?(?![#\p{L}\p{N}_])/gu;
const QUERY_RE = /(?:^|[\s([（])#([\p{L}\p{N}_]{0,32})$/u;
const HEX_COLOR = /^[0-9a-f]{3}([0-9a-f]{3})?$/;

export type HashtagPiece =
  | { type: "text"; value: string }
  | { type: "hashtag"; value: string; tag: string };

export function normalizeHashtag(raw: string): string {
  return raw.normalize("NFKC").replace(/^#+|#+$/g, "").trim().replace(/[A-Z]/g, c => c.toLowerCase());
}

export function isHashtag(raw: string): boolean {
  const tag = normalizeHashtag(raw);
  if (!tag || tag.length > HASHTAG_MAX) return false;
  if (HEX_COLOR.test(tag)) return false;
  return /^[\p{L}\p{N}_]+$/u.test(tag);
}

export function parseHashtags(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = new RegExp(HASHTAG_RE.source, "gu");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const tag = normalizeHashtag(m[2]);
    if (!isHashtag(tag) || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= HASHTAG_CAP) break;
  }
  return out;
}

/** 光标前正在写的 #query。 */
export function hashtagQuery(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const m = QUERY_RE.exec(before);
  if (!m) return null;
  return { query: normalizeHashtag(m[1]), start: before.length - m[1].length - 1 };
}

export function splitHashtags(text: string): HashtagPiece[] {
  const pieces: HashtagPiece[] = [];
  const re = new RegExp(HASHTAG_RE.source, "gu");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const at = m.index + m[1].length;
    if (at > last) pieces.push({ type: "text", value: text.slice(last, at) });
    const tag = normalizeHashtag(m[2]);
    const raw = text.slice(at, m.index + m[0].length);
    if (isHashtag(tag)) pieces.push({ type: "hashtag", value: raw, tag });
    else pieces.push({ type: "text", value: raw });
    last = m.index + m[0].length;
  }
  if (last < text.length) pieces.push({ type: "text", value: text.slice(last) });
  return pieces;
}
