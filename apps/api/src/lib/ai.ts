import { and, desc, eq } from "drizzle-orm";
import { AppError, fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { aiProviders, workspaceAiSettings } from "../db/schema.ts";
import { aiProviderCoversWorkspace } from "./ai-provider-workspaces.ts";
import { extractChatContent, providerErrorHint } from "./ai-chat.ts";
import { cacheGet, cacheSet, embedCacheKey, embedMediaCacheKey, EMBED_CACHE_TTL_SEC } from "./cache.ts";
import { classifyOutboundFailure, OutboundFetchError, safeFetch } from "./net-guard.ts";
import { open } from "./secrets.ts";
import { fullChatEvent, parseOpenAiChatStream, type ChatStreamEvent } from "./ai-stream.ts";

export { extractChatContent } from "./ai-chat.ts";

export type Provider = typeof aiProviders.$inferSelect;
export type ChatProvider = { baseUrl: string; chatModel: string; apiKey: string };
/** 文本是字符串；图/视频带 data URL，可附文件名作 caption。 */
export type EmbedInput = string | { text?: string; image?: string; video?: string; sha256?: string };

export const IMAGE_EMBED_MAX_BYTES = 8 * 1024 * 1024;
export const VIDEO_EMBED_MAX_BYTES = 16 * 1024 * 1024;
export const TEXT_ATTACH_MAX_CHARS = 200_000;
export const INDEX_MAX_IMAGES = 20;
export const INDEX_MAX_VIDEOS = 4;

export function mediaCaption(kind: "image" | "video" | "file", filename: string) {
  const label = kind === "image" ? "图片" : kind === "video" ? "视频" : "附件";
  return `[${label}] ${filename}`;
}

export function toEmbedDataUrl(mime: string, bytes: Buffer) {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function isMediaInput(input: EmbedInput): input is { text?: string; image?: string; video?: string; sha256?: string } {
  return typeof input !== "string" && !!(input.image || input.video);
}

/** 旧数据没有工作区模型分配时的兼容路径：本人私有配置优先，其次才是公用渠道。 */
async function legacyProvider(wsId: string, userId?: string) {
  const rows = await db
    .select()
    .from(aiProviders)
    .where(and(aiProviderCoversWorkspace(wsId), eq(aiProviders.enabled, true)))
    .orderBy(desc(aiProviders.createdAt));
  return rows.find(p => p.ownerUserId === userId) ?? rows.find(p => !p.ownerUserId);
}

/** 旧库没有显式分配时，Embedding 也只能回退到共享渠道，不能采用成员私有配置。 */
async function legacyEmbeddingProvider(wsId: string) {
  const rows = await db
    .select()
    .from(aiProviders)
    .where(and(aiProviderCoversWorkspace(wsId), eq(aiProviders.enabled, true)))
    .orderBy(desc(aiProviders.createdAt));
  return rows.find(p => !p.ownerUserId);
}

async function assignedChannel(wsId: string, providerId: string) {
  const [row] = await db.select().from(aiProviders).where(and(
    eq(aiProviders.id, providerId),
    eq(aiProviders.enabled, true),
    aiProviderCoversWorkspace(wsId),
  ));
  return row;
}

/** 工作区明确选择的对话渠道与模型；没有新配置时兼容旧 Provider 行。 */
export async function aiProvider(wsId: string, userId?: string) {
  const [settings] = await db.select().from(workspaceAiSettings).where(eq(workspaceAiSettings.workspaceId, wsId));
  if (settings) {
    if (!settings.chatProviderId || !settings.chatModel) return undefined;
    const p = await assignedChannel(wsId, settings.chatProviderId);
    return p ? { ...p, chatModel: settings.chatModel } : undefined;
  }
  return legacyProvider(wsId, userId);
}

/** Worker 与语义检索使用工作区明确选择的 Embedding 渠道。 */
export async function aiEmbeddingProvider(wsId: string, _userId?: string) {
  const [settings] = await db.select().from(workspaceAiSettings).where(eq(workspaceAiSettings.workspaceId, wsId));
  if (settings) {
    if (!settings.embeddingProviderId || !settings.embeddingModel) return undefined;
    const p = await assignedChannel(wsId, settings.embeddingProviderId);
    return p ? {
      ...p,
      embeddingModel: settings.embeddingModel,
      embeddingBaseUrl: null,
      embeddingApiKey: null,
      autoEmbed: settings.autoEmbed,
    } : undefined;
  }
  return legacyEmbeddingProvider(wsId);
}

/** 新配置总是直接使用所选渠道；旧行仍可通过 embeddingBaseUrl 兼容。 */
export function embedEndpoint(p: Pick<Provider, "baseUrl" | "embeddingBaseUrl" | "embeddingModel">) {
  return {
    baseUrl: (p.embeddingBaseUrl?.trim() || p.baseUrl).replace(/\/$/, ""),
    model: p.embeddingModel ?? "",
  };
}

function providerKey(value: string | null | undefined) {
  if (!value) return "";
  return open(value);
}

function authHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers["x-api-key"] = apiKey;
  }
  return headers;
}

