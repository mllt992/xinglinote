import { fail } from "@kb/shared";
import { memberRole } from "./workspace.ts";

type Post = { id: string; authorUserId: string; workspaceId: string | null; visibility: string; status: string };

/** 别人当它不存在：已删、或不是作者却还在审。圈子还要是成员。 */
export async function assertCanSeePost(post: Post | undefined, viewerId?: string) {
  if (!post || post.status === "deleted") throw fail("NOT_FOUND", "动态不存在");
  if (post.status !== "visible" && post.authorUserId !== viewerId) throw fail("NOT_FOUND", "动态不存在");
  if (post.visibility === "workspace") {
    if (!viewerId || !post.workspaceId || !(await memberRole(post.workspaceId, viewerId))) {
      throw fail("FORBIDDEN", "无权查看此动态");
    }
  }
}

/** 广场：作者 + 实例管理员；圈子另加该工作区 Owner/Admin。设计 08 §3.3。 */
export async function assertCanModeratePost(post: Post, user: { id: string; roleInstance: string }) {
  if (post.authorUserId === user.id || user.roleInstance === "admin") return;
  if (post.visibility === "workspace" && post.workspaceId) {
    const role = await memberRole(post.workspaceId, user.id);
    if (role === "owner" || role === "admin") return;
  }
  throw fail("FORBIDDEN", "无权审核这条内容");
}
