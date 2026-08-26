/**
 * 后端采用软撤销保留审计记录，但分享弹窗里的“删除”语义是从可管理列表移除。
 * 只有接口明确返回 revoked 才更新界面，避免请求返回异常数据时产生假成功。
 */
export function assertConfirmedRevokedShare<T extends { status: string }>(revoked: T): asserts revoked is T {
  if (revoked.status !== "revoked") throw new Error("撤销接口未确认链接已经失效");
}

export function removeConfirmedRevokedShare<T extends { id: string; status: string }>(rows: T[], revoked: T) {
  assertConfirmedRevokedShare(revoked);
  return rows.filter(row => row.id !== revoked.id);
}