/**
 * OpenAI-compatible providers expose their catalog at /models. Keep discovery in the
 * same guarded request path as inference so a settings form cannot become an SSRF proxy.
 * A few compatible servers return the array directly; accepting both shapes costs
 * nothing and makes local providers much less fiddly.
 */
export async function discoverAiModels(baseUrl: string, apiKey: string, timeoutMs = 15_000) {
  let response: Response;
  try {
    response = await safeFetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      method: "GET",
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(timeoutMs),
    }, "AI 提供商地址");
  } catch (error) {
    throw asAiProviderError(error, "连接超时，请检查地址或网络");
  }
  const raw = await response.text();
  if (!response.ok) throw fail("AI_PROVIDER_ERROR", providerErrorHint(response.status, raw));
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : {}; }
  catch { throw fail("AI_PROVIDER_ERROR", "模型列表返回的不是 JSON"); }
  const source = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { data?: unknown }).data)
      ? (parsed as { data: unknown[] }).data
      : [];
  const models = source
    .map(item => typeof item === "string" ? item : item && typeof item === "object" ? (item as { id?: unknown; name?: unknown }).id ?? (item as { name?: unknown }).name : "")
    .filter((id): id is string => typeof id === "string" && !!id.trim())
    .map(id => id.trim());
  return [...new Set(models)].sort((a, b) => a.localeCompare(b));
}

function embedBodyInput(input: EmbedInput[]) {
  if (input.every(x => typeof x === "string")) return input;
  return input.map(x => {
    if (typeof x === "string") return x;
    const item: { text?: string; image?: string; video?: string } = {};
    if (x.text) item.text = x.text;
    if (x.image) item.image = x.image;
    if (x.video) item.video = x.video;
    return item;
  });
}

function cacheKeyForEmbed(p: Provider, input: EmbedInput) {
  const { baseUrl, model } = embedEndpoint(p);
  if (typeof input === "string") return embedCacheKey(baseUrl, model, input);
  const kind = input.image ? "image" as const : input.video ? "video" as const : null;
  if (kind && input.sha256) return embedMediaCacheKey(baseUrl, model, kind, input.sha256, input.text ?? "");
  return embedCacheKey(baseUrl, model, `${input.text ?? ""}\0${input.image ? "image" : input.video ? "video" : "text"}`);
}

function fallbackText(input: EmbedInput) {
  if (typeof input === "string") return input;
  return input.text ?? "";
}

/**
 * baseUrl 是用户填的，所以每次真正发请求前都要再过一遍出站护栏（DNS 可能被改指向），
 * 并且必须带超时——一个吊住不返回的 provider 会把请求和 worker 任务一起占死。
 */
