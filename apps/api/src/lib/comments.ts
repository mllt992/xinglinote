/** 评论列表可见性与动态深链。设计 08 §2.1 / §3.3。 */

export function commentListedTo(
  row: { status: string; authorUserId: string | null },
  viewerId?: string,
  canModerate = false,
) {
  if (row.status === "visible") return true;
  if (row.status === "pending") return canModerate;
  if (row.status === "hidden") return canModerate || (!!viewerId && row.authorUserId === viewerId);
  return false;
}

export function feedPostHref(post: { id: string; workspaceId: string | null }) {
  return post.workspaceId ? `/w/${post.workspaceId}/feed/${post.id}` : `/posts/${post.id}`;
}
