import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { z } from "zod";

export const BACKUP_MAGIC = "KBENC1";
export const WORKSPACE_BACKUP_VERSION = 4;
export const INSTANCE_BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 512 * 1024 * 1024;

type JsonRow = Record<string, unknown>;

const uuid = z.string().uuid();
const row = z.record(z.string(), z.unknown());
const rows = z.array(row);
const base = z.object({
  format: z.enum(["knowledge-workspace-backup", "knowledge-instance-backup"]),
  version: z.number().int().positive(),
  exportedAt: z.string().datetime(),
}).passthrough();

const workspacePackage = base.extend({
  format: z.literal("knowledge-workspace-backup"),
  version: z.union([z.literal(3), z.literal(WORKSPACE_BACKUP_VERSION)]),
  workspace: row,
  members: rows,
  notebooks: rows,
  notebookMembers: rows,
  folders: rows,
  notes: rows,
  attachments: rows,
  versions: rows,
  shares: rows,
  comments: rows,
  corrections: rows,
  posts: rows,
  postAssets: rows.default([]),
  reactions: rows,
  calendarItems: rows,
  calendarOverrides: rows,
  calendarReminders: rows,
  calendarSubscriptions: rows,
  calendarTemplates: rows,
  calendarFeedTokens: rows,
  attachmentFiles: z.array(z.object({
    attachmentId: uuid,
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    dataBase64: z.string(),
  })).default([]),
  postAssetFiles: z.array(z.object({
    postAssetId: uuid,
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    dataBase64: z.string(),
  })).default([]),
}).passthrough();

const instancePackage = base.extend({
  format: z.literal("knowledge-instance-backup"),
  version: z.literal(INSTANCE_BACKUP_VERSION),
  settings: row.nullable(),
  users: rows,
  serviceRequests: rows,
  registrationCodes: rows,
  registrationCodeUsages: rows,
  savedShares: rows,
  posts: rows,
  postAssets: rows,
  postAssetFiles: z.array(z.object({
    postAssetId: uuid,
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    dataBase64: z.string(),
  })).default([]),
  reactions: rows,
  comments: rows,
  moderationReviews: rows,
  contentReports: rows,
  themes: rows,
  navGroups: rows,
  navLinks: rows,
  agents: rows,
  workspaces: rows,
}).passthrough();

export type WorkspaceBackupPackage = z.infer<typeof workspacePackage>;
export type InstanceBackupPackage = z.infer<typeof instancePackage>;
export type BackupPackage = WorkspaceBackupPackage | InstanceBackupPackage;

export type BackupInspection = {
  snapshot: BackupPackage;
  checksumSha256: string;
  checksumVerified: boolean;
  encrypted: boolean;
  counts: Record<string, number>;
  warnings: string[];
  conflicts: string[];
  compatible: boolean;
};

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
  return Buffer.concat([Buffer.from(BACKUP_MAGIC), salt, iv, c.getAuthTag(), body]);
}

export function decryptPackage(raw: Buffer, pass: string) {
  if (!isEncryptedPackage(raw)) return raw;
  if (!pass) throw new Error("备份已加密，请提供解密口令");
  if (raw.length < 51) throw new Error("加密备份结构损坏");
  try {
    const salt = raw.subarray(6, 22);
    const iv = raw.subarray(22, 34);
    const tag = raw.subarray(34, 50);
    const d = createDecipheriv("aes-256-gcm", scryptSync(pass, salt, 32), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(raw.subarray(50)), d.final()]);
  } catch {
    throw new Error("解密失败：口令错误或备份已损坏");
  }
}

export function isEncryptedPackage(raw: Buffer) {
  return raw.subarray(0, 6).toString() === BACKUP_MAGIC;
}

function idOf(value: unknown, label: string) {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new Error(`${label} 不是合法 UUID`);
  return parsed.data;
}

function idsOf(items: JsonRow[], label: string) {
  const out = new Set<string>();
  for (const item of items) {
    const id = idOf(item.id, `${label}.id`);
    if (out.has(id)) throw new Error(`${label} 存在重复 id`);
    out.add(id);
  }
  return out;
}

function assertRef(value: unknown, ids: Set<string>, label: string, nullable = false) {
  if (nullable && (value === null || value === undefined)) return;
  const id = idOf(value, label);
  if (!ids.has(id)) throw new Error(`${label} 引用了包内不存在的资源`);
}