function asAiProviderError(error: unknown, timeoutMessage: string) {
  if (error instanceof AppError) return error;
  if (error instanceof OutboundFetchError) {
    return fail("AI_PROVIDER_ERROR", error.kind === "timeout" ? timeoutMessage : `连不上模型（${error.message}）`);
  }
  const { kind, message } = classifyOutboundFailure(error);
  if (kind === "timeout") return fail("AI_PROVIDER_ERROR", timeoutMessage);
  return fail("AI_PROVIDER_ERROR", `连不上模型（${message}）`);
}

async function embedRemote(p: Provider, input: EmbedInput[], timeoutMs = 30_000) {
  if (!input.length) return [] as number[][];
  const { baseUrl, model } = embedEndpoint(p);
  const independent = !!p.embeddingBaseUrl?.trim();
  const apiKey = providerKey(independent ? p.embeddingApiKey : p.apiKey);
  let r: Response;
  try {
    r = await safeFetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ model, input: embedBodyInput(input) }),
      signal: AbortSignal.timeout(timeoutMs),
    }, "AI 提供商地址");
  } catch (e) {
    throw asAiProviderError(e, "Embedding 超时，请检查地址或网络");
  }
  if (!r.ok) throw fail("AI_PROVIDER_ERROR", `Embedding 请求失败 (${r.status})`);
  const d = (await r.json()) as { data?: Array<{ index: number; embedding: number[] }> };
  return (d.data ?? []).sort((a, b) => a.index - b.index).map(x => x.embedding);
}

function parseCachedVector(raw: string): number[] | undefined {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v) || !v.length || v.some(n => typeof n !== "number" || !Number.isFinite(n))) return;
    return v;
  } catch {
    return;
  }
}

async function fillMissing(p: Provider, missing: Array<{ i: number; input: EmbedInput; key: string }>, out: Array<number[] | undefined>, timeoutMs: number) {
  if (!missing.length) return;
  const vecs = await embedRemote(p, missing.map(m => m.input), timeoutMs);
  if (vecs.length !== missing.length) throw fail("AI_PROVIDER_ERROR", "Embedding 返回条数对不上");
  for (let j = 0; j < missing.length; j++) {
    const vec = vecs[j]!;
    out[missing[j]!.i] = vec;
    await cacheSet(missing[j]!.key, JSON.stringify(vec), EMBED_CACHE_TTL_SEC);
  }
}

/** 按条查缓存，未命中的才打 embedding API。问句和笔记切块共用。图/视频失败则退回文件名文本。 */
export async function embed(p: Provider, input: EmbedInput[]) {
  if (!p.embeddingModel) throw fail("AI_NOT_CONFIGURED", "请先配置 Embedding 模型");
  const out: Array<number[] | undefined> = new Array(input.length);
  const missingText: Array<{ i: number; input: EmbedInput; key: string }> = [];
  const missingMedia: Array<{ i: number; input: EmbedInput; key: string }> = [];
  for (let i = 0; i < input.length; i++) {
    const item = input[i] ?? "";
    const key = cacheKeyForEmbed(p, item);
    const hit = parseCachedVector((await cacheGet(key)) ?? "");
    if (hit) out[i] = hit;
    else if (typeof item !== "string" && (item.image || item.video)) missingMedia.push({ i, input: item, key });
    else missingText.push({ i, input: typeof item === "string" ? item : fallbackText(item), key });
  }
  await fillMissing(p, missingText, out, 30_000);
  for (const m of missingMedia) {
    try {
      await fillMissing(p, [m], out, 60_000);
    } catch {
      const text = fallbackText(m.input);
      const key = cacheKeyForEmbed(p, text);
      const hit = parseCachedVector((await cacheGet(key)) ?? "");
      if (hit) out[m.i] = hit;
      else {
        const [vec] = await embedRemote(p, [text], 30_000);
        if (!vec) throw fail("AI_PROVIDER_ERROR", "Embedding 返回条数对不上");
        out[m.i] = vec;
        await cacheSet(key, JSON.stringify(vec), EMBED_CACHE_TTL_SEC);
      }
    }
  }
  return out as number[][];
}

