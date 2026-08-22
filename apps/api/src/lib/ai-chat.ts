type ChatResponse = {
  choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown }; text?: unknown }>;
  usage?: Record<string, number>;
  error?: { message?: unknown };
};

/** 兼容字符串、分段 content，以及只把字写在 reasoning_content 里的模型。 */
export function extractChatContent(d: unknown): string {
  if (!d || typeof d !== "object") return "";
  const root = d as ChatResponse;
  const choice = root.choices?.[0];
  const message = choice?.message ?? {};
  return firstText(message.content) || firstText(message.reasoning_content) || firstText(choice?.text);
}

function firstText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value.map(part => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const rec = part as Record<string, unknown>;
    if (typeof rec.text === "string") return rec.text;
    if (typeof rec.content === "string") return rec.content;
    return "";
  }).join("").trim();
}

export function providerErrorHint(status: number, raw: string) {
  let detail = raw.replace(/\s+/g, " ").trim().slice(0, 180);
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown };
    const msg = parsed.error?.message ?? parsed.message;
    if (typeof msg === "string" && msg.trim()) detail = msg.trim().slice(0, 180);
  } catch { /* 正文不是 JSON 就用原文 */ }
  if (status === 401 || status === 403) return `模型拒绝了请求（${status}），请检查 Key`;
  if (status === 404) return "找不到这个模型，请核对地址和模型名";
  if (status === 429) return "模型限流了，过一会再叫";
  return detail ? `模型请求失败（${status}）：${detail}` : `模型请求失败（${status}）`;
}
