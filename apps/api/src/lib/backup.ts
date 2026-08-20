import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  attachments, comments, corrections, folders, notebookMembers, notebooks, notes, noteVersions,
  posts, postReactions, shareLinks, workspaceMembers, workspaces,
} from "../db/schema.ts";

/** `inArray` 传空数组在部分驱动上会生成 `in ()`，统一先挡掉。 */
const byIds = async <T>(ids: string[], run: (ids: string[]) => Promise<T[]>) => (ids.length ? run(ids) : []);

/**
 * 一个工作区的完整快照。
 *
 * 这里的每一张表都按 workspace / notebook / note 收敛到 WHERE 里：
 * 以前 notebookMembers、noteVersions、comments、corrections、postReactions
 * 都是 `select * from X` 再在 JS 里 filter，备份一个小工作区会把**全实例**的
 * 历史版本读进内存，而 note_versions 正是增长最快的表。
 */
export async function workspaceSnapshot(id: string) {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, id));
  if (!workspace) throw new Error("workspace missing");

  const nbs = await db.select().from(notebooks).where(eq(notebooks.workspaceId, id));
  const ns = await db.select().from(notes).where(eq(notes.workspaceId, id));
  const nbIds = nbs.map(n => n.id);
  const noteIds = ns.map(n => n.id);
  const ps = await db.select().from(posts).where(eq(posts.workspaceId, id));
  const postIds = ps.map(p => p.id);

  return {
    format: "knowledge-workspace-backup",
    version: 2,
    exportedAt: new Date().toISOString(),
    workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
    members: await db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, id)),
    notebooks: nbs,
    notebookMembers: await byIds(nbIds, ids => db.select().from(notebookMembers).where(inArray(notebookMembers.notebookId, ids))),
    folders: await db.select().from(folders).where(eq(folders.workspaceId, id)),
    notes: ns,
    attachments: await db.select().from(attachments).where(eq(attachments.workspaceId, id)),
    versions: await byIds(noteIds, ids => db.select().from(noteVersions).where(inArray(noteVersions.noteId, ids))),
    shares: await db.select().from(shareLinks).where(eq(shareLinks.workspaceId, id)),
    comments: await byIds(noteIds, ids => db.select().from(comments).where(inArray(comments.targetId, ids))),
    corrections: await byIds(noteIds, ids => db.select().from(corrections).where(inArray(corrections.noteId, ids))),
    posts: ps,
    reactions: await byIds(postIds, ids => db.select().from(postReactions).where(inArray(postReactions.postId, ids))),
  };
}

export function checksum(x: Buffer) {
  return createHash("sha256").update(x).digest("hex");
}

export function fingerprint(pass: string) {
  return createHash("sha256").update(pass).digest("hex").slice(0, 16);
}

export function encryptPackage(raw: Buffer, pass: string) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(pass, salt, 32);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(raw), c.final()]);
  return Buffer.concat([Buffer.from("KBENC1"), salt, iv, c.getAuthTag(), body]);
}

export function decryptPackage(raw: Buffer, pass: string) {
  if (raw.subarray(0, 6).toString() !== "KBENC1") return raw;
  const salt = raw.subarray(6, 22);
  const iv = raw.subarray(22, 34);
  const tag = raw.subarray(34, 50);
  const d = createDecipheriv("aes-256-gcm", scryptSync(pass, salt, 32), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(raw.subarray(50)), d.final()]);
}
