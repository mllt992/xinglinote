import { and, desc, eq } from "drizzle-orm";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { aiProviders } from "../db/schema.ts";
import { safeFetch } from "./net-guard.ts";
import { open } from "./secrets.ts";

export type Provider = typeof aiProviders.$inferSelect;
export type ChatProvider = { baseUrl: string; chatModel: string; apiKey: string };

/** 本人的私有配置优先，其次才是工作区公用的那份。 */
export async function aiProvider(wsId: string, userId?: string) {
  const rows = await db
    .select()
    .from(aiProviders)
    .where(and(eq(aiProviders.workspaceId, wsId), eq(aiProviders.enabled, true)))
    .orderBy(desc(aiProviders.createdAt));
  return rows.find(p => p.ownerUserId === userId) ?? rows.find(p => !p.ownerUserId);
}

/**
 * baseUrl 是用户填的，所以每次真正发请求前都要再过一遍出站护栏（DNS 可能被改指向），
 * 并且必须带超时——一个吊住不返回的 provider 会把请求和 worker 任务一起占死。
 */
export async function embed(p: Provider, input: string[]) {
  if (!p.embeddingModel) throw fail("AI_NOT_CONFIGURED", "请先配置 Embedding 模型");
  const r = await safeFetch(`${p.baseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${open(p.apiKey)}` },
    body: JSON.stringify({ model: p.embeddingModel, input }),
  }, "AI 提供商地址");
  if (!r.ok) throw fail("AI_PROVIDER_ERROR", `Embedding 请求失败 (${r.status})`);
  const d = (await r.json()) as { data?: Array<{ index: number; embedding: number[] }> };
  return (d.data ?? []).sort((a, b) => a.index - b.index).map(x => x.embedding);
}

type ChatResponse = { choices?: Array<{ message?: { content?: string } }>; usage?: Record<string, number> };

/** 唯一一份聊天调用。routes/ai.ts 以前自己抄了一模一样的一份，别再抄了。 */
export async function chatAi(p: ChatProvider, messages: Array<{ role: string; content: string }>, opts?: { temperature?: number }) {
  const r = await safeFetch(`${p.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${open(p.apiKey)}` },
    body: JSON.stringify({ model: p.chatModel, messages, temperature: opts?.temperature ?? 0.2 }),
  }, "AI 提供商地址");
  if (!r.ok) throw fail("AI_PROVIDER_ERROR", `模型请求失败 (${r.status})`);
  const d = (await r.json()) as ChatResponse;
  return { content: String(d.choices?.[0]?.message?.content ?? ""), usage: d.usage ?? {} };
}

export function plain(md: string) {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, t, d) => d || t)
    .replace(/[#>*_~`-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function chunks(title: string, body: string, target = 1800, overlap = 280) {
  const text = `${title}\n${plain(body)}`.trim();
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(text.length, at + target);
    if (end < text.length) {
      const cut = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf("。", end), text.lastIndexOf(" ", end));
      if (cut > at + target / 2) end = cut + 1;
    }
    out.push(text.slice(at, end));
    if (end >= text.length) break;
    at = Math.max(at + 1, end - overlap);
  }
  return out;
}

export function vector(v: number[]) {
  return `{${v.map(n => (Number.isFinite(n) ? n : 0)).join(",")}}`;
}
