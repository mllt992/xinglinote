/**
 * 审核判定里不碰数据库的那部分：怎么把模型吐出来的东西读成判定。
 * 单独一个文件是为了能直接单测——lib/moderation.ts 一 import 就把 db 拖进来了。
 */

export type ModerationScope = "square" | "circle" | "article";

export const SCOPE_LABEL: Record<ModerationScope, string> = { square: "广场动态", circle: "圈子动态", article: "公开文章" };

export type Category = { key: string; label: string };

/** 出厂类别。管理员可增删改，落在 instance_settings.moderation_categories。 */
export const DEFAULT_MODERATION_CATEGORIES: Category[] = [
  { key: "politics", label: "涉政敏感" }, { key: "porn", label: "色情低俗" },
  { key: "violence", label: "暴力血腥" }, { key: "abuse", label: "辱骂人身攻击" },
  { key: "illegal", label: "违法违禁" }, { key: "privacy", label: "泄露他人隐私" },
  { key: "ad", label: "垃圾广告与引流" },
];

/** 出厂 key → 中文。读旧数据（只存了 key）时用。 */
export const MODERATION_CATEGORIES: Record<string, string> = Object.fromEntries(
  DEFAULT_MODERATION_CATEGORIES.map(c => [c.key, c.label]),
);

/** 旧库是 string[]，新库是 {key,label}[]。空或坏数据回出厂清单。 */
export function normalizeCategories(raw: unknown): Category[] {
  if (!Array.isArray(raw)) return DEFAULT_MODERATION_CATEGORIES.map(c => ({ ...c }));
  const out: Category[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, 30)) {
    let key = "";
    let label = "";
    if (typeof item === "string") {
      const t = item.trim();
      key = t.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40);
      label = (MODERATION_CATEGORIES[key] ?? t).slice(0, 40);
    } else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      key = String(o.key ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40);
      label = String(o.label ?? "").trim().slice(0, 40);
    }
    if (!key || !label || seen.has(key) || !/^[a-z][a-z0-9_]*$/.test(key)) continue;
    seen.add(key);
    out.push({ key, label });
  }
  return out;
}

export function categoryLabel(key: string, catalog: Category[] = DEFAULT_MODERATION_CATEGORIES) {
  return catalog.find(c => c.key === key)?.label ?? MODERATION_CATEGORIES[key] ?? key;
}

export function slugCategoryKey(label: string, used: Iterable<string>) {
  const taken = new Set(used);
  let base = label.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "cat";
  if (!/^[a-z]/.test(base)) base = `c${base}`;
  let k = base, i = 2;
  while (taken.has(k)) k = `${base}${i++}`;
  return k;
}

export type ParsedVerdict = { verdict: "pass" | "reject" | "unsure"; score: number | null; categories: string[]; reason: string | null };

/** 模型总爱把 JSON 裹在围栏或客套话里，取第一个花括号块就够了。读不出来回 null，调用方按「模型不可用」处理。 */
export function parseVerdict(raw: string): ParsedVerdict | null {
  const fence = /```(?:json)?[^\S\n]*\n([\s\S]*?)```/i.exec(raw);
  const text = (fence ? fence[1] : raw).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const score = Number(j.score);
    return {
      verdict: j.verdict === "reject" ? "reject" : j.verdict === "unsure" || j.verdict === "review" ? "unsure" : "pass",
      score: Number.isFinite(score) ? Math.min(100, Math.max(0, Math.round(score))) : null,
      categories: Array.isArray(j.categories) ? j.categories.map(String).slice(0, 10) : [],
      reason: typeof j.reason === "string" ? j.reason.slice(0, 500) : null,
    };
  } catch { return null; }
}

/** 模型说不行、或风险分够到阈值，就转人工。拿不准也转人工。 */
export function isRisky(parsed: ParsedVerdict, threshold: number) {
  return parsed.verdict === "unsure" || parsed.verdict === "reject" || (parsed.score !== null && parsed.score >= threshold);
}

/**
 * 举报复核：两边口径一致才自动拍板，打架或 unsure 交人。
 * reject + 分够高 = 下架；pass + 分不够高 = 维持公开。
 */
export function decideReport(parsed: ParsedVerdict, threshold: number): "pass" | "review" | "reject" {
  if (parsed.verdict === "unsure") return "review";
  const high = parsed.score !== null && parsed.score >= threshold;
  if (parsed.verdict === "reject" && (parsed.score === null || high)) return "reject";
  if (parsed.verdict === "pass" && !high) return "pass";
  return "review";
}

/** 后台审可以等久一点；发布请求不再堵在这次调用上。 */
export const MODERATION_TIMEOUT_MS = 90_000;

/** 超时、限流、网关挂了值得再试；4xx / 解析失败再试也还是同一句话。 */
export function isRetryableModerationFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|aborted|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|429|502|503|504/i.test(msg);
}

/** 文档站 / 泄漏检查认的「对外公开」：作者点了发布，且没在审核中、没被驳回。 */
export function noteIsPublic(note: { published: boolean; moderationStatus?: string | null; trashedAt?: Date | null }) {
  return !!note.published && (note.moderationStatus ?? "none") === "none" && !note.trashedAt;
}