/** 严格检查包内主键和关系，避免恢复到一半才撞外键。 */
export function validateWorkspaceGraph(snapshot: WorkspaceBackupPackage) {
  const wsId = idOf(snapshot.workspace.id, "workspace.id");
  const nbIds = idsOf(snapshot.notebooks, "notebooks");
  const folderIds = idsOf(snapshot.folders, "folders");
  const noteIds = idsOf(snapshot.notes, "notes");
  const attachmentIds = idsOf(snapshot.attachments, "attachments");
  const postIds = idsOf(snapshot.posts, "posts");
  const postAssetIds = idsOf(snapshot.postAssets, "postAssets");
  const itemIds = idsOf(snapshot.calendarItems, "calendarItems");
  const shareIds = idsOf(snapshot.shares, "shares");
  const commentIds = idsOf(snapshot.comments, "comments");

  for (const n of snapshot.notebooks) if (n.workspaceId !== wsId) throw new Error("notebooks.workspaceId 与工作区不一致");
  for (const f of snapshot.folders) {
    if (f.workspaceId !== wsId) throw new Error("folders.workspaceId 与工作区不一致");
    assertRef(f.notebookId, nbIds, "folders.notebookId");
    assertRef(f.parentId, folderIds, "folders.parentId", true);
  }
  const folderParents = new Map(snapshot.folders.map(folder => [String(folder.id), folder.parentId == null ? null : String(folder.parentId)]));
  for (const id of folderParents.keys()) {
    const seen = new Set<string>();
    let current: string | null = id;
    while (current) {
      if (seen.has(current)) throw new Error("folders.parentId 存在循环引用");
      seen.add(current);
      current = folderParents.get(current) ?? null;
    }
  }
  for (const n of snapshot.notes) {
    if (n.workspaceId !== wsId) throw new Error("notes.workspaceId 与工作区不一致");
    assertRef(n.notebookId, nbIds, "notes.notebookId");
    assertRef(n.folderId, folderIds, "notes.folderId", true);
  }
  for (const a of snapshot.attachments) {
    if (a.workspaceId !== wsId) throw new Error("attachments.workspaceId 与工作区不一致");
    assertRef(a.noteId, noteIds, "attachments.noteId");
  }
  for (const v of snapshot.versions) assertRef(v.noteId, noteIds, "versions.noteId");
  for (const m of snapshot.notebookMembers) assertRef(m.notebookId, nbIds, "notebookMembers.notebookId");
  for (const share of snapshot.shares) {
    const target = share.targetType === "notebook" ? nbIds : share.targetType === "folder" ? folderIds : noteIds;
    assertRef(share.targetId, target, "shares.targetId");
  }
  for (const comment of snapshot.comments) {
    assertRef(comment.targetId, comment.targetType === "post" ? postIds : noteIds, "comments.targetId");
    assertRef(comment.parentId, commentIds, "comments.parentId", true);
    assertRef(comment.shareId, shareIds, "comments.shareId", true);
    assertRef(comment.siteNotebookId, nbIds, "comments.siteNotebookId", true);
  }
  for (const c of snapshot.corrections) {
    assertRef(c.noteId, noteIds, "corrections.noteId");
    assertRef(c.shareId, shareIds, "corrections.shareId", true);
    assertRef(c.siteNotebookId, nbIds, "corrections.siteNotebookId", true);
  }
  for (const p of snapshot.posts) {
    if (p.workspaceId !== wsId) throw new Error("posts.workspaceId 与工作区不一致");
    assertRef(p.noteId, noteIds, "posts.noteId", true);
  }
  for (const r of snapshot.reactions) assertRef(r.postId, postIds, "reactions.postId");
  for (const asset of snapshot.postAssets) assertRef(asset.postId, postIds, "postAssets.postId", true);
  for (const item of snapshot.calendarItems) {
    if (item.workspaceId !== wsId) throw new Error("calendarItems.workspaceId 与工作区不一致");
    assertRef(item.notebookId, nbIds, "calendarItems.notebookId", true);
    assertRef(item.sourceNoteId, noteIds, "calendarItems.sourceNoteId", true);
  }
  for (const item of snapshot.calendarOverrides) assertRef(item.itemId, itemIds, "calendarOverrides.itemId");
  for (const item of snapshot.calendarReminders) assertRef(item.itemId, itemIds, "calendarReminders.itemId");
  for (const item of snapshot.calendarSubscriptions) if (item.workspaceId !== wsId) throw new Error("calendarSubscriptions.workspaceId 与工作区不一致");
  for (const item of snapshot.calendarTemplates) if (item.workspaceId !== wsId) throw new Error("calendarTemplates.workspaceId 与工作区不一致");
  for (const item of snapshot.calendarFeedTokens) if (item.workspaceId !== wsId) throw new Error("calendarFeedTokens.workspaceId 与工作区不一致");

  const files = new Map(snapshot.attachmentFiles.map(file => [file.attachmentId, file]));
  for (const a of snapshot.attachments) {
    const id = String(a.id);
    const file = files.get(id);
    if (snapshot.version >= WORKSPACE_BACKUP_VERSION && !file) throw new Error(`附件 ${id} 缺少二进制文件`);
    if (!file) continue;
    const raw = Buffer.from(file.dataBase64, "base64");
    if (raw.length !== file.bytes || raw.length !== Number(a.bytes) || checksum(raw) !== file.sha256 || file.sha256 !== a.sha256) {
      throw new Error(`附件 ${id} 的大小或校验和不一致`);
    }
  }
  for (const id of files.keys()) if (!attachmentIds.has(id)) throw new Error("attachmentFiles 含孤立文件");
  const assetFiles = new Map(snapshot.postAssetFiles.map(file => [file.postAssetId, file]));
  for (const asset of snapshot.postAssets) {
    const id = String(asset.id);
    const file = assetFiles.get(id);
    if (snapshot.version >= WORKSPACE_BACKUP_VERSION && !file) throw new Error(`动态附件 ${id} 缺少二进制文件`);
    if (!file) continue;
    const raw = Buffer.from(file.dataBase64, "base64");
    if (raw.length !== file.bytes || raw.length !== Number(asset.bytes) || checksum(raw) !== file.sha256 || file.sha256 !== asset.sha256) {
      throw new Error(`动态附件 ${id} 的大小或校验和不一致`);
    }
  }
  for (const id of assetFiles.keys()) if (!postAssetIds.has(id)) throw new Error("postAssetFiles 含孤立文件");
}

