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
  };
}

/**
 * 实例包：用户、注册策略、广场、导航、智能体元数据。
 * MCP secret / 工作区 AI key 明文永不进包；分享 token 只在加密包里留。
 */
export async function instanceSnapshot() {
  const [settings] = await db.select().from(instanceSettings);
  const square = await db.select().from(posts).where(eq(posts.visibility, "public"));
  const squareIds = square.map(p => p.id);
  const squareAssets = await byIds(squareIds, ids => db.select().from(postAssets).where(inArray(postAssets.postId, ids)));
  const postAssetFiles: Array<{ postAssetId: string; bytes: number; sha256: string; dataBase64: string }> = [];
  for (const asset of squareAssets) {
    const raw = await readStoredFile({ ...asset, postAssetId: asset.id });
    if (checksum(raw) !== asset.sha256 || raw.length !== asset.bytes) throw new Error(`广场附件 ${asset.id} 的磁盘文件与元数据不一致`);
    postAssetFiles.push({ postAssetId: asset.id, bytes: raw.length, sha256: asset.sha256, dataBase64: raw.toString("base64") });
  }
  const agentRows = await db.select().from(agents);
  return {
    format: "knowledge-instance-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    manifest: { applicationVersion: process.env.APP_VERSION ?? process.env.npm_package_version ?? "unknown", databaseSchemaVersion: 4, dataFileVersion: 1, schemaVersion: 4, capabilities: ["instance_metadata", "strict_refs", "secrets_omitted"] },
    settings: settings ? {
      ...settings,
      smtpPassword: null,
      moderationApiKey: null,
      vapidPrivateKey: null,
    } : null,
    users: (await db.select().from(users)).map(user => ({ ...user, passwordHash: "!restore-requires-password-reset" })),
    serviceRequests: await db.select().from(serviceRequests),
    registrationCodes: (await db.select().from(registrationCodes)).map(row => ({ ...row, codePrefix: row.codePrefix.slice(0, 9) })),
    registrationCodeUsages: await db.select().from(registrationCodeUsages),
    savedShares: await db.select().from(savedShares),
    posts: square,
    postAssets: squareAssets,
    postAssetFiles,
    reactions: await byIds(squareIds, ids => db.select().from(postReactions).where(inArray(postReactions.postId, ids))),
    comments: await byIds(squareIds, ids => db.select().from(comments).where(inArray(comments.targetId, ids))),
    moderationReviews: await byIds(squareIds, ids => db.select().from(moderationReviews).where(inArray(moderationReviews.targetId, ids))),
    contentReports: await byIds(squareIds, ids => db.select().from(contentReports).where(inArray(contentReports.targetId, ids))),
    themes: await db.select().from(themes),
    navGroups: await db.select().from(navGroups),
    navLinks: await db.select().from(navLinks),
    agents: agentRows.map(({ apiKey: _k, ...rest }) => ({ ...rest, enabled: false })),
    workspaces: await db.select({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
      kind: workspaces.kind,
      ownerId: workspaces.ownerId,
    }).from(workspaces),
  };
}

/** 距上次成功多久该再跑；失败后 30 分钟内不连打，避免坏目标把队列灌满。 */
const FAIL_BACKOFF_MS = 30 * 60_000;

export function scheduleIntervalMs(schedule: string) {
  if (schedule === "daily") return 86_400_000;
  if (schedule === "weekly") return 7 * 86_400_000;
  return null;
}

