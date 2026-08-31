/**
 * 版本历史合并（设计 03 §2.4）：notes.version 照常 +1，
 * 同一篇、同一 source、5 分钟内的连续保存复用同一条 note_versions。
 * 协同 / 勾选 / UI 自动保存 / MCP 改正文共用这一份判断，避免各写一套窗口。
 */

export const NOTE_VERSION_MERGE_MS = 5 * 60_000;

export type MergeableVersionRow = {
  id: string;
  version: number;
  source: string;
  editorId?: string;
  createdAt: Date;
  /** 非空名字 = 用户钉住的快照，不能再被 5 分钟合并覆盖。 */
  name?: string | null;
};

export function mergeableNoteVersion(
  rows: Array<MergeableVersionRow>,
  opts: {
    currentVersion: number;
    source: string;
    /** 传入则必须同一编辑者才能合并；协同房间不传（一处落库、多人输入）。 */
    editorId?: string;
    now?: number;
    windowMs?: number;
  },
): string | null {
  const last = rows.find(row => row.version === opts.currentVersion);
  if (!last || last.source !== opts.source) return null;
  if (last.name?.trim()) return null;
  if (opts.editorId !== undefined && last.editorId !== opts.editorId) return null;
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? NOTE_VERSION_MERGE_MS;
  return now - last.createdAt.getTime() < windowMs ? last.id : null;
}
