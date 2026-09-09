import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  agentReplies, agents, aiChunks, attachments, authTokens, calendarFeedTokens, calendarItems,
  calendarOverrides, calendarReminders, calendarSubscriptions, calendarTemplates,
  comments, contentReports, corrections, folders, instanceSettings, links, mcpAttachmentUploads, mcpTokens,
  moderationReviews, navGroups, navLinks, notebookMembers, notebooks, noteCollab,
  notes, noteFavorites, noteVersions, noteVisits, postAssets, postFavorites, postReactions, posts, projectColumns, projectMilestones, projectTasks, projectTimeEntries, projects,
  registrationCodes, registrationCodeUsages, savedShares, serviceRequests, sessions,
  shareLinks, themes, users, workspaceInvites, workspaceMembers, workspaces,
} from "../db/schema.ts";
import type { BackupPackage, InstanceBackupPackage, WorkspaceBackupPackage } from "./backup-package.ts";
import { checksum } from "./backup-package.ts";
import { putBlob, readStoredFile, releaseBlob, releaseStoredFile, type BlobRef } from "./blobs.ts";
import { writeNoteFile } from "./files.ts";
import { purgeWorkspaceProjects } from "./trash.ts";
import { noteCandidates, rebuildLinks } from "./links.ts";
import { seal } from "./secrets.ts";
import { secureToken } from "./tokens.ts";

type Row = Record<string, unknown>;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type RestoreMode = "new_workspace" | "replace_workspace" | "bootstrap_empty_instance" | "replace_instance_metadata";

export type RestoreResult = {
  workspaceId: string | null;
  stats: Record<string, number>;
  warnings: string[];
  rotatedSecrets: string[];
};

const DATE_KEYS = new Set([
  "createdAt", "updatedAt", "trashedAt", "revokedAt", "editedAt", "reviewedAt", "doneAt",
  "startsAt", "endsAt", "dueAt", "rruleUntil", "occurrenceStart", "newStart", "newEnd",
  "absoluteAt", "firedAt", "lastSyncAt", "lastUsedAt", "emailVerifiedAt", "deletionRequestedAt",
  "deletionScheduledAt", "decidedAt", "expiresAt", "installedAt", "sitePublishRequestedAt",
  "startAt", "archivedAt", "completedAt", "startedAt", "endedAt",
]);

function revive(row: Row) {
  const out: Row = { ...row };
  for (const key of DATE_KEYS) if (typeof out[key] === "string") out[key] = new Date(out[key] as string);
  return out;
}

function idMap(rows: Row[]) {
  return new Map(rows.map(row => [String(row.id), crypto.randomUUID()]));
}

function mapped(map: Map<string, string>, value: unknown) {
  if (value === null || value === undefined) return null;
  return map.get(String(value)) ?? null;
}

async function insertRows(tx: Tx, table: unknown, values: Row[]) {
  for (let at = 0; at < values.length; at += 200) {
    await (tx.insert as Function)(table).values(values.slice(at, at + 200));
  }
}

async function knownUsers() {
  return new Set((await db.select({ id: users.id }).from(users)).map(user => user.id));
}

function userMapper(existing: Set<string>, actorId: string) {
  return (value: unknown) => typeof value === "string" && existing.has(value) ? value : actorId;
}

type StagedFiles = {
  attachments: Map<string, BlobRef>;
  postAssets: Map<string, BlobRef>;
  refs: string[];
};

async function stageFiles(snapshot: WorkspaceBackupPackage): Promise<StagedFiles> {
  const staged: StagedFiles = { attachments: new Map(), postAssets: new Map(), refs: [] };
  try {
    for (const file of snapshot.attachmentFiles) {
      const raw = Buffer.from(file.dataBase64, "base64");
      if (checksum(raw) !== file.sha256) throw new Error("附件 staging 校验失败");
      const ref = await putBlob(raw);
      staged.attachments.set(file.attachmentId, ref);
      staged.refs.push(ref.sha256);
    }
    for (const file of snapshot.postAssetFiles) {
      const raw = Buffer.from(file.dataBase64, "base64");
      if (checksum(raw) !== file.sha256) throw new Error("动态附件 staging 校验失败");
      const ref = await putBlob(raw);
      staged.postAssets.set(file.postAssetId, ref);
      staged.refs.push(ref.sha256);
    }
    return staged;
  } catch (error) {
    for (const sha of staged.refs) await releaseBlob(sha).catch(() => {});
    throw error;
  }
}

async function releaseStaged(staged: StagedFiles) {
  for (const sha of staged.refs) await releaseBlob(sha).catch(() => {});
}

