/** 与 HANDLE_RE 同一套；这里不从 index 再引，免得和 re-export 打成环。 */
const HANDLE = /^[a-z][a-z0-9_]{2,31}$/;

/** 前面要有边界，避免把 mailbox@domain.com 当成艾特。 */
const MENTION_RE = /(^|[\s([（「『"'“‘])@([a-zA-Z][a-zA-Z0-9_]{2,31})\b/g;
const QUERY_RE = /(?:^|[\s([（])@([a-zA-Z0-9_]*)$/;

export type MentionPiece =
  | { type: "text"; value: string }
  | { type: "mention"; value: string; handle: string };

export function parseMentions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = new RegExp(MENTION_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const handle = m[2].toLowerCase();
    if (!HANDLE.test(handle) || seen.has(handle)) continue;
    seen.add(handle);
    out.push(handle);
  }
  return out;
}

/** 光标前正在写的 @query。query 可以短于 3 位，方便补全。 */
export function mentionQuery(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const m = QUERY_RE.exec(before);
  if (!m) return null;
  return { query: m[1].toLowerCase(), start: before.length - m[1].length - 1 };
}

export function splitMentions(text: string): MentionPiece[] {
  const pieces: MentionPiece[] = [];
  const re = new RegExp(MENTION_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const at = m.index + m[1].length;
    if (at > last) pieces.push({ type: "text", value: text.slice(last, at) });
    const raw = `@${m[2]}`;
    pieces.push({ type: "mention", value: raw, handle: m[2].toLowerCase() });
    last = at + raw.length;
  }
  if (last < text.length) pieces.push({ type: "text", value: text.slice(last) });
  return pieces;
}