/** 实例包同样在写入前验证所有会被恢复的主键和包内引用。 */
export function validateInstanceGraph(snapshot: InstanceBackupPackage) {
  const userIds = idsOf(snapshot.users, "users");
  const codeIds = idsOf(snapshot.registrationCodes, "registrationCodes");
  const postIds = idsOf(snapshot.posts, "posts");
  const postAssetIds = idsOf(snapshot.postAssets, "postAssets");
  const commentIds = idsOf(snapshot.comments, "comments");
  const groupIds = idsOf(snapshot.navGroups, "navGroups");
  const agentIds = idsOf(snapshot.agents, "agents");
  idsOf(snapshot.serviceRequests, "serviceRequests");
  idsOf(snapshot.registrationCodeUsages, "registrationCodeUsages");
  idsOf(snapshot.savedShares, "savedShares");
  idsOf(snapshot.navLinks, "navLinks");
  idsOf(snapshot.moderationReviews, "moderationReviews");
  idsOf(snapshot.contentReports, "contentReports");
  idsOf(snapshot.workspaces, "workspaces");

  for (const code of snapshot.registrationCodes) assertRef(code.createdBy, userIds, "registrationCodes.createdBy", true);
  for (const usage of snapshot.registrationCodeUsages) {
    assertRef(usage.codeId, codeIds, "registrationCodeUsages.codeId");
    assertRef(usage.userId, userIds, "registrationCodeUsages.userId");
  }
  for (const request of snapshot.serviceRequests) {
    assertRef(request.userId, userIds, "serviceRequests.userId");
    assertRef(request.decidedBy, userIds, "serviceRequests.decidedBy", true);
  }
  for (const saved of snapshot.savedShares) assertRef(saved.userId, userIds, "savedShares.userId");
  for (const link of snapshot.navLinks) {
    assertRef(link.groupId, groupIds, "navLinks.groupId");
    assertRef(link.createdBy, userIds, "navLinks.createdBy", true);
  }
  for (const agent of snapshot.agents) assertRef(agent.createdBy, userIds, "agents.createdBy", true);
  for (const workspace of snapshot.workspaces) assertRef(workspace.ownerId, userIds, "workspaces.ownerId");
  for (const post of snapshot.posts) assertRef(post.authorUserId, userIds, "posts.authorUserId");
  for (const asset of snapshot.postAssets) {
    assertRef(asset.postId, postIds, "postAssets.postId", true);
    assertRef(asset.createdBy, userIds, "postAssets.createdBy");
  }
  for (const reaction of snapshot.reactions) {
    assertRef(reaction.postId, postIds, "reactions.postId");
    assertRef(reaction.userId, userIds, "reactions.userId");
  }
  for (const comment of snapshot.comments) {
    assertRef(comment.targetId, postIds, "comments.targetId");
    assertRef(comment.parentId, commentIds, "comments.parentId", true);
    assertRef(comment.authorUserId, userIds, "comments.authorUserId", true);
    assertRef(comment.authorAgentId, agentIds, "comments.authorAgentId", true);
  }
  for (const review of snapshot.moderationReviews) {
    assertRef(review.targetId, postIds, "moderationReviews.targetId");
    assertRef(review.authorUserId, userIds, "moderationReviews.authorUserId");
    assertRef(review.reviewerId, userIds, "moderationReviews.reviewerId", true);
  }
  for (const report of snapshot.contentReports) {
    assertRef(report.targetId, postIds, "contentReports.targetId");
    assertRef(report.reporterId, userIds, "contentReports.reporterId");
    assertRef(report.reviewerId, userIds, "contentReports.reviewerId", true);
  }

  for (const file of snapshot.postAssetFiles) {
    if (!postAssetIds.has(file.postAssetId)) throw new Error("postAssetFiles 含孤立文件");
    const asset = snapshot.postAssets.find(row => row.id === file.postAssetId)!;
    const bytes = Buffer.from(file.dataBase64, "base64");
    if (bytes.length !== file.bytes || bytes.length !== Number(asset.bytes) || checksum(bytes) !== file.sha256 || file.sha256 !== asset.sha256) {
      throw new Error(`广场附件 ${file.postAssetId} 的大小或校验和不一致`);
    }
  }
}