async function stageInstancePostFiles(snapshot: InstanceBackupPackage) {
  const staged = new Map<string, BlobRef>();
  const refs: string[] = [];
  try {
    for (const file of snapshot.postAssetFiles) {
      const raw = Buffer.from(file.dataBase64, "base64");
      if (checksum(raw) !== file.sha256) throw new Error("广场附件 staging 校验失败");
      const ref = await putBlob(raw);
      staged.set(file.postAssetId, ref);
      refs.push(ref.sha256);
    }
    return { staged, refs };
  } catch (error) {
    for (const sha of refs) await releaseBlob(sha).catch(() => {});
    throw error;
  }
}

async function deleteWorkspaceContents(tx: Tx, workspaceId: string) {
  const noteRows = await tx.select({ id: notes.id }).from(notes).where(eq(notes.workspaceId, workspaceId));
  const noteIds = noteRows.map(row => row.id);
  const postRows = await tx.select({ id: posts.id }).from(posts).where(eq(posts.workspaceId, workspaceId));
  const postIds = postRows.map(row => row.id);
  const itemRows = await tx.select({ id: calendarItems.id }).from(calendarItems).where(eq(calendarItems.workspaceId, workspaceId));
  const itemIds = itemRows.map(row => row.id);
  const nbRows = await tx.select({ id: notebooks.id }).from(notebooks).where(eq(notebooks.workspaceId, workspaceId));
  const nbIds = nbRows.map(row => row.id);
  if (itemIds.length) {
    await tx.delete(calendarReminders).where(inArray(calendarReminders.itemId, itemIds));
    await tx.delete(calendarOverrides).where(inArray(calendarOverrides.itemId, itemIds));
  }
  await tx.delete(calendarItems).where(eq(calendarItems.workspaceId, workspaceId));
  await purgeWorkspaceProjects(workspaceId, tx);
  await tx.delete(calendarSubscriptions).where(eq(calendarSubscriptions.workspaceId, workspaceId));
  await tx.delete(calendarTemplates).where(eq(calendarTemplates.workspaceId, workspaceId));
  await tx.delete(calendarFeedTokens).where(eq(calendarFeedTokens.workspaceId, workspaceId));
  if (postIds.length) {
    await tx.delete(postReactions).where(inArray(postReactions.postId, postIds));
    await tx.delete(postFavorites).where(inArray(postFavorites.postId, postIds));
    await tx.delete(postAssets).where(inArray(postAssets.postId, postIds));
  }
  if (noteIds.length || postIds.length) {
    const targets = [...noteIds, ...postIds];
    const commentRows = await tx.select({ id: comments.id }).from(comments).where(inArray(comments.targetId, targets));
    if (commentRows.length) await tx.delete(agentReplies).where(inArray(agentReplies.commentId, commentRows.map(comment => comment.id)));
    await tx.delete(comments).where(inArray(comments.targetId, targets));
  }
  await tx.delete(posts).where(eq(posts.workspaceId, workspaceId));
  if (noteIds.length) {
    await tx.delete(mcpAttachmentUploads).where(inArray(mcpAttachmentUploads.noteId, noteIds));
    await tx.delete(corrections).where(inArray(corrections.noteId, noteIds));
    await tx.delete(noteFavorites).where(inArray(noteFavorites.noteId, noteIds));
    await tx.delete(noteVisits).where(inArray(noteVisits.noteId, noteIds));
    await tx.delete(noteCollab).where(inArray(noteCollab.noteId, noteIds));
    await tx.delete(aiChunks).where(inArray(aiChunks.noteId, noteIds));
    await tx.delete(links).where(or(inArray(links.fromNoteId, noteIds), inArray(links.targetNoteId, noteIds))!);
    await tx.delete(noteVersions).where(inArray(noteVersions.noteId, noteIds));
  }
  await tx.delete(shareLinks).where(eq(shareLinks.workspaceId, workspaceId));
  await tx.delete(attachments).where(eq(attachments.workspaceId, workspaceId));
  await tx.delete(notes).where(eq(notes.workspaceId, workspaceId));
  await tx.delete(folders).where(eq(folders.workspaceId, workspaceId));
  if (nbIds.length) await tx.delete(notebookMembers).where(inArray(notebookMembers.notebookId, nbIds));
  await tx.delete(notebooks).where(eq(notebooks.workspaceId, workspaceId));
}

class DrillRollback extends Error {
  result: RestoreResult;
  constructor(result: RestoreResult) { super("drill rollback"); this.result = result; }
}

/**
 * 工作区恢复全部使用新 UUID；这样同名和同源包重复恢复都不会撞主键。
 * drill 在同一事务里完成写入与计数验证后主动回滚。
 */
