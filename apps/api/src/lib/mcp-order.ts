/**
 * 只在被点名条目原来占据的槽位内重排，其余同级条目保持原位。
 *
 * MCP 可能因为 ai_index 范围看不见部分笔记，不能要求调用方提交整层 id；
 * 直接把子集写成 0..n 又会和隐藏条目的 sort_key 撞车。稳定槽位合并同时解决两件事。
 */
export function reorderSubset(currentIds: readonly string[], orderedSubset: readonly string[]) {
  if (new Set(orderedSubset).size !== orderedSubset.length) return null;
  const wanted = new Set(orderedSubset);
  if (orderedSubset.some(id => !currentIds.includes(id))) return null;
  const slots = currentIds.flatMap((id, index) => wanted.has(id) ? [index] : []);
  if (slots.length !== orderedSubset.length) return null;
  const result = [...currentIds];
  slots.forEach((slot, index) => { result[slot] = orderedSubset[index]!; });
  return result;
}
