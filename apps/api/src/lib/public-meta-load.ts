import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.ts";
import { notes } from "../db/schema.ts";
import { loadLiveShare, loadLiveSite, renderShare } from "./share-render.ts";
import { neutralMeta, publicExcerpt, type PublicMeta } from "./public-meta.ts";

/** 爬虫与浏览器同一响应，始终不读取会话；解锁浏览器也不把秘密标题写进可缓存 HTML。 */
export async function loadPublicMeta(pathname: string): Promise<PublicMeta> {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "p" && (parts.length === 2 || parts.length === 3)) {
    const share = await loadLiveShare(parts[1]);
    if (share.passwordHash) return neutralMeta();
    const data = await renderShare(share, parts[2]);
    return {
      title: "noteTitle" in data ? data.noteTitle ?? data.title : data.title,
      description: "bodyMd" in data ? publicExcerpt(data.bodyMd) : "星璃笔记 · 分享附件",
      allowRobots: share.allowRobots,
    };
  }
  if (parts[0] === "s" && (parts.length === 3 || parts.length === 4)) {
    const { nb } = await loadLiveSite(parts[1], parts[2]);
    if (!parts[3]) return { title: nb.title, description: `${nb.title} · 星璃笔记文档站`, allowRobots: false };
    // 必须是当前站点已公开且审核通过的篇；不能调用有首次发布副作用的 renderSite。
    const [note] = await db.select({ title: notes.title, bodyMd: notes.bodyMd }).from(notes).where(and(
      eq(notes.id, parts[3]), eq(notes.notebookId, nb.id), eq(notes.published, true),
      eq(notes.moderationStatus, "none"), isNull(notes.trashedAt),
    ));
    return note ? { title: `${note.title} · ${nb.title}`, description: publicExcerpt(note.bodyMd), allowRobots: false } : neutralMeta();
  }
  return neutralMeta();
}