function countArrays(snapshot: BackupPackage) {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(snapshot)) if (Array.isArray(value)) out[key] = value.length;
  return out;
}

export function inspectBackupPackage(raw: Buffer, options: { passphrase?: string; expectedChecksum?: string } = {}): BackupInspection {
  if (!raw.length || raw.length > MAX_BACKUP_BYTES) throw new Error("备份大小超出允许范围");
  const sum = checksum(raw);
  if (options.expectedChecksum && options.expectedChecksum !== sum) throw new Error("备份 checksum 与运行记录不一致");
  const encrypted = isEncryptedPackage(raw);
  const plain = decryptPackage(raw, options.passphrase ?? "");
  let json: unknown;
  try { json = JSON.parse(plain.toString("utf8")); }
  catch { throw new Error("备份正文不是合法 JSON"); }
  const header = base.parse(json);
  const snapshot = header.format === "knowledge-workspace-backup"
    ? workspacePackage.parse(json)
    : instancePackage.parse(json);
  const warnings: string[] = [];
  if (snapshot.format === "knowledge-workspace-backup") {
    validateWorkspaceGraph(snapshot);
    if (snapshot.version === 3) warnings.push("旧版 v3 包不含附件二进制；只能在明确接受附件缺失时恢复");
  } else {
    validateInstanceGraph(snapshot);
    warnings.push("实例快照仅包含实例元数据，不等于 PostgreSQL 与 kbdata 的整机灾备包");
    if (snapshot.postAssets.length && snapshot.postAssetFiles.length !== snapshot.postAssets.length) warnings.push("旧实例包缺少部分广场附件二进制，恢复时会跳过这些附件元数据");
  }
  if (!options.expectedChecksum) warnings.push("本地运行记录不存在，已计算 checksum，但无法与创建时记录交叉核验");
  return {
    snapshot,
    checksumSha256: sum,
    checksumVerified: !!options.expectedChecksum,
    encrypted,
    counts: countArrays(snapshot),
    warnings,
    conflicts: [],
    compatible: true,
  };
}

/** 恢复前先从列表中选对象；仅允许目标根目录下的单个 .kbbackup 文件。 */
export function assertBackupObjectName(name: string) {
  if (!name || name.length > 240 || name.includes("/") || name.includes("\\") || name.includes("..") || !name.endsWith(".kbbackup")) {
    throw new Error("备份对象路径不合法");
  }
  return name;
}

export function estimatedRestoreBytes(snapshot: BackupPackage) {
  if (snapshot.format === "knowledge-instance-backup") return Math.ceil(snapshot.postAssetFiles.reduce((sum, file) => sum + file.bytes, 0) * 2.1);
  const files = [...snapshot.attachmentFiles, ...snapshot.postAssetFiles].reduce((sum, file) => sum + file.bytes, 0);
  const markdown = snapshot.notes.reduce((sum, note) => sum + Buffer.byteLength(String(note.bodyMd ?? ""), "utf8"), 0);
  // staging 与最终内容寻址文件可能短暂并存，再留 10% 元数据余量。
  return Math.ceil((files + markdown) * 2.1);
}
