import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { aiProviders, backgroundJobs, notes } from "../db/schema.ts";
import { memberRole } from "./workspace.ts";

type DbLike = Pick<typeof db, "select" | "insert" | "update" | "delete">;

/** Provider 绑定的工作区。旧行只有 workspace_id 时回退成单元素数组。 */
export function providerWorkspaceIds(p: { workspaceId: string; workspaceIds?: unknown }): string[] {
  const raw = Array.isArray(p.workspaceIds)
    ? p.workspaceIds.filter((id): id is string => typeof id === "string" && !!id)
    : [];
  return [...new Set(raw.length ? raw : p.workspaceId ? [p.workspaceId] : [])];
}

/** 新客户端传 workspaceIds[]，单数 workspaceId 与路由参数只用于兼容旧请求。 */
export function resolveProviderWorkspaceIds(input: { workspaceIds?: string[] | null; workspaceId?: string | null }): string[] {
  const raw = input.workspaceIds?.length ? input.workspaceIds : input.workspaceId ? [input.workspaceId] : [];
  const ids = [...new Set(raw.filter(Boolean))];
  if (!ids.length) throw fail("VALIDATION", "至少选一个工作区");
  return ids;
}

export function aiProviderCoversWorkspace(wsId: string) {
  return or(
    eq(aiProviders.workspaceId, wsId),
    sql`${aiProviders.workspaceIds} @> ${JSON.stringify([wsId])}::jsonb`,
  );
}

/** 公用配置会影响所有成员，每个绑定区都要是管理员；私人配置只要仍是成员。 */
export async function assertProviderWorkspaces(userId: string, workspaceIds: string[], personal: boolean) {
  if (!workspaceIds.length) throw fail("VALIDATION", "至少选一个工作区");
  for (const id of workspaceIds) {
    const role = await memberRole(id, userId);
    if (!role) throw fail("FORBIDDEN", "不是工作区成员");
    if (!personal && role !== "owner" && role !== "admin") {
      throw fail("FORBIDDEN", "只有 Owner 或 Admin 能给工作区配置 AI");
    }
  }
}

export async function canManageProvider(userId: string, p: { ownerUserId: string | null; workspaceId: string; workspaceIds?: unknown }) {
  if (p.ownerUserId) return p.ownerUserId === userId;
  for (const id of providerWorkspaceIds(p)) {
    const role = await memberRole(id, userId);
    if (role !== "owner" && role !== "admin") return false;
  }
  return true;
}

/** Provider 变动后把现有 AI 可读笔记补进索引队列；分批避免大工作区撑爆单条 INSERT。 */
export async function enqueueAiIndexForWorkspaces(tx: DbLike, workspaceIds: string[]) {
  const ids = [...new Set(workspaceIds)];
  if (!ids.length) return;
  const rows = await tx.select({ id: notes.id }).from(notes).where(and(
    inArray(notes.workspaceId, ids),
    eq(notes.aiIndex, true),
    isNull(notes.trashedAt),
  ));
  for (let at = 0; at < rows.length; at += 500) {
    await tx.insert(backgroundJobs).values(rows.slice(at, at + 500).map(n => ({ type: "index_note", payload: { noteId: n.id } })));
  }
}

/** 工作区被物理删除时缩小 Provider 范围；最后一个绑定也没了才删配置。 */
export async function dropWorkspaceFromAiProviders(tx: DbLike, workspaceId: string) {
  const rows = await tx.select().from(aiProviders).where(aiProviderCoversWorkspace(workspaceId));
  for (const p of rows) {
    const next = providerWorkspaceIds(p).filter(id => id !== workspaceId);
    if (!next.length) await tx.delete(aiProviders).where(eq(aiProviders.id, p.id));
    else await tx.update(aiProviders).set({ workspaceId: next[0]!, workspaceIds: next, updatedAt: new Date() }).where(eq(aiProviders.id, p.id));
  }
}