export async function restoreWorkspacePackage(input: {
  snapshot: WorkspaceBackupPackage;
  actorId: string;
  mode: Extract<RestoreMode, "new_workspace" | "replace_workspace">;
  targetWorkspaceId?: string;
  drill?: boolean;
}): Promise<RestoreResult> {
  const { snapshot, actorId } = input;
  const warnings: string[] = [];
  const existingUsers = await knownUsers();
  const mapUser = userMapper(existingUsers, actorId);
  const targetWorkspaceId = input.drill || input.mode === "new_workspace" ? crypto.randomUUID() : input.targetWorkspaceId;
  if (!targetWorkspaceId) throw new Error("替换恢复缺少目标工作区");
  const nbMap = idMap(snapshot.notebooks);
  const folderMap = idMap(snapshot.folders);
  const noteMap = idMap(snapshot.notes);
  const attachmentMap = idMap(snapshot.attachments);
  const versionMap = idMap(snapshot.versions);
  const shareMap = idMap(snapshot.shares);
  const commentMap = idMap(snapshot.comments);
  const correctionMap = idMap(snapshot.corrections);
  const postMap = idMap(snapshot.posts);
  const postAssetMap = idMap(snapshot.postAssets);
  const itemMap = idMap(snapshot.calendarItems);
  const overrideMap = idMap(snapshot.calendarOverrides);
  const reminderMap = idMap(snapshot.calendarReminders);
  const subscriptionMap = idMap(snapshot.calendarSubscriptions);
  const templateMap = idMap(snapshot.calendarTemplates);
  const feedMap = idMap(snapshot.calendarFeedTokens);
  const projectMap = idMap(snapshot.projects);
  const columnMap = idMap(snapshot.projectColumns ?? []);
  const taskMap = idMap(snapshot.projectTasks);
  const timeMap = idMap(snapshot.projectTimeEntries);
  const milestoneMap = idMap(snapshot.projectMilestones);
  const staged = await stageFiles(snapshot);
  let oldFiles: Array<typeof attachments.$inferSelect> = [];
  let oldPostFiles: Array<typeof postAssets.$inferSelect> = [];
  const restoredNotes: Array<typeof notes.$inferSelect> = [];
  const stats = {
    notebooks: snapshot.notebooks.length,
    folders: snapshot.folders.length,
    notes: snapshot.notes.length,
    attachments: snapshot.version >= 4 ? snapshot.attachments.length : 0,
    versions: snapshot.versions.length,
    comments: snapshot.comments.length,
    posts: snapshot.posts.length,
    calendarItems: snapshot.calendarItems.length,
    projects: snapshot.projects.length,
  };
  if (snapshot.version === 3 && snapshot.attachments.length) warnings.push(`已跳过 ${snapshot.attachments.length} 个无二进制文件的 v3 附件元数据`);
  try {
    await db.transaction(async tx => {
      // 同一工作区的恢复串行执行；事务结束自动释放锁。
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${targetWorkspaceId}))`);
      if (input.drill || input.mode === "new_workspace") {
        await tx.insert(workspaces).values({
          id: targetWorkspaceId,
          slug: `restored-${targetWorkspaceId.replaceAll("-", "").slice(0, 16)}`,
          name: `${String(snapshot.workspace.name ?? "恢复的工作区")}（恢复）`,
          kind: "normal",
          ownerId: actorId,
          frozen: !!input.drill,
        });
      } else {
        oldFiles = await tx.select().from(attachments).where(eq(attachments.workspaceId, targetWorkspaceId));
        const oldPosts = await tx.select({ id: posts.id }).from(posts).where(eq(posts.workspaceId, targetWorkspaceId));
        oldPostFiles = oldPosts.length ? await tx.select().from(postAssets).where(inArray(postAssets.postId, oldPosts.map(p => p.id))) : [];
        await deleteWorkspaceContents(tx, targetWorkspaceId);
      }

      const members = new Map<string, string>();
      for (const member of snapshot.members) members.set(mapUser(member.userId), String(member.role ?? "viewer"));
      members.set(actorId, "owner");
      if (input.mode === "replace_workspace" && !input.drill) {
        await tx.delete(workspaceInvites).where(eq(workspaceInvites.workspaceId, targetWorkspaceId));
        await tx.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, targetWorkspaceId));
      }
      await insertRows(tx, workspaceMembers, [...members].map(([userId, role]) => ({ workspaceId: targetWorkspaceId, userId, role })));

      await insertRows(tx, notebooks, snapshot.notebooks.map(raw => {
        const value = revive(raw);
        return { ...value, id: nbMap.get(String(raw.id)), workspaceId: targetWorkspaceId, createdBy: mapUser(raw.createdBy), sitePublished: false, sitePublishRequestedBy: null, sitePublishRequestedAt: null };
      }));
      await insertRows(tx, notebookMembers, snapshot.notebookMembers
        .map(raw => ({ ...revive(raw), notebookId: mapped(nbMap, raw.notebookId), userId: mapUser(raw.userId) }))
        .filter(raw => raw.userId !== actorId));
      await insertRows(tx, folders, snapshot.folders.map(raw => ({
        ...revive(raw), id: folderMap.get(String(raw.id)), workspaceId: targetWorkspaceId,
        notebookId: mapped(nbMap, raw.notebookId), parentId: mapped(folderMap, raw.parentId), trashedBy: raw.trashedBy ? mapUser(raw.trashedBy) : null,
      })));
      const noteValues = snapshot.notes.map(raw => ({
        ...revive(raw), id: noteMap.get(String(raw.id)), workspaceId: targetWorkspaceId,
        notebookId: mapped(nbMap, raw.notebookId), folderId: mapped(folderMap, raw.folderId),
        createdBy: mapUser(raw.createdBy), updatedBy: mapUser(raw.updatedBy), trashedBy: raw.trashedBy ? mapUser(raw.trashedBy) : null,
      }));
      await insertRows(tx, notes, noteValues);
      restoredNotes.push(...noteValues as Array<typeof notes.$inferSelect>);
      if (snapshot.version >= 4) await insertRows(tx, attachments, snapshot.attachments.map(raw => {
        const ref = staged.attachments.get(String(raw.id));
        if (!ref) throw new Error("附件 staging 缺失");
        return { ...revive(raw), id: attachmentMap.get(String(raw.id)), workspaceId: targetWorkspaceId, noteId: mapped(noteMap, raw.noteId), storedName: ref.path, sha256: ref.sha256, bytes: ref.bytes, createdBy: mapUser(raw.createdBy) };
      }));
      await insertRows(tx, noteVersions, snapshot.versions.map(raw => ({ ...revive(raw), id: versionMap.get(String(raw.id)), noteId: mapped(noteMap, raw.noteId), editorId: mapUser(raw.editorId) })));

      const targetId = (type: unknown, id: unknown) => type === "notebook" ? mapped(nbMap, id) : type === "folder" ? mapped(folderMap, id) : mapped(noteMap, id);
      await insertRows(tx, shareLinks, snapshot.shares.map(raw => ({
        ...revive(raw), id: shareMap.get(String(raw.id)), token: secureToken(32), workspaceId: targetWorkspaceId,
        targetId: targetId(raw.targetType, raw.targetId), createdBy: mapUser(raw.createdBy), status: "revoked", revokedAt: new Date(),
      })));
      await insertRows(tx, comments, snapshot.comments.map(raw => ({
        ...revive(raw), id: commentMap.get(String(raw.id)), targetId: raw.targetType === "post" ? mapped(postMap, raw.targetId) : mapped(noteMap, raw.targetId),
        shareId: mapped(shareMap, raw.shareId), siteNotebookId: mapped(nbMap, raw.siteNotebookId), parentId: mapped(commentMap, raw.parentId),
        authorUserId: raw.authorUserId ? mapUser(raw.authorUserId) : null, authorAgentId: null,
        resolvedBy: raw.resolvedBy ? mapUser(raw.resolvedBy) : null,
      })));
      await insertRows(tx, corrections, snapshot.corrections.map(raw => ({
        ...revive(raw), id: correctionMap.get(String(raw.id)), noteId: mapped(noteMap, raw.noteId), shareId: mapped(shareMap, raw.shareId),
        siteNotebookId: mapped(nbMap, raw.siteNotebookId), authorUserId: raw.authorUserId ? mapUser(raw.authorUserId) : null,
        reviewedBy: raw.reviewedBy ? mapUser(raw.reviewedBy) : null,
      })));
      await insertRows(tx, posts, snapshot.posts.map(raw => ({
        ...revive(raw), id: postMap.get(String(raw.id)), workspaceId: targetWorkspaceId, noteId: mapped(noteMap, raw.noteId), authorUserId: mapUser(raw.authorUserId),
      })));
      if (snapshot.version >= 4) await insertRows(tx, postAssets, snapshot.postAssets.map(raw => {
        const ref = staged.postAssets.get(String(raw.id));
        if (!ref) throw new Error("动态附件 staging 缺失");
        return { ...revive(raw), id: postAssetMap.get(String(raw.id)), postId: mapped(postMap, raw.postId), storedName: ref.path, sha256: ref.sha256, bytes: ref.bytes, createdBy: mapUser(raw.createdBy) };
      }));
      await insertRows(tx, postReactions, snapshot.reactions.map(raw => ({ ...revive(raw), postId: mapped(postMap, raw.postId), userId: mapUser(raw.userId) })));

      await insertRows(tx, calendarSubscriptions, snapshot.calendarSubscriptions.map(raw => ({
        ...revive(raw), id: subscriptionMap.get(String(raw.id)), workspaceId: targetWorkspaceId,
        url: typeof raw.url === "string" ? raw.url : "about:blank", enabled: typeof raw.url === "string" ? raw.enabled : false, createdBy: mapUser(raw.createdBy),
      })));
      await insertRows(tx, calendarItems, snapshot.calendarItems.map(raw => ({
        ...revive(raw), id: itemMap.get(String(raw.id)), workspaceId: targetWorkspaceId, notebookId: mapped(nbMap, raw.notebookId),
        sourceNoteId: mapped(noteMap, raw.sourceNoteId), sourceSubId: mapped(subscriptionMap, raw.sourceSubId),
        assigneeUserId: raw.assigneeUserId ? mapUser(raw.assigneeUserId) : null, doneBy: raw.doneBy ? mapUser(raw.doneBy) : null,
        createdBy: mapUser(raw.createdBy), updatedBy: mapUser(raw.updatedBy),
      })));
      await insertRows(tx, calendarOverrides, snapshot.calendarOverrides.map(raw => ({ ...revive(raw), id: overrideMap.get(String(raw.id)), itemId: mapped(itemMap, raw.itemId), doneBy: raw.doneBy ? mapUser(raw.doneBy) : null })));
      await insertRows(tx, calendarReminders, snapshot.calendarReminders.map(raw => ({ ...revive(raw), id: reminderMap.get(String(raw.id)), itemId: mapped(itemMap, raw.itemId), status: "pending", firedAt: null })));
      await insertRows(tx, calendarTemplates, snapshot.calendarTemplates.map(raw => ({ ...revive(raw), id: templateMap.get(String(raw.id)), workspaceId: targetWorkspaceId, createdBy: mapUser(raw.createdBy) })));
      await insertRows(tx, calendarFeedTokens, snapshot.calendarFeedTokens.map(raw => ({
        ...revive(raw), id: feedMap.get(String(raw.id)), workspaceId: targetWorkspaceId, userId: mapUser(raw.userId), token: secureToken(32), status: "revoked", lastUsedAt: null,
      })));
      await insertRows(tx, projects, snapshot.projects.map(raw => ({
        ...revive(raw), id: projectMap.get(String(raw.id)), workspaceId: targetWorkspaceId,
        createdBy: mapUser(raw.createdBy), updatedBy: mapUser(raw.updatedBy),
      })));
      await insertRows(tx, projectColumns, (snapshot.projectColumns ?? []).map(raw => ({
        ...revive(raw), id: columnMap.get(String(raw.id)), projectId: mapped(projectMap, raw.projectId),
      })));
      const parentTasks = snapshot.projectTasks.filter(raw => !raw.parentId);
      const childTasks = snapshot.projectTasks.filter(raw => !!raw.parentId);
      await insertRows(tx, projectTasks, parentTasks.map(raw => ({
        ...revive(raw), id: taskMap.get(String(raw.id)), projectId: mapped(projectMap, raw.projectId),
        workspaceId: targetWorkspaceId, parentId: null, sourceNoteId: mapped(noteMap, raw.sourceNoteId),
        assigneeUserId: raw.assigneeUserId ? mapUser(raw.assigneeUserId) : null,
        createdBy: mapUser(raw.createdBy), updatedBy: mapUser(raw.updatedBy),
        completedBy: raw.completedBy ? mapUser(raw.completedBy) : null,
      })));
      await insertRows(tx, projectTasks, childTasks.map(raw => ({
        ...revive(raw), id: taskMap.get(String(raw.id)), projectId: mapped(projectMap, raw.projectId),
        workspaceId: targetWorkspaceId, parentId: mapped(taskMap, raw.parentId), sourceNoteId: mapped(noteMap, raw.sourceNoteId),
        assigneeUserId: raw.assigneeUserId ? mapUser(raw.assigneeUserId) : null,
        createdBy: mapUser(raw.createdBy), updatedBy: mapUser(raw.updatedBy),
        completedBy: raw.completedBy ? mapUser(raw.completedBy) : null,
      })));
      await insertRows(tx, projectTimeEntries, snapshot.projectTimeEntries.map(raw => ({
        ...revive(raw), id: timeMap.get(String(raw.id)), projectId: mapped(projectMap, raw.projectId),
        taskId: mapped(taskMap, raw.taskId), userId: mapUser(raw.userId),
      })));
      await insertRows(tx, projectMilestones, snapshot.projectMilestones.map(raw => ({
        ...revive(raw), id: milestoneMap.get(String(raw.id)), projectId: mapped(projectMap, raw.projectId),
      })));

      const [verify] = await tx.select({ notebooks: sql<number>`count(distinct ${notebooks.id})`, notes: sql<number>`count(distinct ${notes.id})` })
        .from(notebooks).leftJoin(notes, eq(notes.workspaceId, notebooks.workspaceId)).where(eq(notebooks.workspaceId, targetWorkspaceId));
      if (Number(verify?.notebooks ?? 0) !== stats.notebooks || Number(verify?.notes ?? 0) !== stats.notes) throw new Error("恢复后核心表计数校验失败");
      if (input.drill) throw new DrillRollback({ workspaceId: null, stats, warnings, rotatedSecrets: ["share_tokens", "calendar_feed_tokens"] });
    });
  } catch (error) {
    if (error instanceof DrillRollback) {
      await releaseStaged(staged);
      return error.result;
    }
    await releaseStaged(staged);
    throw error;
  }

  // 文件和双链是数据库的派生物：主事务完成后重建，失败会进入 warnings，数据本身仍可从正文重建。
  const candidates = await noteCandidates(targetWorkspaceId);
  for (const note of restoredNotes) {
    try {
      await writeNoteFile({ ...note, noteId: note.id });
      await rebuildLinks(note.id, targetWorkspaceId, note.bodyMd, candidates);
    } catch (error) {
      warnings.push(`笔记 ${note.id} 的派生文件或双链待重建：${error instanceof Error ? error.message : "未知错误"}`);
    }
  }
  if (input.mode === "replace_workspace") {
    for (const file of oldFiles) await releaseStoredFile(file).catch(() => {});
    for (const file of oldPostFiles) await releaseStoredFile({ ...file, postAssetId: file.id }).catch(() => {});
    const memberIds = (await db.select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, targetWorkspaceId))).map(m => m.userId);
    if (memberIds.length) await db.delete(sessions).where(inArray(sessions.userId, memberIds));
    await db.update(mcpTokens).set({ status: "revoked" }).where(eq(mcpTokens.workspaceId, targetWorkspaceId));
  }
  return { workspaceId: targetWorkspaceId, stats, warnings, rotatedSecrets: ["share_tokens", "calendar_feed_tokens", ...(input.mode === "replace_workspace" ? ["sessions", "mcp_tokens"] : [])] };
}

/** 实例包只恢复元数据；密码、会话、API Key、推送私钥不会从包中复活。 */
export async function restoreInstanceMetadata(input: {
  snapshot: InstanceBackupPackage;
  actorId: string;
  mode: Extract<RestoreMode, "bootstrap_empty_instance" | "replace_instance_metadata">;
  drill?: boolean;
}): Promise<RestoreResult> {
  const currentUsers = await db.select().from(users);
  if (input.mode === "bootstrap_empty_instance" && currentUsers.some(user => user.id !== input.actorId)) throw new Error("bootstrap_empty_instance 只允许空实例执行");
  const stats = { users: input.snapshot.users.length, themes: input.snapshot.themes.length, navGroups: input.snapshot.navGroups.length, agents: input.snapshot.agents.length, posts: input.snapshot.posts.length, postAssets: input.snapshot.postAssetFiles.length };
  const warnings = ["实例快照仅恢复实例元数据；工作区正文与 kbdata 必须走整机灾备流程"];
  if (input.snapshot.postAssets.length !== input.snapshot.postAssetFiles.length) warnings.push(`已跳过 ${input.snapshot.postAssets.length - input.snapshot.postAssetFiles.length} 个缺少二进制的旧广场附件`);
  const stagedFiles = await stageInstancePostFiles(input.snapshot);
  let oldPostFiles: Array<typeof postAssets.$inferSelect> = [];
  try {
    await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(91724061)`);
      if (input.snapshot.settings) {
        const settings = revive(input.snapshot.settings);
        delete settings.smtpPassword;
        delete settings.moderationApiKey;
        delete settings.vapidPrivateKey;
        delete settings.oidcClientSecret;
        await tx.insert(instanceSettings).values({ ...settings, id: 1 }).onConflictDoUpdate({ target: instanceSettings.id, set: { ...settings, id: 1, updatedAt: new Date() } });
      }
      // 用户只更新非认证资料；缺失用户用不可登录密码创建，管理员再走重置流程。
      const byEmail = new Map(currentUsers.map(user => [user.email.toLowerCase(), user]));
      const userMap = new Map<string, string>();
      for (const raw of input.snapshot.users) {
        const email = String(raw.email ?? "").toLowerCase();
        if (!email) continue;
        const old = byEmail.get(email);
        const profile = revive(raw);
        const safe = {
          displayName: String(profile.displayName ?? profile.handle ?? email), bio: typeof profile.bio === "string" ? profile.bio : null,
          status: String(profile.status ?? "active"), appearance: String(profile.appearance ?? "system"),
          themeId: String(profile.themeId ?? "mono-modern"), accent: typeof profile.accent === "string" ? profile.accent : null,
        };
        if (old) {
          await tx.update(users).set(safe).where(eq(users.id, old.id));
          userMap.set(String(raw.id), old.id);
        } else {
          const [created] = await tx.insert(users).values({ id: crypto.randomUUID(), email, handle: `${String(profile.handle ?? "restored").slice(0, 24)}-${secureToken(4)}`, displayName: safe.displayName, passwordHash: "!restore-requires-password-reset", status: safe.status, appearance: safe.appearance, themeId: safe.themeId, accent: safe.accent, bio: safe.bio }).returning({ id: users.id });
          userMap.set(String(raw.id), created.id);
        }
      }
      const mapInstanceUser = (value: unknown) => mapped(userMap, value) ?? input.actorId;
      await tx.delete(navLinks);
      await tx.delete(navGroups);
      const groupMap = idMap(input.snapshot.navGroups);
      await insertRows(tx, navGroups, input.snapshot.navGroups.map(raw => ({ ...revive(raw), id: groupMap.get(String(raw.id)) })));
      await insertRows(tx, navLinks, input.snapshot.navLinks.map(raw => ({ ...revive(raw), id: crypto.randomUUID(), groupId: mapped(groupMap, raw.groupId), createdBy: input.actorId })));
      for (const raw of input.snapshot.themes) await tx.insert(themes).values(revive(raw) as typeof themes.$inferInsert).onConflictDoUpdate({ target: themes.id, set: revive(raw) as typeof themes.$inferInsert });
      // 智能体 Key 被有意省略；恢复后保持禁用，必须重新配置 Key 才能启用。
      const agentMap = new Map<string, string>();
      for (const raw of input.snapshot.agents) {
        const old = await tx.select({ id: agents.id }).from(agents).where(eq(agents.handle, String(raw.handle))).limit(1);
        const value: Row = { ...revive(raw), apiKey: seal("restore-requires-reconfiguration"), enabled: false, createdBy: input.actorId };
        delete value.id;
        if (old[0]) {
          await tx.update(agents).set(value).where(eq(agents.id, old[0].id));
          agentMap.set(String(raw.id), old[0].id);
        } else {
          const id = crypto.randomUUID();
          await tx.insert(agents).values({ ...value, id } as typeof agents.$inferInsert);
          agentMap.set(String(raw.id), id);
        }
      }

      const currentWorkspaceIds = new Set((await tx.select({ id: workspaces.id }).from(workspaces)).map(ws => ws.id));
      await tx.delete(registrationCodeUsages);
      await tx.delete(registrationCodes);
      const codeMap = idMap(input.snapshot.registrationCodes);
      await insertRows(tx, registrationCodes, input.snapshot.registrationCodes.map(raw => ({
        ...revive(raw), id: codeMap.get(String(raw.id)), bindWorkspaceId: typeof raw.bindWorkspaceId === "string" && currentWorkspaceIds.has(raw.bindWorkspaceId) ? raw.bindWorkspaceId : null,
        createdBy: raw.createdBy ? mapInstanceUser(raw.createdBy) : null,
      })));
      await insertRows(tx, registrationCodeUsages, input.snapshot.registrationCodeUsages.map(raw => ({ ...revive(raw), id: crypto.randomUUID(), codeId: mapped(codeMap, raw.codeId), userId: mapInstanceUser(raw.userId) })));
      await tx.delete(serviceRequests);
      await insertRows(tx, serviceRequests, input.snapshot.serviceRequests.map(raw => ({ ...revive(raw), id: crypto.randomUUID(), userId: mapInstanceUser(raw.userId), decidedBy: raw.decidedBy ? mapInstanceUser(raw.decidedBy) : null })));
      await tx.delete(savedShares);
      await insertRows(tx, savedShares, input.snapshot.savedShares.map(raw => ({ ...revive(raw), id: crypto.randomUUID(), userId: mapInstanceUser(raw.userId), status: "dismissed", dismissedAt: new Date() })));

      const currentPosts = await tx.select({ id: posts.id }).from(posts).where(eq(posts.visibility, "public"));
      const currentPostIds = currentPosts.map(post => post.id);
      if (currentPostIds.length) {
        const currentComments = await tx.select({ id: comments.id }).from(comments).where(inArray(comments.targetId, currentPostIds));
        oldPostFiles = await tx.select().from(postAssets).where(inArray(postAssets.postId, currentPostIds));
        if (currentComments.length) await tx.delete(agentReplies).where(inArray(agentReplies.commentId, currentComments.map(comment => comment.id)));
        await tx.delete(postReactions).where(inArray(postReactions.postId, currentPostIds));
        await tx.delete(postFavorites).where(inArray(postFavorites.postId, currentPostIds));
        await tx.delete(postAssets).where(inArray(postAssets.postId, currentPostIds));
        await tx.delete(comments).where(inArray(comments.targetId, currentPostIds));
        await tx.delete(moderationReviews).where(inArray(moderationReviews.targetId, currentPostIds));
        await tx.delete(contentReports).where(inArray(contentReports.targetId, currentPostIds));
        await tx.delete(posts).where(inArray(posts.id, currentPostIds));
      }
      const currentNoteIds = new Set((await tx.select({ id: notes.id }).from(notes)).map(note => note.id));
      const postMap = idMap(input.snapshot.posts);
      await insertRows(tx, posts, input.snapshot.posts.map(raw => ({ ...revive(raw), id: postMap.get(String(raw.id)), authorUserId: mapInstanceUser(raw.authorUserId), workspaceId: null, noteId: typeof raw.noteId === "string" && currentNoteIds.has(raw.noteId) ? raw.noteId : null, visibility: "public" })));
      await insertRows(tx, postAssets, input.snapshot.postAssets.flatMap(raw => {
        const ref = stagedFiles.staged.get(String(raw.id));
        return ref ? [{ ...revive(raw), id: crypto.randomUUID(), postId: mapped(postMap, raw.postId), storedName: ref.path, sha256: ref.sha256, bytes: ref.bytes, createdBy: mapInstanceUser(raw.createdBy) }] : [];
      }));
      await insertRows(tx, postReactions, input.snapshot.reactions.map(raw => ({ ...revive(raw), postId: mapped(postMap, raw.postId), userId: mapInstanceUser(raw.userId) })));
      const commentMap = idMap(input.snapshot.comments);
      await insertRows(tx, comments, input.snapshot.comments.map(raw => ({ ...revive(raw), id: commentMap.get(String(raw.id)), targetId: mapped(postMap, raw.targetId), parentId: mapped(commentMap, raw.parentId), authorUserId: raw.authorUserId ? mapInstanceUser(raw.authorUserId) : null, authorAgentId: mapped(agentMap, raw.authorAgentId), shareId: null, siteNotebookId: null })));
      await insertRows(tx, moderationReviews, input.snapshot.moderationReviews.map(raw => ({ ...revive(raw), id: crypto.randomUUID(), targetId: mapped(postMap, raw.targetId), workspaceId: null, authorUserId: mapInstanceUser(raw.authorUserId), reviewerId: raw.reviewerId ? mapInstanceUser(raw.reviewerId) : null })));
      await insertRows(tx, contentReports, input.snapshot.contentReports.map(raw => ({ ...revive(raw), id: crypto.randomUUID(), targetId: mapped(postMap, raw.targetId), reporterId: mapInstanceUser(raw.reporterId), reviewerId: raw.reviewerId ? mapInstanceUser(raw.reviewerId) : null })));
      if (input.drill) throw new DrillRollback({ workspaceId: null, stats, warnings, rotatedSecrets: ["passwords", "sessions", "api_keys", "push_keys"] });
      await tx.delete(authTokens);
      await tx.delete(sessions);
      await tx.update(mcpTokens).set({ status: "revoked" });
    });
  } catch (error) {
    if (error instanceof DrillRollback) {
      for (const sha of stagedFiles.refs) await releaseBlob(sha).catch(() => {});
      return error.result;
    }
    for (const sha of stagedFiles.refs) await releaseBlob(sha).catch(() => {});
    throw error;
  }
  for (const file of oldPostFiles) await releaseStoredFile({ ...file, postAssetId: file.id }).catch(() => {});
  return { workspaceId: null, stats, warnings, rotatedSecrets: ["passwords", "sessions", "mcp_tokens", "api_keys", "push_keys"] };
}

