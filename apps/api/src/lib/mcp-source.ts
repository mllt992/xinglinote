import type { KnowledgeSourceHit } from "./knowledge-ai.ts";

export const MCP_SOURCE_EXCERPT_MAX = 360;

export type McpSource = {
  note_id: string;
  title: string;
  notebook_id: string;
  path: string;
  version: number;
  updated_at: string;
  excerpt: string;
  relevance_score?: number;
};

/** 路径是展示与溯源信息；斜杠替换为全角字符，避免标题伪装成额外层级。 */
export function mcpSourcePath(parts: string[]) {
  return `/${parts.map(part => part.replaceAll("/", "／")).join("/")}`;
}

export function toMcpSource(hit: KnowledgeSourceHit, path: string[]): McpSource {
  return {
    note_id: hit.noteId,
    title: hit.title,
    notebook_id: hit.notebookId,
    path: mcpSourcePath(path),
    version: hit.version,
    updated_at: hit.updatedAt.toISOString(),
    excerpt: hit.excerpt.slice(0, MCP_SOURCE_EXCERPT_MAX),
    relevance_score: hit.score,
  };
}
