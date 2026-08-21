/**
 * 审核判定里不碰数据库的那部分：怎么把模型吐出来的东西读成判定。
 * 单独一个文件是为了能直接单测——lib/moderation.ts 一 import 就把 db 拖进来了。
 */

export type ModerationScope = "square" | "circle" | "article";

export const SCOPE_LABEL: Record<ModerationScope, string> = { square: "广场动态", circle: "圈子动态", article: "公开文章" };

/** 管理员在设置里勾的拦截类别。key 进提示词，模型只许回这些 key。 */
export const MODERATION_CATEGORIES: Record<string, string> = {
  politics: "涉政敏感", porn: "色情低俗", violence: "暴力血腥", abuse: "辱骂人身攻击",
  illegal: "违法违禁", privacy: "泄露他人隐私", ad: "垃圾广告与引流",
};

export type ParsedVerdict = { verdict: "pass" | "reject"; score: number | null; categories: string[]; reason: string | null };

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
      verdict: j.verdict === "reject" ? "reject" : "pass",
      score: Number.isFinite(score) ? Math.min(100, Math.max(0, Math.round(score))) : null,
      categories: Array.isArray(j.categories) ? j.categories.map(String).slice(0, 10) : [],
      reason: typeof j.reason === "string" ? j.reason.slice(0, 500) : null,
    };
  } catch { return null; }
}

/** 模型说不行、或风险分够到阈值，就转人工。 */
export function isRisky(parsed: ParsedVerdict, threshold: number) {
  return parsed.verdict === "reject" || (parsed.score !== null && parsed.score >= threshold);
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
