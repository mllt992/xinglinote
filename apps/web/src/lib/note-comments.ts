export type TextSelection = { from: number; to: number; text: string };
export type CommentAnchor = TextSelection & { prefix: string; suffix: string; version: number };
export type ResolvedAnchor = { from: number; to: number; state: "exact" | "moved" };

const CONTEXT = 48;

/** 把 CodeMirror 选区变成可持久化锚点。前后文只用于消歧，不作为引用正文展示。 */
export function commentAnchorAt(source: string, version: number, selection: TextSelection): CommentAnchor | null {
  const { from, to, text } = selection;
  if (from < 0 || to <= from || to > source.length || source.slice(from, to) !== text) return null;
  return {
    from, to, text, version,
    prefix: source.slice(Math.max(0, from - CONTEXT), from),
    suffix: source.slice(to, Math.min(source.length, to + CONTEXT)),
  };
}

function commonPrefix(a: string, b: string) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function commonSuffix(a: string, b: string) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/**
 * 正文变化后重新找引用：先信原偏移，再找唯一原文，重复原文则用前后文消歧。
 * 无法唯一确认时宁可返回 null，也不把用户带到另一句同文内容。
 */
export function resolveCommentAnchor(source: string, anchor: CommentAnchor): ResolvedAnchor | null {
  if (source.slice(anchor.from, anchor.to) === anchor.text) return { from: anchor.from, to: anchor.to, state: "exact" };
  const hits: number[] = [];
  for (let at = source.indexOf(anchor.text); at >= 0 && hits.length < 1000; at = source.indexOf(anchor.text, at + 1)) hits.push(at);
  if (hits.length === 0) return null;
  if (hits.length === 1) return { from: hits[0]!, to: hits[0]! + anchor.text.length, state: "moved" };

  const ranked = hits.map(from => {
    const before = source.slice(Math.max(0, from - anchor.prefix.length), from);
    const after = source.slice(from + anchor.text.length, from + anchor.text.length + anchor.suffix.length);
    return { from, score: commonSuffix(before, anchor.prefix) + commonPrefix(after, anchor.suffix) };
  }).sort((a, b) => b.score - a.score);
  if (!ranked[0]!.score || ranked[0]!.score === ranked[1]!.score) return null;
  return { from: ranked[0]!.from, to: ranked[0]!.from + anchor.text.length, state: "moved" };
}
