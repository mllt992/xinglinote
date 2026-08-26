import { fail } from "@kb/shared";

/** 普通成员只能管理自己创建的分享；Owner/Admin 可以管理工作区全部分享。 */
export function canManageShare(role: string | null, actorId: string, creatorId: string) {
  return !!role && (role === "owner" || role === "admin" || actorId === creatorId);
}

/**
 * 数据库写入必须返回实际保存的行才算成功。PostgreSQL 的 55P03 表示 lock_timeout，
 * 转成可重试的 409，避免既不成功又长期占着 HTTP 连接。
 */
export async function requireRevokedShare<T>(write: () => Promise<T | undefined>): Promise<T> {
  let saved: T | undefined;
  try {
    saved = await write();
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === "55P03") {
      throw fail("CONFLICT_VERSION", "这条分享正在被其他操作占用，请稍后重试");
    }
    throw e;
  }
  if (!saved) throw fail("NOT_FOUND", "分享不存在");
  return saved;
}
