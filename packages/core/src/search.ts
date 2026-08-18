// 关键词检索的分词与打分。中文没有空格，按规格 05 用 2-gram，
// 「账本」和「家庭账本」要能互相搜到，所以 gram 之间是 OR + 覆盖率排序，不是 AND。

const CJK = /[㐀-鿿豈-﫿぀-ヿ가-힯]/;
const isCjk = (ch: string) => CJK.test(ch);

export type QueryPart = { raw: string; grams: string[]; cjk: boolean };

/** 空格切成若干部分；中文部分再切 2-gram（单字就是它自己）。 */
export function tokenize(query: string): QueryPart[] {
  const parts: QueryPart[] = [];
  for (const chunk of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    for (const run of chunk.match(/[㐀-鿿豈-﫿぀-ヿ가-힯]+|[^㐀-鿿豈-﫿぀-ヿ가-힯]+/g) ?? []) {
      const raw = run.trim();
      if (!raw) continue;
      if (!isCjk(raw[0])) { parts.push({ raw, grams: [raw], cjk: false }); continue; }
      const grams = raw.length < 2 ? [raw] : Array.from({ length: raw.length - 1 }, (_, i) => raw.slice(i, i + 2));
      parts.push({ raw, grams, cjk: true });
    }
  }
  return parts;
}

/** 一个部分在某段文本里的命中程度：整串命中算 1，否则看 gram 覆盖了几成。 */
export function coverage(part: QueryPart, text: string): number {
  if (!text) return 0;
  if (text.includes(part.raw)) return 1;
  if (!part.cjk) return 0;                                  // 英文不做 gram，避免 "cat" 命中 "concatenate" 之外的噪声
  const hit = part.grams.filter(g => text.includes(g)).length;
  return hit / part.grams.length;
}

export type SearchFields = { title: string; tags: string[]; body: string };
export const FIELD_WEIGHT = { title: 8, tag: 3, body: 1 };

/**
 * 打分：标题 8 / 标签 3 / 正文 1，乘以命中程度；部分命中天然排在整串命中后面。
 * 任何一个部分都没沾边就返回 0，调用方据此过滤。
 */
export function scoreNote(parts: QueryPart[], fields: SearchFields): number {
  if (!parts.length) return 0;
  const title = fields.title.toLowerCase(), body = fields.body.toLowerCase();
  const tags = fields.tags.map(t => t.toLowerCase());
  let score = 0, touched = 0;
  for (const part of parts) {
    const inTitle = coverage(part, title);
    const inTag = Math.max(0, ...tags.map(t => coverage(part, t)));
    const inBody = coverage(part, body);
    const best = Math.max(inTitle, inTag, inBody);
    if (best > 0) touched++;
    score += inTitle * FIELD_WEIGHT.title + inTag * FIELD_WEIGHT.tag + inBody * FIELD_WEIGHT.body;
  }
  return touched ? score : 0;
}

/** 新鲜度加成：90 天半衰期，最多加 1 分，只用来给同分结果排序。 */
export function recencyBoost(updatedAt: Date | string, now = Date.now()) {
  const days = (now - new Date(updatedAt).getTime()) / 86400000;
  return Math.pow(0.5, Math.max(0, days) / 90);
}
