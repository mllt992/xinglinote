import { extractChatContent } from "./ai-chat.ts";

export type ChatStreamEvent = { delta?: string; usage?: Record<string, number> };

function deltaText(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const root = value as {
    choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown }; text?: unknown }>;
    usage?: Record<string, number>;
  };
  const choice = root.choices?.[0];
  const content = choice?.delta?.content ?? choice?.text;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }).join("");
}

function reasoningText(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const reasoning = (value as { choices?: Array<{ delta?: { reasoning_content?: unknown } }> }).choices?.[0]?.delta?.reasoning_content;
  return typeof reasoning === "string" ? reasoning : "";
}

/**
 * OpenAI 兼容流是 SSE。这里按空行组事件，保留跨 UTF-8 chunk 的半个字，
 * 并兼容 data 被拆成多行的实现。
 */
export async function* parseOpenAiChatStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let contentSeen = false;
  let reasoning = "";

  const parse = (raw: string): ChatStreamEvent | null => {
    if (!raw || raw === "[DONE]") return null;
    const parsed = JSON.parse(raw) as unknown;
    const delta = deltaText(parsed);
    if (delta) contentSeen = true;
    else reasoning += reasoningText(parsed);
    const usage = parsed && typeof parsed === "object" ? (parsed as { usage?: Record<string, number> }).usage : undefined;
    return delta || usage ? { ...(delta ? { delta } : {}), ...(usage ? { usage } : {}) } : null;
  };

  const flush = function* (): Generator<ChatStreamEvent> {
    if (!data.length) return;
    const event = parse(data.join("\n"));
    data = [];
    if (event) yield event;
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) yield* flush();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart());
  yield* flush();
  // 少数兼容模型只写 reasoning_content。为兼容旧的非流式行为，至少在结束时给出答案。
  if (!contentSeen && reasoning) yield { delta: reasoning };
}

/** provider 忽略 stream=true、仍返回普通 JSON 时的兼容路径。 */
export function fullChatEvent(value: unknown): ChatStreamEvent {
  const root = value && typeof value === "object" ? value as { usage?: Record<string, number> } : {};
  return { delta: extractChatContent(value), usage: root.usage ?? {} };
}
