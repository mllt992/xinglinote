import { createHash } from 'node:crypto';
/** 不信任客户端指定主键：用户、目标、类型和随机草稿 id 共同绑定幂等创建。 */
export function captureTargetId(userId: string, targetId: string, kind: 'task' | 'note', captureId: string) {
 const hex=createHash('sha256').update(JSON.stringify([userId,targetId,kind,captureId])).digest('hex');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
