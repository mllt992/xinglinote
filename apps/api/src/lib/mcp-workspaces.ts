import { and, eq, inArray, or, sql } from "drizzle-orm";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { mcpDailyUsage, mcpTokens, notebooks, oauthRequests } from "../db/schema.ts";
import { memberRole } from "./workspace.ts";

export type McpTokenRow = typeof mcpTokens.$inferSelect;

type DbLike = Pick<typeof db, "select" | "update" | "delete">;

/** 钥匙勾选的工作区。旧行只有 workspace_id 时回退成单元素数组。 */
export function tokenWorkspaceIds(t: { workspaceId: string; workspaceIds?: unknown }): string[] {
  const raw = Array.isArray(t.workspaceIds) ? t.workspaceIds.filter((id): id is string => typeof id === "string" && !!id) : [];
  const ids = raw.length ? raw : t.workspaceId ? [t.workspaceId] : [];
  return [...new Set(ids)];
}

/** POST/PATCH/OAuth 都认 workspaceIds[]，单数 workspaceId 只为兼容旧客户端。 */
export function resolveWorkspaceIds(input: { workspaceIds?: string[] | null; workspaceId?: string | null }): string[] {
  const raw = input.workspaceIds?.length ? input.workspaceIds : input.workspaceId ? [input.workspaceId] : [];
  const ids = [...new Set(raw.filter(Boolean))];
  if (!ids.length) throw fail("VALIDATION", "至少选一个工作区");
  return ids;
}

export function mcpTokenCoversWorkspace(wsId: string) {
  return or(
    eq(mcpTokens.workspaceId, wsId),
    sql`${mcpTokens.workspaceIds} @> ${JSON.stringify([wsId])}::jsonb`,
  );
}

export function tokenDto<T extends { secretHash: string; workspaceId: string; workspaceIds?: unknown }>(t: T) {
  const { secretHash: _, ...rest } = t;
  const workspaceIds = tokenWorkspaceIds(t);
  return { ...rest, workspaceId: workspaceIds[0] ?? t.workspaceId, workspaceIds };
}

/** 创建/编辑时校验：每个区都得是成员；只要有一个 Viewer，钥匙就只能只读。 */
export async function assertTokenWorkspaces(userId: string, workspaceIds: string[], rw: string) {
  if (!workspaceIds.length) throw fail("VALIDATION", "至少选一个工作区");
  for (const id of workspaceIds) {
    const role = await memberRole(id, userId);
    if (!role) throw fail("FORBIDDEN", "不是工作区成员");
    if (role === "viewer" && rw !== "read") throw fail("FORBIDDEN", "Viewer 只能创建只读钥匙");
  }
}

/** 鉴权时的有效范围 = 钥匙勾选 ∩ 当前成员资格。 */
export async function liveWorkspaceIds(t: { workspaceId: string; workspaceIds?: unknown }, userId: string): Promise<string[]> {
  const out: string[] = [];
  for (const id of tokenWorkspaceIds(t)) {
    if (await memberRole(id, userId)) out.push(id);
  }
  return out;
}

/**
 * 人离开某个区 / 区被注销时，从相关钥匙里拿掉该区。
 * 一个区都不剩：revoke-empty 吊销（区还在），delete-empty 物理删（区马上要没了）。
 */
export async function dropWorkspaceFromMcpTokens(
  tx: DbLike,
  opts: { workspaceId: string; userId?: string; empty: "revoke" | "delete" },
) {
  const conds = [mcpTokenCoversWorkspace(opts.workspaceId)];
  if (opts.userId) conds.push(eq(mcpTokens.userId, opts.userId));
  const rows = await tx.select().from(mcpTokens).where(and(...conds));
  for (const t of rows) {
    const next = tokenWorkspaceIds(t).filter(id => id !== opts.workspaceId);
    const notebookIds = (t.notebookIds as string[]) ?? [];
    let nextNotebooks = notebookIds;
    if (notebookIds.length) {
      const gone = await tx.select({ id: notebooks.id }).from(notebooks)
        .where(and(inArray(notebooks.id, notebookIds), eq(notebooks.workspaceId, opts.workspaceId)));
      const drop = new Set(gone.map(n => n.id));
      nextNotebooks = notebookIds.filter(id => !drop.has(id));
    }
    if (!next.length) {
      if (opts.empty === "delete") {
        await tx.update(oauthRequests).set({ tokenId: null }).where(eq(oauthRequests.tokenId, t.id));
        await tx.delete(mcpDailyUsage).where(eq(mcpDailyUsage.tokenId, t.id));
        await tx.delete(mcpTokens).where(eq(mcpTokens.id, t.id));
      } else {
        await tx.update(mcpTokens).set({ status: "revoked", notebookIds: nextNotebooks }).where(eq(mcpTokens.id, t.id));
      }
      continue;
    }
    await tx.update(mcpTokens).set({
      workspaceId: next[0]!,
      workspaceIds: next,
      notebookIds: nextNotebooks,
    }).where(eq(mcpTokens.id, t.id));
  }
}