/** 唯一一份聊天调用。routes/ai.ts 以前自己抄了一模一样的一份，别再抄了。 */
export async function chatAi(p: ChatProvider, messages: Array<{ role: string; content: string }>, opts?: { temperature?: number; timeoutMs?: number; maxTokens?: number }) {
  let r: Response;
  try {
    r = await safeFetch(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: authHeaders(providerKey(p.apiKey)),
      body: JSON.stringify({
        model: p.chatModel,
        messages,
        temperature: opts?.temperature ?? 0.2,
        ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      }),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 30_000),
    }, "AI 提供商地址");
  } catch (e) {
    throw asAiProviderError(e, "模型响应超时");
  }
  const raw = await r.text();
  if (!r.ok) throw fail("AI_PROVIDER_ERROR", providerErrorHint(r.status, raw));
  let d: { usage?: Record<string, number> } = {};
  try { d = raw ? JSON.parse(raw) as { usage?: Record<string, number> } : {}; } catch { throw fail("AI_PROVIDER_ERROR", "模型返回的不是 JSON"); }
  return { content: extractChatContent(d), usage: d.usage ?? {} };
}

/** 问答用流式调用；写作和画图仍需要完整结果，继续走 chatAi。 */
export async function* streamChatAi(
  p: ChatProvider,
  messages: Array<{ role: string; content: string }>,
  opts?: { temperature?: number; timeoutMs?: number; maxTokens?: number },
): AsyncGenerator<ChatStreamEvent> {
  let r: Response;
  try {
    r = await safeFetch(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: authHeaders(providerKey(p.apiKey)),
      body: JSON.stringify({
        model: p.chatModel,
        messages,
        temperature: opts?.temperature ?? 0.2,
        stream: true,
        stream_options: { include_usage: true },
        ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      }),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 90_000),
    }, "AI 提供商地址");
  } catch (e) {
    throw asAiProviderError(e, "模型响应超时");
  }
  if (!r.ok) throw fail("AI_PROVIDER_ERROR", providerErrorHint(r.status, await r.text()));
  if (!r.body) throw fail("AI_PROVIDER_ERROR", "模型没有返回响应流");
  if (!String(r.headers.get("content-type") ?? "").includes("text/event-stream")) {
    let parsed: unknown;
    try { parsed = JSON.parse(await r.text()); }
    catch { throw fail("AI_PROVIDER_ERROR", "模型返回的不是 JSON 或 SSE"); }
    yield fullChatEvent(parsed);
    return;
  }
  yield* parseOpenAiChatStream(r.body);
}

export function plain(md: string) {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, t, d) => d || t)
    .replace(/[ \t]+\^tk-[0-9a-f]{8}\b/g, " ")
    .replace(/[#>*_~`-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitText(text: string, target = 1800, overlap = 280) {
  const src = text.trim();
  if (!src) return [] as string[];
  const out: string[] = [];
  let at = 0;
  while (at < src.length) {
    let end = Math.min(src.length, at + target);
    if (end < src.length) {
      const cut = Math.max(src.lastIndexOf("\n", end), src.lastIndexOf("。", end), src.lastIndexOf(" ", end));
      if (cut > at + target / 2) end = cut + 1;
    }
    out.push(src.slice(at, end));
    if (end >= src.length) break;
    at = Math.max(at + 1, end - overlap);
  }
  return out;
}

export function chunks(title: string, body: string, target = 1800, overlap = 280) {
  return splitText(`${title}\n${plain(body)}`, target, overlap);
}

export function vector(v: number[]) {
  return `{${v.map(n => (Number.isFinite(n) ? n : 0)).join(",")}}`;
}