export async function restoreBackupPackage(input: {
  snapshot: BackupPackage;
  actorId: string;
  mode: RestoreMode;
  targetWorkspaceId?: string;
  drill?: boolean;
}) {
  if (input.snapshot.format === "knowledge-workspace-backup") {
    if (input.mode !== "new_workspace" && input.mode !== "replace_workspace") throw new Error("工作区备份与恢复模式不匹配");
    return restoreWorkspacePackage({ ...input, snapshot: input.snapshot, mode: input.mode });
  }
  if (input.mode !== "bootstrap_empty_instance" && input.mode !== "replace_instance_metadata") throw new Error("实例备份与恢复模式不匹配");
  return restoreInstanceMetadata({ ...input, snapshot: input.snapshot, mode: input.mode });
}

/** 恢复后的抽样健康检查；供正式恢复和灾备演练共用。 */
export async function verifyRestoredWorkspace(workspaceId: string, expected: WorkspaceBackupPackage) {
  const [counts] = await db.select({
    notebooks: sql<number>`count(distinct ${notebooks.id})`,
    notes: sql<number>`count(distinct ${notes.id})`,
  }).from(notebooks).leftJoin(notes, eq(notes.workspaceId, notebooks.workspaceId)).where(eq(notebooks.workspaceId, workspaceId));
  if (Number(counts?.notebooks ?? 0) !== expected.notebooks.length || Number(counts?.notes ?? 0) !== expected.notes.length) throw new Error("恢复后计数不一致");
  const samples = await db.select().from(notes).where(eq(notes.workspaceId, workspaceId)).limit(3);
  if (samples.some(note => typeof note.bodyMd !== "string")) throw new Error("恢复后正文抽样失败");
  const files = await db.select().from(attachments).where(eq(attachments.workspaceId, workspaceId)).limit(5);
  for (const file of files) {
    const raw = await readStoredFile(file);
    if (checksum(raw) !== file.sha256) throw new Error("恢复后附件 checksum 校验失败");
  }
  const [member] = await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "owner"))).limit(1);
  if (!member) throw new Error("恢复后缺少 Owner");
  return { notebooks: expected.notebooks.length, notes: expected.notes.length, sampledNotes: samples.length, sampledAttachments: files.length };
}