export function backupDue(input: {
  schedule: string;
  lastRunAt: Date | null;
  latest?: { status: string; finishedAt: Date | null } | null;
}, now = new Date()) {
  const interval = scheduleIntervalMs(input.schedule);
  if (interval == null) return false;
  const latest = input.latest;
  if (latest && (latest.status === "pending" || latest.status === "running")) return false;
  if (latest?.status === "failed" && latest.finishedAt && now.getTime() - latest.finishedAt.getTime() < FAIL_BACKOFF_MS) return false;
  if (!input.lastRunAt) return true;
  return now.getTime() - input.lastRunAt.getTime() >= interval;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function redactUnencrypted(snapshot: Record<string, unknown>, encrypted: boolean) {
  if (encrypted) return snapshot;
  const next = { ...snapshot };
  if (Array.isArray(next.shares)) {
    next.shares = next.shares.map((s: { token?: string }) => ({ ...s, token: undefined }));
  }
  if (Array.isArray(next.calendarFeedTokens)) {
    next.calendarFeedTokens = next.calendarFeedTokens.map((s: { token?: string }) => ({ ...s, token: undefined }));
  }
  if (Array.isArray(next.calendarSubscriptions)) {
    next.calendarSubscriptions = next.calendarSubscriptions.map((s: { url?: string }) => ({ ...s, url: undefined, enabled: false }));
  }
  return next;
}

async function notifyFailure(t: TargetRow, message: string) {
  const href = t.workspaceId ? `/w/${t.workspaceId}/settings?tab=backup` : "/admin?tab=backup";
  const title = t.workspaceId ? "工作区备份失败" : "实例备份失败";
  const ids = new Set<string>();
  if (t.workspaceId) {
    const members = await db.select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, t.workspaceId));
    for (const m of members) if (m.role === "owner" || m.role === "admin") ids.add(m.userId);
  } else {
    const admins = await db.select({ id: users.id }).from(users).where(and(eq(users.roleInstance, "admin"), eq(users.status, "active")));
    for (const u of admins) ids.add(u.id);
  }
  if (!ids.size) return;
  await db.insert(notifications).values([...ids].map(userId => ({
    userId,
    type: "backup_failed",
    title,
    body: `${t.name}：${message}`.slice(0, 400),
    href,
  })));
}

export async function executeBackupRun(target: TargetRow, runId: string) {
  await db.update(backupRuns).set({ status: "running", startedAt: new Date() }).where(eq(backupRuns.id, runId));
  const instance = target.scope === "instance" || !target.workspaceId;
  try {
    const snapshot = instance ? await instanceSnapshot() : await workspaceSnapshot(target.workspaceId!);
    const encrypted = !!target.encryptionKey;
    const packed = redactUnencrypted(snapshot as unknown as Record<string, unknown>, encrypted);
    const raw = Buffer.from(JSON.stringify(packed));
    const data = encrypted ? encryptPackage(raw, open(target.encryptionKey!)) : raw;
    const sum = checksum(data);
    const path = instance
      ? `instance-${stamp()}.kbbackup`
      : `workspace-${target.workspaceId}-${stamp()}.kbbackup`;
    const cred = JSON.parse(open(target.credentials)) as BackupCred;
    const ref: BackupTargetRef = { type: target.type, endpoint: target.endpoint, prefix: target.prefix };
    const manifest = instance
      ? {
        format: packed.format,
        version: packed.version,
        users: Array.isArray(packed.users) ? packed.users.length : 0,
        posts: Array.isArray(packed.posts) ? packed.posts.length : 0,
        encrypted,
        bytes: data.length,
        checksumSha256: sum,
        remotePath: path,
        exportedAt: packed.exportedAt,
      }
      : {
        format: packed.format,
        version: packed.version,
        notebooks: Array.isArray(packed.notebooks) ? packed.notebooks.length : 0,
        notes: Array.isArray(packed.notes) ? packed.notes.length : 0,
        attachments: Array.isArray(packed.attachments) ? packed.attachments.length : 0,
        encrypted,
        bytes: data.length,
        checksumSha256: sum,
        remotePath: path,
        exportedAt: packed.exportedAt,
      };
    await upload(ref, cred, path, data);
    await upload(ref, cred, `${path}.manifest.json`, Buffer.from(JSON.stringify(manifest)));
    try { await applyRetention(ref, cred, target.retainDaily, target.retainWeekly); }
    catch (e) { console.warn("备份保留策略未执行完:", e instanceof Error ? e.message : e); }
    await db.update(backupRuns).set({
      status: "success",
      bytes: data.length,
      checksumSha256: sum,
      remotePath: path,
      manifest,
      finishedAt: new Date(),
    }).where(eq(backupRuns.id, runId));
    await db.update(backupTargets).set({ lastRunAt: new Date() }).where(eq(backupTargets.id, target.id));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.update(backupRuns).set({ status: "failed", error: message, finishedAt: new Date() }).where(eq(backupRuns.id, runId));
    await notifyFailure(target, message).catch(() => {});
    throw e;
  }
}
