import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
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
  smtpHost: text("smtp_host"), smtpPort: integer("smtp_port"), smtpUser: text("smtp_user"), smtpPassword: text("smtp_password"), smtpFrom: text("smtp_from"), smtpSecure: boolean("smtp_secure").notNull().default(false),
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
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
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
  createdBy: uuid("created_by").notNull().references(() => users.id),
  sitePublished: boolean("site_published").notNull().default(false),
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
});

export const notes = pgTable("notes", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  notebookId: uuid("notebook_id").notNull().references(() => notebooks.id),
  folderId: uuid("folder_id"),
  title: text("title").notNull(),
  bodyMd: text("body_md").notNull().default(""),
  published: boolean("published").notNull().default(false),
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
});

export const attachments = pgTable("attachments", {
  id: uuid("id").defaultRandom().primaryKey(), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id), noteId: uuid("note_id").notNull().references(() => notes.id),
  filename: text("filename").notNull(), storedName: text("stored_name").notNull(), mime: text("mime").notNull(), bytes: bigint("bytes", {mode:"number"}).notNull(), sha256: text("sha256").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id), createdAt: timestamp("created_at", {withTimezone:true}).defaultNow().notNull(), trashedAt: timestamp("trashed_at", {withTimezone:true}),
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

export const posts = pgTable("posts", {
  id: uuid("id").defaultRandom().primaryKey(), authorUserId: uuid("author_user_id").notNull().references(() => users.id), workspaceId: uuid("workspace_id"),
  visibility: text("visibility").notNull().default("public"), body: text("body").notNull(), noteId: uuid("note_id"), status: text("status").notNull().default("visible"),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export const postReactions = pgTable("post_reactions", { postId: uuid("post_id").notNull().references(() => posts.id), userId: uuid("user_id").notNull().references(() => users.id), kind: text("kind").notNull().default("like"), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull() }, t => [primaryKey({columns:[t.postId,t.userId,t.kind]})]);

export const comments = pgTable("comments", {
  id: uuid("id").defaultRandom().primaryKey(), targetType: text("target_type").notNull(), targetId: uuid("target_id").notNull(),
  shareId: uuid("share_id"), siteNotebookId: uuid("site_notebook_id"), parentId: uuid("parent_id"),
  authorUserId: uuid("author_user_id"), guestName: text("guest_name"), guestEmail: text("guest_email"),
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
  installedAt: timestamp("installed_at", { withTimezone: true }).defaultNow().notNull(),
});

export const aiProviders = pgTable("ai_providers", {
  id: uuid("id").defaultRandom().primaryKey(), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id), ownerUserId: uuid("owner_user_id"),
  kind: text("kind").notNull().default("openai-compatible"), baseUrl: text("base_url").notNull(), chatModel: text("chat_model").notNull(), embeddingModel: text("embedding_model"),
  apiKey: text("api_key").notNull(), enabled: boolean("enabled").notNull().default(true), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export const aiChunks=pgTable("ai_chunks",{id:uuid("id").defaultRandom().primaryKey(),noteId:uuid("note_id").notNull().references(()=>notes.id),workspaceId:uuid("workspace_id").notNull().references(()=>workspaces.id),notebookId:uuid("notebook_id").notNull().references(()=>notebooks.id),chunkIndex:integer("chunk_index").notNull(),content:text("content").notNull(),embedding:text("embedding"),createdAt:timestamp("created_at",{withTimezone:true}).defaultNow().notNull()});

export const aiUsage = pgTable("ai_usage", { id: uuid("id").defaultRandom().primaryKey(), userId: uuid("user_id").notNull(), workspaceId: uuid("workspace_id").notNull(), action: text("action").notNull(), model: text("model"), inputTokens: integer("input_tokens").notNull().default(0), outputTokens: integer("output_tokens").notNull().default(0), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull() });
export const mcpTokens = pgTable("mcp_tokens", { id: uuid("id").defaultRandom().primaryKey(), secretHash: text("secret_hash").notNull().unique(), name: text("name").notNull(), userId: uuid("user_id").notNull().references(() => users.id), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id), notebookMode: text("notebook_mode").notNull().default("inherit"), notebookIds: jsonb("notebook_ids").notNull().default([]), rw: text("rw").notNull().default("read"), allowDelete: boolean("allow_delete").notNull().default(false), requireAiIndex: boolean("require_ai_index").notNull().default(true), allowPrivateNotebooks: boolean("allow_private_notebooks").notNull().default(false), feedPublic: boolean("feed_public").notNull().default(false), feedWorkspace: boolean("feed_workspace").notNull().default(false), dailyWriteLimitBytes: bigint("daily_write_limit_bytes",{mode:"number"}), expiresAt: timestamp("expires_at", {withTimezone:true}), status: text("status").notNull().default("active"), lastUsedAt: timestamp("last_used_at", {withTimezone:true}), createdAt: timestamp("created_at", {withTimezone:true}).defaultNow().notNull() });
export const backupTargets=pgTable("backup_targets",{id:uuid("id").defaultRandom().primaryKey(),scope:text("scope").notNull().default("workspace"),workspaceId:uuid("workspace_id").references(()=>workspaces.id),type:text("type").notNull(),name:text("name").notNull(),endpoint:text("endpoint").notNull(),prefix:text("prefix").notNull().default("knowledge"),credentials:text("credentials").notNull(),encryptionKey:text("encryption_key"),encryptionFingerprint:text("encryption_fingerprint"),schedule:text("schedule").notNull().default("manual"),retainDaily:integer("retain_daily").notNull().default(7),retainWeekly:integer("retain_weekly").notNull().default(4),enabled:boolean("enabled").notNull().default(true),createdBy:uuid("created_by").notNull().references(()=>users.id),lastRunAt:timestamp("last_run_at",{withTimezone:true}),createdAt:timestamp("created_at",{withTimezone:true}).defaultNow().notNull()});
export const backupRuns=pgTable("backup_runs",{id:uuid("id").defaultRandom().primaryKey(),targetId:uuid("target_id").notNull().references(()=>backupTargets.id),workspaceId:uuid("workspace_id").references(()=>workspaces.id),status:text("status").notNull().default("pending"),bytes:bigint("bytes",{mode:"number"}),checksumSha256:text("checksum_sha256"),remotePath:text("remote_path"),error:text("error"),manifest:jsonb("manifest"),startedAt:timestamp("started_at",{withTimezone:true}),finishedAt:timestamp("finished_at",{withTimezone:true}),createdAt:timestamp("created_at",{withTimezone:true}).defaultNow().notNull()});

export const backgroundJobs = pgTable("background_jobs", { id: uuid("id").defaultRandom().primaryKey(), type: text("type").notNull(), payload: jsonb("payload").notNull().default({}), status: text("status").notNull().default("pending"), attempts: integer("attempts").notNull().default(0), runAfter: timestamp("run_after", {withTimezone:true}).defaultNow().notNull(), lockedAt: timestamp("locked_at", {withTimezone:true}), lastError: text("last_error"), createdAt: timestamp("created_at", {withTimezone:true}).defaultNow().notNull(), finishedAt: timestamp("finished_at", {withTimezone:true}) });

export const mcpDailyUsage=pgTable("mcp_daily_usage",{tokenId:uuid("token_id").notNull().references(()=>mcpTokens.id),day:text("day").notNull(),writeBytes:bigint("write_bytes",{mode:"number"}).notNull().default(0)},t=>[primaryKey({columns:[t.tokenId,t.day]})]);

export const auditLogs = pgTable("audit_logs", { id: uuid("id").defaultRandom().primaryKey(), userId: uuid("user_id"), workspaceId: uuid("workspace_id"), actorType: text("actor_type").notNull(), actorId: uuid("actor_id"), action: text("action").notNull(), targetType: text("target_type"), targetId: uuid("target_id"), result: text("result").notNull().default("ok"), details: jsonb("details"), createdAt: timestamp("created_at", {withTimezone:true}).defaultNow().notNull() });

export const usageAccounts = pgTable("usage_accounts", {
  ownerType: text("owner_type").notNull(),
  ownerId: uuid("owner_id").notNull(),
  bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
}, (t) => [primaryKey({ columns: [t.ownerType, t.ownerId] })]);
