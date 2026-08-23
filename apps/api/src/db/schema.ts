import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const instanceSettings = pgTable("instance_settings", {
  id: integer("id").primaryKey().default(1),
  allowOpenRegistration: boolean("allow_open_registration").notNull().default(false),
  allowEmailRegistration: boolean("allow_email_registration").notNull().default(true),
  requireEmailVerification: boolean("require_email_verification").notNull().default(false),
  allowCodeRegistration: boolean("allow_code_registration").notNull().default(true),
  allowUserCreateWorkspace: boolean("allow_user_create_workspace").notNull().default(true),
  squareEnabled: boolean("square_enabled").notNull().default(true),
  aiEnabled: boolean("ai_enabled").notNull().default(true),
  firstAdminUserId: uuid("first_admin_user_id"),
  defaultThemeId: text("default_theme_id").notNull().default("mono-modern"),
  defaultAccent: text("default_accent"),
  allowUserInstallThemes: boolean("allow_user_install_themes").notNull().default(true),
  allowUserAccent: boolean("allow_user_accent").notNull().default(true),
  defaultUserStorageBytes: bigint("default_user_storage_bytes", { mode: "number" }).notNull().default(1073741824),
  /** 关则用户不能在线申请扩容；已提交的 pending 管理员仍可批（设计 22）。 */
  allowStorageRequests: boolean("allow_storage_requests").notNull().default(true),
  /** MCP upload_image 单张上限。默认 5MB，管理员可在实例后台改，硬顶 25MB。 */
  mcpImageMaxBytes: bigint("mcp_image_max_bytes", { mode: "number" }).notNull().default(5242880),
  smtpHost: text("smtp_host"), smtpPort: integer("smtp_port"), smtpUser: text("smtp_user"), smtpPassword: text("smtp_password"), smtpFrom: text("smtp_from"), smtpSecure: boolean("smtp_secure").notNull().default(false),
  moderationEnabled: boolean("moderation_enabled").notNull().default(false),
  moderationSquare: boolean("moderation_square").notNull().default(true),
  moderationCircle: boolean("moderation_circle").notNull().default(false),
  moderationArticle: boolean("moderation_article").notNull().default(true),
  moderationBaseUrl: text("moderation_base_url"), moderationModel: text("moderation_model"), moderationApiKey: text("moderation_api_key"),
  moderationRules: text("moderation_rules"),
  moderationCategories: jsonb("moderation_categories").notNull().default(["politics", "porn", "violence", "abuse", "illegal", "privacy", "ad"]),
  moderationThreshold: integer("moderation_threshold").notNull().default(60),
  moderationOnError: text("moderation_on_error").notNull().default("review"),
  /** Web Push：实例级的一对 VAPID 密钥，私钥走 secrets.seal。没配就整个实例不出现推送这个渠道。 */
  pushEnabled: boolean("push_enabled").notNull().default(false),
  vapidPublicKey: text("vapid_public_key"), vapidPrivateKey: text("vapid_private_key"), vapidSubject: text("vapid_subject"),
  /** 实例导航页（设计 19）。默认开、默认对访客公开。 */
  navEnabled: boolean("nav_enabled").notNull().default(true),
  navPublic: boolean("nav_public").notNull().default(true),
  navTitle: text("nav_title"),
  navSubtitle: text("nav_subtitle"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  passwordHash: text("password_hash").notNull(),
  handle: text("handle").notNull().unique(),
  displayName: text("display_name").notNull(),
  bio: text("bio"),
  roleInstance: text("role_instance").notNull().default("user"),
  status: text("status").notNull().default("active"),
  deletionRequestedAt: timestamp("deletion_requested_at", {withTimezone:true}),
  deletionScheduledAt: timestamp("deletion_scheduled_at", {withTimezone:true}),
  appearance: text("appearance").notNull().default("system"),
  themeId: text("theme_id").notNull().default("mono-modern"),
  accent: text("accent"),
  storageQuotaBytes: bigint("storage_quota_bytes", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const registrationCodes = pgTable("registration_codes", {
  id: uuid("id").defaultRandom().primaryKey(),
  codeHash: text("code_hash").notNull().unique(),
  /** 完整注册码，给管理页展示和复制。升级前的旧行可能只有 9 位前缀。 */
  codePrefix: text("code_prefix").notNull(),
  maxUses: integer("max_uses").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  note: text("note"),
  bindWorkspaceId: uuid("bind_workspace_id"),
  bindRole: text("bind_role"),
  skipEmailVerification: boolean("skip_email_verification").notNull().default(false),
  status: text("status").notNull().default("active"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const registrationCodeUsages = pgTable("registration_code_usages", {
  id: uuid("id").defaultRandom().primaryKey(),
  codeId: uuid("code_id").notNull().references(() => registrationCodes.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  usedAt: timestamp("used_at", { withTimezone: true }).defaultNow().notNull(),
});

/** 用户向实例管理员申请服务。一期只有 storage，表按可扩展写（设计 22）。 */
export const serviceRequests = pgTable("service_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  kind: text("kind").notNull().default("storage"),
  requestedBytes: bigint("requested_bytes", { mode: "number" }),
  currentQuotaBytes: bigint("current_quota_bytes", { mode: "number" }),
  usedBytes: bigint("used_bytes", { mode: "number" }),
  reason: text("reason"),
  status: text("status").notNull().default("pending"),
  adminNote: text("admin_note"),
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  grantedQuotaBytes: bigint("granted_quota_bytes", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  index("service_requests_user_idx").on(t.userId, t.createdAt),
  index("service_requests_status_idx").on(t.status, t.createdAt),
]);

export const authTokens = pgTable("auth_tokens", { id: uuid("id").defaultRandom().primaryKey(), userId: uuid("user_id").notNull().references(() => users.id), tokenHash: text("token_hash").notNull().unique(), purpose: text("purpose").notNull(), expiresAt: timestamp("expires_at", {withTimezone:true}).notNull(), usedAt: timestamp("used_at", {withTimezone:true}), createdAt: timestamp("created_at", {withTimezone:true}).defaultNow().notNull() });

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  frozen: boolean("frozen").notNull().default(false),
  feedEnabled: boolean("feed_enabled").notNull().default(true),
  aiEnabled: boolean("ai_enabled").notNull().default(true),
  personalUserId: uuid("personal_user_id").unique(),
  deletionScheduledAt: timestamp("deletion_scheduled_at", {withTimezone:true}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    // memberRole() 几乎在每条请求链路上，`/search` 和 export.zip 更是逐篇调它
    index("workspace_members_user_idx").on(t.userId),
  ],
);

export const workspaceInvites = pgTable("workspace_invites", {
  id: uuid("id").defaultRandom().primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  tokenPrefix: text("token_prefix").notNull(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  role: text("role").notNull().default("viewer"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  maxUses: integer("max_uses"),
  usedCount: integer("used_count").notNull().default(0),
  status: text("status").notNull().default("active"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const notebooks = pgTable("notebooks", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  sortKey: integer("sort_key").notNull().default(0),
  visibility: text("visibility").notNull().default("open"),
  defaultAiIndex: boolean("default_ai_index").notNull().default(true),
  /** 允许把块锚 `^tk-xxxxxxxx` 写进正文任务行；关掉后退化为文本 hash 匹配（设计 16 §5.1）。 */
  taskAnchors: boolean("task_anchors").notNull().default(true),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  sitePublished: boolean("site_published").notNull().default(false),
  sitePublishRequestedBy: uuid("site_publish_requested_by").references(() => users.id),
  sitePublishRequestedAt: timestamp("site_publish_requested_at", { withTimezone: true }),
  siteThemeId: text("site_theme_id"),
  siteAccent: text("site_accent"),
  trashedAt: timestamp("trashed_at", { withTimezone: true }),
  trashedBy: uuid("trashed_by").references(() => users.id),
  trashBatchId: uuid("trash_batch_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const notebookMembers = pgTable("notebook_members", {
  notebookId: uuid("notebook_id").notNull().references(() => notebooks.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  role: text("role").notNull(),
  createdAt: timestamp("created_at", {withTimezone:true}).defaultNow().notNull(),
}, t=>[primaryKey({columns:[t.notebookId,t.userId]})]);

export const folders = pgTable("folders", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  notebookId: uuid("notebook_id").notNull().references(() => notebooks.id),
  parentId: uuid("parent_id"),
  title: text("title").notNull(),
  sortKey: integer("sort_key").notNull().default(0),
  trashedAt: timestamp("trashed_at", { withTimezone: true }),
  trashedBy: uuid("trashed_by").references(() => users.id),
  trashBatchId: uuid("trash_batch_id"),
}, (t) => [
  index("folders_notebook_idx").on(t.notebookId),
  index("folders_workspace_idx").on(t.workspaceId),
  index("folders_batch_idx").on(t.trashBatchId),
]);

export const notes = pgTable("notes", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  notebookId: uuid("notebook_id").notNull().references(() => notebooks.id),
  folderId: uuid("folder_id"),
  title: text("title").notNull(),
  sortKey: integer("sort_key").notNull().default(0),
  bodyMd: text("body_md").notNull().default(""),
  published: boolean("published").notNull().default(false),
  /** none = 对外可公开；pending_review / rejected 时文档站不列这篇。 */
  moderationStatus: text("moderation_status").notNull().default("none"),
  aiIndex: boolean("ai_index").notNull().default(true),
  version: integer("version").notNull().default(1),
  tags: jsonb("tags").notNull().default([]),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  updatedBy: uuid("updated_by").notNull().references(() => users.id),
  trashedAt: timestamp("trashed_at", { withTimezone: true }),
  trashedBy: uuid("trashed_by").references(() => users.id),
  trashBatchId: uuid("trash_batch_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("notes_workspace_idx").on(t.workspaceId),
  index("notes_notebook_idx").on(t.notebookId),
  index("notes_folder_idx").on(t.folderId),
  index("notes_created_by_idx").on(t.createdBy),
  index("notes_batch_idx").on(t.trashBatchId),
]);

export const attachments = pgTable("attachments", {
  id: uuid("id").defaultRandom().primaryKey(), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id), noteId: uuid("note_id").notNull().references(() => notes.id),
  filename: text("filename").notNull(), storedName: text("stored_name").notNull(), mime: text("mime").notNull(), bytes: bigint("bytes", {mode:"number"}).notNull(), sha256: text("sha256").notNull(), extractedText: text("extracted_text"), extractStatus: text("extract_status").notNull().default("none"),
  createdBy: uuid("created_by").notNull().references(() => users.id), createdAt: timestamp("created_at", {withTimezone:true}).defaultNow().notNull(), trashedAt: timestamp("trashed_at", {withTimezone:true}),
}, (t) => [
  index("attachments_note_idx").on(t.noteId),
  index("attachments_workspace_idx").on(t.workspaceId),
  index("attachments_created_by_idx").on(t.createdBy),
  index("attachments_sha256_idx").on(t.sha256),
]);

/** 按内容哈希去重的物理文件。attachments / post_assets 只是引用，refcount 到 0 再删盘。 */
export const blobStore = pgTable("blob_store", {
  sha256: text("sha256").primaryKey(),
  bytes: bigint("bytes", { mode: "number" }).notNull(),
  refcount: integer("refcount").notNull().default(0),
  path: text("path").notNull(),
});

export const links = pgTable("links", {
  id: uuid("id").defaultRandom().primaryKey(),
  fromNoteId: uuid("from_note_id").notNull().references(() => notes.id),
  raw: text("raw").notNull(),
  targetNoteId: uuid("target_note_id"),
  targetHeading: text("target_heading"),
  display: text("display"),
  kind: text("kind").notNull().default("wiki"),
  state: text("state").notNull().default("unresolved"),
  pos: integer("pos").notNull().default(0),
});

export const noteVersions = pgTable("note_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  noteId: uuid("note_id").notNull().references(() => notes.id),
  version: integer("version").notNull(),
  title: text("title").notNull(),
  bodyMd: text("body_md").notNull(),
  editorId: uuid("editor_id").notNull(),
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const shareLinks = pgTable("share_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  token: text("token").notNull().unique(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  targetType: text("target_type").notNull().default("note"),
  targetId: uuid("target_id").notNull(),
  passwordHash: text("password_hash"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  allowRobots: boolean("allow_robots").notNull().default(false),
  commentsEnabled: boolean("comments_enabled").notNull().default(true),
  correctionsEnabled: boolean("corrections_enabled").notNull().default(false),
  showBacklinks: boolean("show_backlinks").notNull().default(false),
  headingAnchor: text("heading_anchor"),
  status: text("status").notNull().default("active"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/** 收到的分享：个人指针，不是副本。设计 21。 */
export const savedShares = pgTable("saved_shares", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  shareId: uuid("share_id"),
  siteNotebookId: uuid("site_notebook_id"),
  lastNoteId: uuid("last_note_id"),
  titleSnapshot: text("title_snapshot").notNull(),
  kindSnapshot: text("kind_snapshot").notNull(),
  authorNameSnapshot: text("author_name_snapshot").notNull().default(""),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }).defaultNow().notNull(),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
}, t => [
  uniqueIndex("saved_shares_user_share_uq").on(t.userId, t.shareId),
  uniqueIndex("saved_shares_user_site_uq").on(t.userId, t.siteNotebookId),
  index("saved_shares_user_status_idx").on(t.userId, t.status, t.lastOpenedAt),
]);

export const posts = pgTable("posts", {
  id: uuid("id").defaultRandom().primaryKey(), authorUserId: uuid("author_user_id").notNull().references(() => users.id), workspaceId: uuid("workspace_id"),
  visibility: text("visibility").notNull().default("public"), body: text("body").notNull(), noteId: uuid("note_id"), status: text("status").notNull().default("visible"),
  tags: jsonb("tags").notNull().default([]),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
/** 一条待审 / 已审的内容。广场帖、圈子帖、公开文章共用这张表，人工审核队列直接查它。 */
export const moderationReviews = pgTable("moderation_reviews", {
  id: uuid("id").defaultRandom().primaryKey(),
  targetType: text("target_type").notNull(), targetId: uuid("target_id").notNull(),
  scope: text("scope").notNull(), workspaceId: uuid("workspace_id"), authorUserId: uuid("author_user_id").notNull().references(() => users.id),
  snapshot: text("snapshot").notNull(),
  /** publish=发布预审；report=用户举报；appeal=作者申诉。 */
  kind: text("kind").notNull().default("publish"),
  aiVerdict: text("ai_verdict").notNull(), aiScore: integer("ai_score"), aiCategories: jsonb("ai_categories").notNull().default([]), aiReason: text("ai_reason"), aiModel: text("ai_model"),
  status: text("status").notNull().default("pending"),
  reviewerId: uuid("reviewer_id").references(() => users.id), reviewNote: text("review_note"), reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const postReactions = pgTable("post_reactions", { postId: uuid("post_id").notNull().references(() => posts.id), userId: uuid("user_id").notNull().references(() => users.id), kind: text("kind").notNull().default("like"), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull() }, t => [primaryKey({columns:[t.postId,t.userId,t.kind]})]);
/** 动态附件。post_id 空 = 发帖前暂存，只有上传者能看。不进笔记 attachments 表。 */
export const postAssets = pgTable("post_assets", {
  id: uuid("id").defaultRandom().primaryKey(),
  postId: uuid("post_id").references(() => posts.id),
  filename: text("filename").notNull(), storedName: text("stored_name").notNull(), mime: text("mime").notNull(),
  bytes: bigint("bytes", { mode: "number" }).notNull(), sha256: text("sha256").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  trashedAt: timestamp("trashed_at", { withTimezone: true }),
}, t => [
  index("post_assets_post_idx").on(t.postId),
  index("post_assets_author_idx").on(t.createdBy),
  index("post_assets_sha256_idx").on(t.sha256),
]);
export const postFavorites = pgTable("post_favorites", {
  userId: uuid("user_id").notNull().references(() => users.id),
  postId: uuid("post_id").notNull().references(() => posts.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [primaryKey({ columns: [t.userId, t.postId] })]);
/** 用户举报。一期只挂动态；进人工队列见设计 18。同一人同一对象只记一条。 */
export const contentReports = pgTable("content_reports", {
  id: uuid("id").defaultRandom().primaryKey(),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  reporterId: uuid("reporter_id").notNull().references(() => users.id),
  reason: text("reason").notNull(),
  note: text("note"),
  status: text("status").notNull().default("pending"),
  reviewerId: uuid("reviewer_id").references(() => users.id),
  reviewNote: text("review_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
});

export const comments = pgTable("comments", {
  id: uuid("id").defaultRandom().primaryKey(), targetType: text("target_type").notNull(), targetId: uuid("target_id").notNull(),
  shareId: uuid("share_id"), siteNotebookId: uuid("site_notebook_id"), parentId: uuid("parent_id"),
  authorUserId: uuid("author_user_id"), authorAgentId: uuid("author_agent_id"), guestName: text("guest_name"), guestEmail: text("guest_email"),
  body: text("body").notNull(), status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), editedAt: timestamp("edited_at", { withTimezone: true }),
});
export const corrections = pgTable("corrections", {
  id: uuid("id").defaultRandom().primaryKey(), noteId: uuid("note_id").notNull().references(() => notes.id),
  shareId: uuid("share_id"), siteNotebookId: uuid("site_notebook_id"), originalExcerpt: text("original_excerpt").notNull(), originalHash: text("original_hash").notNull(),
  suggested: text("suggested").notNull(), comment: text("comment"), authorUserId: uuid("author_user_id"), guestName: text("guest_name"), guestEmail: text("guest_email"),
  status: text("status").notNull().default("pending"), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), reviewedAt: timestamp("reviewed_at", { withTimezone: true }), reviewedBy: uuid("reviewed_by"),
});
export const notifications = pgTable("notifications", {
  id: uuid("id").defaultRandom().primaryKey(), userId: uuid("user_id").notNull().references(() => users.id), type: text("type").notNull(), title: text("title").notNull(), body: text("body"), href: text("href"), readAt: timestamp("read_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const themes = pgTable("themes", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  author: text("author"),
  version: text("version").notNull(),
  builtin: boolean("builtin").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  manifest: jsonb("manifest").notNull(),
  /** 谁装的。themes 是实例级共享表，升级同 id 的主题只能是原安装者或实例管理员。 */
  installedBy: uuid("installed_by").references(() => users.id),
  installedAt: timestamp("installed_at", { withTimezone: true }).defaultNow().notNull(),
});

export const aiProviders = pgTable("ai_providers", {
  id: uuid("id").defaultRandom().primaryKey(), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id), ownerUserId: uuid("owner_user_id"),
  kind: text("kind").notNull().default("openai-compatible"), baseUrl: text("base_url").notNull(), chatModel: text("chat_model").notNull(), embeddingModel: text("embedding_model"),
  apiKey: text("api_key").notNull(), enabled: boolean("enabled").notNull().default(true), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export const aiChunks=pgTable("ai_chunks",{id:uuid("id").defaultRandom().primaryKey(),noteId:uuid("note_id").notNull().references(()=>notes.id),workspaceId:uuid("workspace_id").notNull().references(()=>workspaces.id),notebookId:uuid("notebook_id").notNull().references(()=>notebooks.id),chunkIndex:integer("chunk_index").notNull(),content:text("content").notNull(),embedding:text("embedding"),createdAt:timestamp("created_at",{withTimezone:true}).defaultNow().notNull()});

export const aiUsage = pgTable("ai_usage", { id: uuid("id").defaultRandom().primaryKey(), userId: uuid("user_id").notNull(), workspaceId: uuid("workspace_id").notNull(), action: text("action").notNull(), model: text("model"), inputTokens: integer("input_tokens").notNull().default(0), outputTokens: integer("output_tokens").notNull().default(0), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull() });
export const mcpTokens = pgTable("mcp_tokens", { id: uuid("id").defaultRandom().primaryKey(), secretHash: text("secret_hash").notNull().unique(), name: text("name").notNull(), userId: uuid("user_id").notNull().references(() => users.id), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id), workspaceIds: jsonb("workspace_ids").notNull().default([]), notebookMode: text("notebook_mode").notNull().default("inherit"), notebookIds: jsonb("notebook_ids").notNull().default([]), rw: text("rw").notNull().default("read"), allowDelete: boolean("allow_delete").notNull().default(false), requireAiIndex: boolean("require_ai_index").notNull().default(true), allowPrivateNotebooks: boolean("allow_private_notebooks").notNull().default(false), feedPublic: boolean("feed_public").notNull().default(false), feedWorkspace: boolean("feed_workspace").notNull().default(false), dailyWriteLimitBytes: bigint("daily_write_limit_bytes",{mode:"number"}), expiresAt: timestamp("expires_at", {withTimezone:true}), status: text("status").notNull().default("active"), lastUsedAt: timestamp("last_used_at", {withTimezone:true}), clientId: text("client_id"), source: text("source").notNull().default("manual"), createdAt: timestamp("created_at", {withTimezone:true}).defaultNow().notNull() });
export const backupTargets=pgTable("backup_targets",{id:uuid("id").defaultRandom().primaryKey(),scope:text("scope").notNull().default("workspace"),workspaceId:uuid("workspace_id").references(()=>workspaces.id),type:text("type").notNull(),name:text("name").notNull(),endpoint:text("endpoint").notNull(),prefix:text("prefix").notNull().default("knowledge"),credentials:text("credentials").notNull(),encryptionKey:text("encryption_key"),encryptionFingerprint:text("encryption_fingerprint"),schedule:text("schedule").notNull().default("manual"),retainDaily:integer("retain_daily").notNull().default(7),retainWeekly:integer("retain_weekly").notNull().default(4),enabled:boolean("enabled").notNull().default(true),createdBy:uuid("created_by").notNull().references(()=>users.id),lastRunAt:timestamp("last_run_at",{withTimezone:true}),lastRestoreTestAt:timestamp("last_restore_test_at",{withTimezone:true}),lastRestoreTestStatus:text("last_restore_test_status"),createdAt:timestamp("created_at",{withTimezone:true}).defaultNow().notNull()});
export const backupRuns=pgTable("backup_runs",{id:uuid("id").defaultRandom().primaryKey(),targetId:uuid("target_id").notNull().references(()=>backupTargets.id),workspaceId:uuid("workspace_id").references(()=>workspaces.id),status:text("status").notNull().default("pending"),bytes:bigint("bytes",{mode:"number"}),checksumSha256:text("checksum_sha256"),remotePath:text("remote_path"),error:text("error"),manifest:jsonb("manifest"),startedAt:timestamp("started_at",{withTimezone:true}),finishedAt:timestamp("finished_at",{withTimezone:true}),createdAt:timestamp("created_at",{withTimezone:true}).defaultNow().notNull()});

/** 只读预检结果。口令和包正文都不落库；checksum 把计划绑定到预检时的远端对象。 */
export const backupRestorePlans=pgTable("backup_restore_plans",{
  id:uuid("id").defaultRandom().primaryKey(),targetId:uuid("target_id").notNull().references(()=>backupTargets.id,{onDelete:"cascade"}),actorId:uuid("actor_id").notNull().references(()=>users.id),targetWorkspaceId:uuid("target_workspace_id").references(()=>workspaces.id),remotePath:text("remote_path").notNull(),checksumSha256:text("checksum_sha256").notNull(),format:text("format").notNull(),version:integer("version").notNull(),encrypted:boolean("encrypted").notNull(),mode:text("mode").notNull(),status:text("status").notNull().default("ready"),compatible:boolean("compatible").notNull().default(false),counts:jsonb("counts").notNull().default({}),conflicts:jsonb("conflicts").notNull().default([]),warnings:jsonb("warnings").notNull().default([]),expiresAt:timestamp("expires_at",{withTimezone:true}).notNull(),createdAt:timestamp("created_at",{withTimezone:true}).defaultNow().notNull(),usedAt:timestamp("used_at",{withTimezone:true})
},t=>[index("backup_restore_plans_target_idx").on(t.targetId,t.createdAt)]);

export const backupRestoreRuns=pgTable("backup_restore_runs",{
  id:uuid("id").defaultRandom().primaryKey(),planId:uuid("plan_id").notNull().references(()=>backupRestorePlans.id,{onDelete:"cascade"}),targetId:uuid("target_id").notNull().references(()=>backupTargets.id,{onDelete:"cascade"}),actorId:uuid("actor_id").notNull().references(()=>users.id),workspaceId:uuid("workspace_id").references(()=>workspaces.id),mode:text("mode").notNull(),status:text("status").notNull().default("pending"),drill:boolean("drill").notNull().default(false),checkpointRunId:uuid("checkpoint_run_id").references(()=>backupRuns.id),stats:jsonb("stats").notNull().default({}),warnings:jsonb("warnings").notNull().default([]),error:text("error"),startedAt:timestamp("started_at",{withTimezone:true}),finishedAt:timestamp("finished_at",{withTimezone:true}),createdAt:timestamp("created_at",{withTimezone:true}).defaultNow().notNull()
},t=>[index("backup_restore_runs_target_idx").on(t.targetId,t.createdAt)]);

export const backgroundJobs = pgTable("background_jobs", { id: uuid("id").defaultRandom().primaryKey(), type: text("type").notNull(), payload: jsonb("payload").notNull().default({}), status: text("status").notNull().default("pending"), attempts: integer("attempts").notNull().default(0), runAfter: timestamp("run_after", {withTimezone:true}).defaultNow().notNull(), lockedAt: timestamp("locked_at", {withTimezone:true}), lastError: text("last_error"), createdAt: timestamp("created_at", {withTimezone:true}).defaultNow().notNull(), finishedAt: timestamp("finished_at", {withTimezone:true}) });

export const mcpDailyUsage=pgTable("mcp_daily_usage",{tokenId:uuid("token_id").notNull().references(()=>mcpTokens.id),day:text("day").notNull(),writeBytes:bigint("write_bytes",{mode:"number"}).notNull().default(0)},t=>[primaryKey({columns:[t.tokenId,t.day]})]);
export const mcpIdempotency=pgTable("mcp_idempotency",{tokenId:uuid("token_id").notNull().references(()=>mcpTokens.id,{onDelete:"cascade"}),toolName:text("tool_name").notNull(),idempotencyKey:text("idempotency_key").notNull(),requestHash:text("request_hash").notNull(),status:text("status").notNull().default("pending"),result:jsonb("result"),expiresAt:timestamp("expires_at",{withTimezone:true}).notNull(),createdAt:timestamp("created_at",{withTimezone:true}).defaultNow().notNull(),updatedAt:timestamp("updated_at",{withTimezone:true}).defaultNow().notNull()},t=>[primaryKey({columns:[t.tokenId,t.toolName,t.idempotencyKey]})]);
export const mcpAttachmentUploads=pgTable("mcp_attachment_uploads",{id:uuid("id").defaultRandom().primaryKey(),tokenId:uuid("token_id").notNull().references(()=>mcpTokens.id,{onDelete:"cascade"}),noteId:uuid("note_id").notNull().references(()=>notes.id,{onDelete:"cascade"}),userId:uuid("user_id").notNull().references(()=>users.id),filename:text("filename").notNull(),mime:text("mime").notNull(),expectedBytes:bigint("expected_bytes",{mode:"number"}).notNull(),expectedSha256:text("expected_sha256").notNull(),secretHash:text("secret_hash").notNull(),status:text("status").notNull().default("pending"),attachmentId:uuid("attachment_id").references(()=>attachments.id),expiresAt:timestamp("expires_at",{withTimezone:true}).notNull(),createdAt:timestamp("created_at",{withTimezone:true}).defaultNow().notNull(),updatedAt:timestamp("updated_at",{withTimezone:true}).defaultNow().notNull()});

export const auditLogs = pgTable("audit_logs", { id: uuid("id").defaultRandom().primaryKey(), userId: uuid("user_id"), workspaceId: uuid("workspace_id"), actorType: text("actor_type").notNull(), actorId: uuid("actor_id"), action: text("action").notNull(), targetType: text("target_type"), targetId: uuid("target_id"), result: text("result").notNull().default("ok"), details: jsonb("details"), createdAt: timestamp("created_at", {withTimezone:true}).defaultNow().notNull() });

/** 日历：task 与 event 同表，理由见 设计/16-日历与任务 §2.1。重复实例不落库，查询时展开。 */
export const calendarItems = pgTable("calendar_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  kind: text("kind").notNull().default("task"),
  title: text("title").notNull(),
  bodyMd: text("body_md").notNull().default(""),
  allDay: boolean("all_day").notNull().default(false),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  dueAt: timestamp("due_at", { withTimezone: true }),
  timezone: text("timezone").notNull().default("Asia/Shanghai"),
  status: text("status").notNull().default("open"),
  doneAt: timestamp("done_at", { withTimezone: true }),
  doneBy: uuid("done_by"),
  priority: integer("priority").notNull().default(0),
  color: text("color"),
  rrule: text("rrule"),
  rruleUntil: timestamp("rrule_until", { withTimezone: true }),
  source: text("source").notNull().default("manual"),
  sourceNoteId: uuid("source_note_id"),
  sourceAnchor: text("source_anchor"),
  sourceSubId: uuid("source_sub_id"),
  linkState: text("link_state").notNull().default("linked"),
  /** workspace：全体成员可见；private：仅创建者。source=note 的条目忽略此列，一律继承来源笔记。 */
  visibility: text("visibility").notNull().default("workspace"),
  notebookId: uuid("notebook_id"),
  assigneeUserId: uuid("assignee_user_id"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  updatedBy: uuid("updated_by").notNull().references(() => users.id),
  trashedAt: timestamp("trashed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** 重复项的单次例外。没有 override 的实例完全由 rrule 推导。 */
export const calendarOverrides = pgTable("calendar_overrides", {
  id: uuid("id").defaultRandom().primaryKey(),
  itemId: uuid("item_id").notNull().references(() => calendarItems.id),
  occurrenceStart: timestamp("occurrence_start", { withTimezone: true }).notNull(),
  action: text("action").notNull(),
  newStart: timestamp("new_start", { withTimezone: true }),
  newEnd: timestamp("new_end", { withTimezone: true }),
  doneAt: timestamp("done_at", { withTimezone: true }),
  doneBy: uuid("done_by"),
});

export const calendarReminders = pgTable("calendar_reminders", {
  id: uuid("id").defaultRandom().primaryKey(),
  itemId: uuid("item_id").notNull().references(() => calendarItems.id),
  kind: text("kind").notNull().default("relative"),
  offsetMin: integer("offset_min").notNull().default(-10),
  absoluteAt: timestamp("absolute_at", { withTimezone: true }),
  channel: text("channel").notNull().default("inapp"),
  status: text("status").notNull().default("pending"),
  firedAt: timestamp("fired_at", { withTimezone: true }),
});

export const calendarSubscriptions = pgTable("calendar_subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  url: text("url").notNull(),
  color: text("color"),
  enabled: boolean("enabled").notNull().default(true),
  etag: text("etag"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastError: text("last_error"),
  failCount: integer("fail_count").notNull().default(0),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** 对外 ICS 订阅地址：与 share_links.token 同级别的泄露面，可吊销。 */
export const calendarFeedTokens = pgTable("calendar_feed_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  token: text("token").notNull().unique(),
  scope: text("scope").notNull().default("mine"),
  status: text("status").notNull().default("active"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const usageAccounts = pgTable("usage_accounts", {
  ownerType: text("owner_type").notNull(),
  ownerId: uuid("owner_id").notNull(),
  bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
}, (t) => [primaryKey({ columns: [t.ownerType, t.ownerId] })]);

// —— MCP OAuth（RFC 7591 动态注册 + 授权码/PKCE）——
export const oauthClients = pgTable("oauth_clients", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: text("client_id").notNull().unique(),
  clientSecretHash: text("client_secret_hash"),
  clientName: text("client_name").notNull(),
  redirectUris: jsonb("redirect_uris").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const oauthRequests = pgTable("oauth_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  state: text("state"),
  scope: text("scope").notNull().default(""),
  resource: text("resource"),
  codeChallenge: text("code_challenge").notNull(),
  userId: uuid("user_id").references(() => users.id),
  // 同意页勾定的权限；换 token 时才据此建 mcp_tokens 行，明文不落库
  policy: jsonb("policy"),
  codeHash: text("code_hash").unique(),
  tokenId: uuid("token_id"),
  usedAt: timestamp("used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// 收藏与「最近打开」都是用户级的；note_visits 的 seen_at 顺带当在场心跳用（规格 03 的 3.5 / 3.7）
export const noteFavorites = pgTable("note_favorites", {
  userId: uuid("user_id").notNull().references(() => users.id),
  noteId: uuid("note_id").notNull().references(() => notes.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.noteId] })]);

export const noteVisits = pgTable("note_visits", {
  userId: uuid("user_id").notNull().references(() => users.id),
  noteId: uuid("note_id").notNull().references(() => notes.id),
  seenAt: timestamp("seen_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.noteId] })]);

/** Web Push 端点：一人多设备，掉线的置 gone 不再重试（设计 16 §5.7）。 */
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  status: text("status").notNull().default("active"),
  failCount: integer("fail_count").notNull().default(0),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** 日历模板：只存相对偏移，不存绝对日期，否则模板只能用一次（设计 16 §3.12）。 */
export const calendarTemplates = pgTable("calendar_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  description: text("description"),
  scope: text("scope").notNull().default("private"),
  items: jsonb("items").notNull().default([]),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** 实例级智能体。不是用户，回复走 comments.author_agent_id（设计 20）。 */
export const agents = pgTable("agents", {
  id: uuid("id").defaultRandom().primaryKey(),
  handle: text("handle").notNull().unique(),
  displayName: text("display_name").notNull(),
  bio: text("bio"),
  avatarEmoji: text("avatar_emoji").notNull().default("🤖"),
  avatarSha256: text("avatar_sha256"),
  avatarMime: text("avatar_mime"),
  systemPrompt: text("system_prompt").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  allowSquare: boolean("allow_square").notNull().default(true),
  allowCircle: boolean("allow_circle").notNull().default(true),
  knowledgeEnabled: boolean("knowledge_enabled").notNull().default(false),
  baseUrl: text("base_url").notNull(),
  chatModel: text("chat_model").notNull(),
  apiKey: text("api_key").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/** 同一来源同一智能体只回一次。 */
export const agentReplies = pgTable("agent_replies", {
  id: uuid("id").defaultRandom().primaryKey(),
  agentId: uuid("agent_id").notNull().references(() => agents.id),
  sourceType: text("source_type").notNull(),
  sourceId: uuid("source_id").notNull(),
  commentId: uuid("comment_id").notNull().references(() => comments.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [uniqueIndex("agent_replies_source_idx").on(t.agentId, t.sourceType, t.sourceId)]);

/** 实例导航的分组。站点挂在组下，删组会级联删站点（设计 19）。 */
export const navGroups = pgTable("nav_groups", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  sortKey: integer("sort_key").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** 导航里的一条去处。图标走 blob_store，url 可以是站内路径或 http(s)。 */
export const navLinks = pgTable("nav_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  groupId: uuid("group_id").notNull().references(() => navGroups.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  url: text("url").notNull(),
  description: text("description"),
  iconSha256: text("icon_sha256"),
  iconMime: text("icon_mime"),
  sortKey: integer("sort_key").notNull().default(0),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * 协同房间的 Y.Doc 快照（设计 17 §3.4）。这是**可丢的缓存**：
 * 删掉它只会让下一个房间从 notes.body_md 重新初始化，不丢任何已落库的内容。
 */
export const noteCollab = pgTable("note_collab", {
  noteId: uuid("note_id").primaryKey().references(() => notes.id),
  state: text("state").notNull(),
  updates: integer("updates").notNull().default(0),
  /** 房间上次落库时写下去的正文，用来认「外面有人改过」。 */
  bodyMd: text("body_md").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
