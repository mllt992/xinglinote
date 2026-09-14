/**
 * 侧栏树与当前笔记本对齐的纯逻辑。
 * 慢请求、工作区切换、点选笔记本都会并发，结果必须按「是否仍是当前本」裁决，否则列表会串台。
 */

/** 树请求返回后是否仍应对应当前笔记本；否就丢弃，勿 setState。 */
export function shouldApplyNotebookTree(requestedId: string | undefined, currentId: string | undefined): boolean {
  return !!requestedId && requestedId === currentId;
}

/**
 * 工作区笔记本列表加载完后选哪一本：
 * - preferred 仍在列表里 → 保留（深链笔记、点选尚未被冲掉）
 * - 否则第一本；空列表则 undefined
 */
export function pickNotebookAfterLoad(
  notebooks: ReadonlyArray<{ id: string }>,
  preferredId: string | undefined,
): string | undefined {
  if (preferredId && notebooks.some((n) => n.id === preferredId)) return preferredId;
  return notebooks[0]?.id;
}

/**
 * 深链/搜索打开的笔记要不要把侧栏拽过去。
 * 用户刚点了另一本（autoOpen）时先别抢，等自动打开或用户再点标签。
 */
export function shouldFollowNoteNotebook(
  noteNotebookId: string | undefined,
  autoOpenNotebookId: string | null,
): boolean {
  if (!noteNotebookId) return false;
  if (autoOpenNotebookId && autoOpenNotebookId !== noteNotebookId) return false;
  return true;
}
