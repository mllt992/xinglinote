import { and, eq, isNull } from "drizzle-orm";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { mindMaps, mindMapNoteLinks, notebooks, notes, workspaces } from "../db/schema.ts";
import { projectionCurrent } from "./board-projection.ts";

export async function publicBoard(map: typeof mindMaps.$inferSelect) {
  if (!projectionCurrent(map)) throw fail('NOT_FOUND','预览不存在或需要刷新');
  const [nb] = await db.select({trashedAt:notebooks.trashedAt}).from(notebooks).where(eq(notebooks.id,map.notebookId));
  if (!nb || nb.trashedAt) throw fail('NOT_FOUND','预览不存在或需要刷新');
  const links=await db.select({title:notes.title,noteId:notes.id,wsSlug:workspaces.slug,nbSlug:notebooks.slug})
    .from(mindMapNoteLinks).innerJoin(notes,eq(notes.id,mindMapNoteLinks.noteId))
    .innerJoin(notebooks,eq(notebooks.id,notes.notebookId)).innerJoin(workspaces,eq(workspaces.id,notebooks.workspaceId))
    .where(and(eq(mindMapNoteLinks.mindMapId,map.id),eq(notes.published,true),eq(notes.moderationStatus,'none'),isNull(notes.trashedAt),eq(notebooks.sitePublished,true),isNull(notebooks.trashedAt)));
  return {kind:map.kind,title:map.title,svg:map.publicSvg!,version:map.version,updatedAt:map.updatedAt,links:links.map(n=>({title:n.title,url:`/s/${encodeURIComponent(n.wsSlug)}/${encodeURIComponent(n.nbSlug)}/${n.noteId}`}))};
}
