import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  agents, attachments, backupRuns, backupTargets, calendarFeedTokens, calendarItems,
  calendarOverrides, calendarReminders, calendarSubscriptions, calendarTemplates,
  comments, contentReports, corrections, folders, instanceSettings, moderationReviews, projectColumns, projectMilestones, projectTasks, projectTimeEntries, projects,
  navGroups, navLinks, notebookMembers, notebooks, notes, noteVersions, notifications,
  posts, postAssets, postReactions, registrationCodes, registrationCodeUsages,
  savedShares, serviceRequests, shareLinks, themes, users, workspaceMembers, workspaces,
} from "../db/schema.ts";
import { projectTags, projectTaskMilestones, projectTaskTags } from "../db/project-tags.ts";
import { applyRetention, upload, type BackupCred, type BackupTargetRef } from "./backup-transfer.ts";
import { checksum, encryptPackage, fingerprint, WORKSPACE_BACKUP_VERSION } from "./backup-package.ts";
import { readStoredFile } from "./blobs.ts";
import { open } from "./secrets.ts";

export { checksum, decryptPackage, encryptPackage, fingerprint } from "./backup-package.ts";

/** `inArray` 传空数组在部分驱动上会生成 `in ()`，统一先挡掉。 */
const byIds = async <T>(ids: string[], run: (ids: string[]) => Promise<T[]>) => (ids.length ? run(ids) : []);

type TargetRow = typeof backupTargets.$inferSelect;

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
  const items = await db.select().from(calendarItems).where(eq(calendarItems.workspaceId, id));
  const itemIds = items.map(i => i.id);
  const projectRows = await db.select().from(projects).where(eq(projects.workspaceId, id));
  const projectIds = projectRows.map(p => p.id);

  const attachmentRows = await db.select().from(attachments).where(eq(attachments.workspaceId, id));
  const attachmentFiles: Array<{ attachmentId: string; bytes: number; sha256: string; dataBase64: string }> = [];
  for (const attachment of attachmentRows) {
    const raw = await readStoredFile(attachment);
    if (checksum(raw) !== attachment.sha256 || raw.length !== attachment.bytes) {
      throw new Error(`附件 ${attachment.id} 的磁盘文件与元数据不一致`);
    }
    attachmentFiles.push({ attachmentId: attachment.id, bytes: raw.length, sha256: attachment.sha256, dataBase64: raw.toString("base64") });
  }
  const postAssetRows = await byIds(postIds, ids => db.select().from(postAssets).where(inArray(postAssets.postId, ids)));
  const postAssetFiles: Array<{ postAssetId: string; bytes: number; sha256: string; dataBase64: string }> = [];
  for (const asset of postAssetRows) {
    const raw = await readStoredFile({ ...asset, postAssetId: asset.id });
    if (checksum(raw) !== asset.sha256 || raw.length !== asset.bytes) {
      throw new Error(`动态附件 ${asset.id} 的磁盘文件与元数据不一致`);
    }
    postAssetFiles.push({ postAssetId: asset.id, bytes: raw.length, sha256: asset.sha256, dataBase64: raw.toString("base64") });
  }

  return {
    format: "knowledge-workspace-backup",
    version: WORKSPACE_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    manifest: { applicationVersion: process.env.APP_VERSION ?? process.env.npm_package_version ?? "unknown", databaseSchemaVersion: 4, dataFileVersion: 1, schemaVersion: 4, capabilities: ["attachment_files", "strict_refs", "token_rotation"] },
    workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
    members: await db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, id)),
    notebooks: nbs,
    notebookMembers: await byIds(nbIds, ids => db.select().from(notebookMembers).where(inArray(notebookMembers.notebookId, ids))),
    folders: await db.select().from(folders).where(eq(folders.workspaceId, id)),
    notes: ns,
    attachments: attachmentRows,
    attachmentFiles,
    versions: await byIds(noteIds, ids => db.select().from(noteVersions).where(inArray(noteVersions.noteId, ids))),
    shares: await db.select().from(shareLinks).where(eq(shareLinks.workspaceId, id)),
    comments: await byIds([...noteIds, ...postIds], ids => db.select().from(comments).where(inArray(comments.targetId, ids))),
    corrections: await byIds(noteIds, ids => db.select().from(corrections).where(inArray(corrections.noteId, ids))),
    posts: ps,
    postAssets: postAssetRows,
    postAssetFiles,
    reactions: await byIds(postIds, ids => db.select().from(postReactions).where(inArray(postReactions.postId, ids))),
    calendarItems: items,
    calendarOverrides: await byIds(itemIds, ids => db.select().from(calendarOverrides).where(inArray(calendarOverrides.itemId, ids))),
    calendarReminders: await byIds(itemIds, ids => db.select().from(calendarReminders).where(inArray(calendarReminders.itemId, ids))),
    calendarSubscriptions: await db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.workspaceId, id)),
    calendarTemplates: await db.select().from(calendarTemplates).where(eq(calendarTemplates.workspaceId, id)),
    calendarFeedTokens: await db.select().from(calendarFeedTokens).where(eq(calendarFeedTokens.workspaceId, id)),
    projects: projectRows,
    projectColumns: await byIds(projectIds, ids => db.select().from(projectColumns).where(inArray(projectColumns.projectId, ids))),
    projectTasks: await byIds(projectIds, ids => db.select().from(projectTasks).where(inArray(projectTasks.projectId, ids))),
    projectTimeEntries: await byIds(projectIds, ids => db.select().from(projectTimeEntries).where(inArray(projectTimeEntries.projectId, ids))),
    projectMilestones: await byIds(projectIds, ids => db.select().from(projectMilestones).where(inArray(projectMilestones.projectId, ids))),
    projectTags: await byIds(projectIds, ids => db.select().from(projectTags).where(inArray(projectTags.projectId, ids))),
    projectTaskTags: await byIds(
      (await byIds(projectIds, ids => db.select({ id: projectTasks.id }).from(projectTasks).where(inArray(projectTasks.projectId, ids)))).map(t => t.id),
      ids => db.select().from(projectTaskTags).where(inArray(projectTaskTags.taskId, ids)),
    ),
    projectTaskMilestones: await byIds(
      (await byIds(projectIds, ids => db.select({ id: projectTasks.id }).from(projectTasks).where(inArray(projectTasks.projectId, ids)))).map(t => t.id),
      ids => db.select().from(projectTaskMilestones).where(inArray(projectTaskMilestones.taskId, ids)),
    ),
  };
}
