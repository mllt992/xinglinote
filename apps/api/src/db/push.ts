import { sql } from "./client.ts";
import { seedBuiltin } from "./seed.ts";

const statements = [
  `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
  `CREATE TABLE IF NOT EXISTS instance_settings (
    id integer PRIMARY KEY DEFAULT 1,
    allow_open_registration boolean NOT NULL DEFAULT false,
    allow_email_registration boolean NOT NULL DEFAULT true,
    require_email_verification boolean NOT NULL DEFAULT false,
    allow_code_registration boolean NOT NULL DEFAULT true,
    allow_user_create_workspace boolean NOT NULL DEFAULT true,
    square_enabled boolean NOT NULL DEFAULT true,
    ai_enabled boolean NOT NULL DEFAULT true,
    first_admin_user_id uuid,
    default_theme_id text NOT NULL DEFAULT 'mono-modern',
    default_accent text,
    allow_user_install_themes boolean NOT NULL DEFAULT true,
    allow_user_accent boolean NOT NULL DEFAULT true,
    default_user_storage_bytes bigint NOT NULL DEFAULT 1073741824,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE,
    email_verified_at timestamptz,
    password_hash text NOT NULL,
    handle text NOT NULL UNIQUE,
    display_name text NOT NULL,
    bio text,
    role_instance text NOT NULL DEFAULT 'user',
    status text NOT NULL DEFAULT 'active',
    appearance text NOT NULL DEFAULT 'system',
    theme_id text NOT NULL DEFAULT 'mono-modern',
    accent text,
    storage_quota_bytes bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS registration_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code_hash text NOT NULL UNIQUE, code_prefix text NOT NULL,
    max_uses integer NOT NULL DEFAULT 1, used_count integer NOT NULL DEFAULT 0, expires_at timestamptz,
    note text, bind_workspace_id uuid, bind_role text, skip_email_verification boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'active', created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS registration_code_usages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code_id uuid NOT NULL REFERENCES registration_codes(id),
    user_id uuid NOT NULL REFERENCES users(id), used_at timestamptz NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS smtp_host text`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS smtp_port integer`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS smtp_user text`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS smtp_password text`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS smtp_from text`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS smtp_secure boolean NOT NULL DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS auth_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), token_hash text NOT NULL UNIQUE, purpose text NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_scheduled_at timestamptz`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id),
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS workspaces (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text NOT NULL UNIQUE,
    name text NOT NULL,
    kind text NOT NULL,
    owner_id uuid NOT NULL REFERENCES users(id),
    frozen boolean NOT NULL DEFAULT false,
    feed_enabled boolean NOT NULL DEFAULT true,
    ai_enabled boolean NOT NULL DEFAULT true,
    personal_user_id uuid UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deletion_scheduled_at timestamptz`,
  `CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    user_id uuid NOT NULL REFERENCES users(id),
    role text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS workspace_invites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash text NOT NULL UNIQUE, token_prefix text NOT NULL,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, role text NOT NULL DEFAULT 'viewer',
    expires_at timestamptz NOT NULL, max_uses integer, used_count integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'active', created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS notebooks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    slug text NOT NULL,
    title text NOT NULL,
    sort_key integer NOT NULL DEFAULT 0,
    visibility text NOT NULL DEFAULT 'open',
    default_ai_index boolean NOT NULL DEFAULT true,
    created_by uuid NOT NULL REFERENCES users(id),
    site_published boolean NOT NULL DEFAULT false,
    site_theme_id text,
    site_accent text,
    trashed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, slug)
  )`,
  `ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS trashed_by uuid REFERENCES users(id)`,
  `ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS trash_batch_id uuid`,
  `ALTER TABLE folders ADD COLUMN IF NOT EXISTS trashed_by uuid REFERENCES users(id)`,
  `ALTER TABLE folders ADD COLUMN IF NOT EXISTS trash_batch_id uuid`,
  `ALTER TABLE notes ADD COLUMN IF NOT EXISTS trashed_by uuid REFERENCES users(id)`,
  `ALTER TABLE notes ADD COLUMN IF NOT EXISTS trash_batch_id uuid`,
  `CREATE TABLE IF NOT EXISTS notebook_members (notebook_id uuid NOT NULL REFERENCES notebooks(id), user_id uuid NOT NULL REFERENCES users(id), role text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(notebook_id,user_id))`,
  `CREATE TABLE IF NOT EXISTS folders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    notebook_id uuid NOT NULL REFERENCES notebooks(id),
    parent_id uuid,
    title text NOT NULL,
    sort_key integer NOT NULL DEFAULT 0,
    trashed_at timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    notebook_id uuid NOT NULL REFERENCES notebooks(id),
    folder_id uuid,
    title text NOT NULL,
    sort_key integer NOT NULL DEFAULT 0,
    body_md text NOT NULL DEFAULT '',
    published boolean NOT NULL DEFAULT false,
    moderation_status text NOT NULL DEFAULT 'none',
    ai_index boolean NOT NULL DEFAULT true,
    version integer NOT NULL DEFAULT 1,
    created_by uuid NOT NULL REFERENCES users(id),
    updated_by uuid NOT NULL REFERENCES users(id),
    trashed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS attachments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id), note_id uuid NOT NULL REFERENCES notes(id), filename text NOT NULL, stored_name text NOT NULL, mime text NOT NULL, bytes bigint NOT NULL, sha256 text NOT NULL, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), trashed_at timestamptz)`,
  `CREATE TABLE IF NOT EXISTS links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    raw text NOT NULL,
    target_note_id uuid,
    target_heading text,
    display text,
    kind text NOT NULL DEFAULT 'wiki',
    state text NOT NULL DEFAULT 'unresolved',
    pos integer NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS links_from_idx ON links(from_note_id)`,
  `CREATE INDEX IF NOT EXISTS links_target_idx ON links(target_note_id)`,
  `CREATE TABLE IF NOT EXISTS note_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    note_id uuid NOT NULL REFERENCES notes(id),
    version integer NOT NULL,
    title text NOT NULL,
    body_md text NOT NULL,
    editor_id uuid NOT NULL,
    source text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (note_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS share_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token text NOT NULL UNIQUE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    target_type text NOT NULL DEFAULT 'note',
    target_id uuid NOT NULL,
    password_hash text,
    expires_at timestamptz,
    allow_robots boolean NOT NULL DEFAULT false,
    comments_enabled boolean NOT NULL DEFAULT true,
    status text NOT NULL DEFAULT 'active',
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS share_links_target_idx ON share_links(target_type, target_id)`,
  `CREATE TABLE IF NOT EXISTS posts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), author_user_id uuid NOT NULL REFERENCES users(id), workspace_id uuid,
    visibility text NOT NULL DEFAULT 'public', body text NOT NULL, note_id uuid, status text NOT NULL DEFAULT 'visible', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS post_reactions (
    post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id), kind text NOT NULL DEFAULT 'like', created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(post_id,user_id,kind)
  )`,
  `CREATE TABLE IF NOT EXISTS post_favorites (
    user_id uuid NOT NULL REFERENCES users(id), post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id, post_id)
  )`,
  `CREATE TABLE IF NOT EXISTS content_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    target_type text NOT NULL, target_id uuid NOT NULL,
    reporter_id uuid NOT NULL REFERENCES users(id),
    reason text NOT NULL, note text,
    status text NOT NULL DEFAULT 'pending',
    reviewer_id uuid REFERENCES users(id), review_note text,
    created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS content_reports_one_idx ON content_reports (reporter_id, target_type, target_id)`,
  `CREATE INDEX IF NOT EXISTS content_reports_pending_idx ON content_reports (status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS comments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_type text NOT NULL, target_id uuid NOT NULL, share_id uuid, site_notebook_id uuid, parent_id uuid,
    author_user_id uuid, guest_name text, guest_email text, body text NOT NULL, status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), edited_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS comments_target_idx ON comments(target_type,target_id,status)`,
  `CREATE TABLE IF NOT EXISTS corrections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note_id uuid NOT NULL REFERENCES notes(id), share_id uuid, site_notebook_id uuid,
    original_excerpt text NOT NULL, original_hash text NOT NULL, suggested text NOT NULL, comment text, author_user_id uuid, guest_name text, guest_email text,
    status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz, reviewed_by uuid
  )`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), type text NOT NULL, title text NOT NULL, body text, href text, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS ai_providers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id), owner_user_id uuid, kind text NOT NULL DEFAULT 'openai-compatible', base_url text NOT NULL, chat_model text NOT NULL, embedding_model text, api_key text NOT NULL, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS ai_chunks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE, workspace_id uuid NOT NULL REFERENCES workspaces(id), notebook_id uuid NOT NULL REFERENCES notebooks(id), chunk_index integer NOT NULL, content text NOT NULL, embedding double precision[], created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(note_id,chunk_index))`,
  `CREATE INDEX IF NOT EXISTS ai_chunks_note_idx ON ai_chunks(note_id)`,
  `CREATE OR REPLACE FUNCTION kb_cosine_distance(a double precision[],b double precision[]) RETURNS double precision LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT CASE WHEN sqrt(sa)*sqrt(sb)=0 THEN 1 ELSE 1-dot/(sqrt(sa)*sqrt(sb)) END FROM (SELECT sum(x*y) dot,sum(x*x) sa,sum(y*y) sb FROM unnest(a,b) z(x,y)) q $$`,
  `CREATE OR REPLACE FUNCTION kb_note_index_sync() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.ai_index=false OR NEW.trashed_at IS NOT NULL THEN DELETE FROM ai_chunks WHERE note_id=NEW.id; ELSE INSERT INTO background_jobs(type,payload) VALUES('index_note',jsonb_build_object('noteId',NEW.id)); END IF; RETURN NEW; END $$`,
  `DROP TRIGGER IF EXISTS notes_ai_index_sync ON notes`,
  `CREATE TRIGGER notes_ai_index_sync AFTER INSERT OR UPDATE OF title,body_md,ai_index,trashed_at,notebook_id ON notes FOR EACH ROW EXECUTE FUNCTION kb_note_index_sync()`,
  `CREATE TABLE IF NOT EXISTS ai_usage (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, workspace_id uuid NOT NULL, action text NOT NULL, model text, input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS mcp_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), secret_hash text NOT NULL UNIQUE, name text NOT NULL, user_id uuid NOT NULL REFERENCES users(id), workspace_id uuid NOT NULL REFERENCES workspaces(id), notebook_mode text NOT NULL DEFAULT 'inherit', notebook_ids jsonb NOT NULL DEFAULT '[]', rw text NOT NULL DEFAULT 'read', allow_delete boolean NOT NULL DEFAULT false, require_ai_index boolean NOT NULL DEFAULT true, allow_private_notebooks boolean NOT NULL DEFAULT false, expires_at timestamptz, status text NOT NULL DEFAULT 'active', last_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS backup_targets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope text NOT NULL DEFAULT 'workspace', workspace_id uuid REFERENCES workspaces(id), type text NOT NULL, name text NOT NULL, endpoint text NOT NULL, prefix text NOT NULL DEFAULT 'knowledge', credentials text NOT NULL, encryption_key text, encryption_fingerprint text, schedule text NOT NULL DEFAULT 'manual', retain_daily integer NOT NULL DEFAULT 7, retain_weekly integer NOT NULL DEFAULT 4, enabled boolean NOT NULL DEFAULT true, created_by uuid NOT NULL REFERENCES users(id), last_run_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS backup_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_id uuid NOT NULL REFERENCES backup_targets(id), workspace_id uuid REFERENCES workspaces(id), status text NOT NULL DEFAULT 'pending', bytes bigint, checksum_sha256 text, remote_path text, error text, manifest jsonb, started_at timestamptz, finished_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS background_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, run_after timestamptz NOT NULL DEFAULT now(), locked_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz)`,
  `CREATE INDEX IF NOT EXISTS background_jobs_pending_idx ON background_jobs(status,run_after)`,
  `ALTER TABLE notes ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE notes ADD COLUMN IF NOT EXISTS sort_key integer NOT NULL DEFAULT 0`,
  `ALTER TABLE mcp_tokens ADD COLUMN IF NOT EXISTS daily_write_limit_bytes bigint NOT NULL DEFAULT 10485760`,
  // 空 = 不限写入，也是新钥匙的默认；老钥匙保留自己原来的额度
  `ALTER TABLE share_links ADD COLUMN IF NOT EXISTS corrections_enabled boolean NOT NULL DEFAULT false`,
  `ALTER TABLE share_links ADD COLUMN IF NOT EXISTS show_backlinks boolean NOT NULL DEFAULT false`,
  `ALTER TABLE share_links ADD COLUMN IF NOT EXISTS heading_anchor text`,
  `ALTER TABLE posts ADD COLUMN IF NOT EXISTS edited_at timestamptz`,
  `ALTER TABLE attachments ADD COLUMN IF NOT EXISTS extracted_text text`,
  `ALTER TABLE attachments ADD COLUMN IF NOT EXISTS extract_status text NOT NULL DEFAULT 'none'`,
  `CREATE TABLE IF NOT EXISTS note_favorites (user_id uuid NOT NULL REFERENCES users(id), note_id uuid NOT NULL REFERENCES notes(id), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,note_id))`,
  `CREATE TABLE IF NOT EXISTS note_visits (user_id uuid NOT NULL REFERENCES users(id), note_id uuid NOT NULL REFERENCES notes(id), seen_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,note_id))`,
  `CREATE INDEX IF NOT EXISTS note_visits_recent ON note_visits (user_id, seen_at DESC)`,
  `ALTER TABLE mcp_tokens ADD COLUMN IF NOT EXISTS feed_public boolean NOT NULL DEFAULT false`,
  `ALTER TABLE mcp_tokens ADD COLUMN IF NOT EXISTS feed_workspace boolean NOT NULL DEFAULT false`,
  `ALTER TABLE mcp_tokens ALTER COLUMN daily_write_limit_bytes DROP NOT NULL`,
  `ALTER TABLE mcp_tokens ALTER COLUMN daily_write_limit_bytes DROP DEFAULT`,
  `CREATE TABLE IF NOT EXISTS oauth_clients (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id text NOT NULL UNIQUE, client_secret_hash text, client_name text NOT NULL, redirect_uris jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS oauth_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id text NOT NULL, redirect_uri text NOT NULL, state text, scope text NOT NULL DEFAULT '', resource text, code_challenge text NOT NULL, user_id uuid REFERENCES users(id), policy jsonb, code_hash text UNIQUE, used_at timestamptz, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
  `ALTER TABLE oauth_requests ADD COLUMN IF NOT EXISTS token_id uuid REFERENCES mcp_tokens(id)`,
  `CREATE INDEX IF NOT EXISTS oauth_requests_expires_idx ON oauth_requests(expires_at)`,
  `ALTER TABLE mcp_tokens ADD COLUMN IF NOT EXISTS client_id text`,
  `ALTER TABLE mcp_tokens ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'`,
  `CREATE TABLE IF NOT EXISTS mcp_daily_usage (token_id uuid NOT NULL REFERENCES mcp_tokens(id), day text NOT NULL, write_bytes bigint NOT NULL DEFAULT 0, PRIMARY KEY(token_id,day))`,
  `CREATE TABLE IF NOT EXISTS audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, workspace_id uuid, actor_type text NOT NULL, actor_id uuid, action text NOT NULL, target_type text, target_id uuid, result text NOT NULL DEFAULT 'ok', details jsonb, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS usage_accounts (owner_type text NOT NULL, owner_id uuid NOT NULL, bytes bigint NOT NULL DEFAULT 0, PRIMARY KEY(owner_type,owner_id))`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS default_user_storage_bytes bigint NOT NULL DEFAULT 1073741824`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_quota_bytes bigint`,
  `CREATE TABLE IF NOT EXISTS themes (
    id text PRIMARY KEY,
    name text NOT NULL,
    description text,
    author text,
    version text NOT NULL,
    builtin boolean NOT NULL DEFAULT false,
    enabled boolean NOT NULL DEFAULT true,
    manifest jsonb NOT NULL,
    installed_at timestamptz NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS task_anchors boolean NOT NULL DEFAULT true`,
  `CREATE TABLE IF NOT EXISTS calendar_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    kind text NOT NULL DEFAULT 'task',
    title text NOT NULL,
    body_md text NOT NULL DEFAULT '',
    all_day boolean NOT NULL DEFAULT false,
    starts_at timestamptz, ends_at timestamptz, due_at timestamptz,
    timezone text NOT NULL DEFAULT 'Asia/Shanghai',
    status text NOT NULL DEFAULT 'open',
    done_at timestamptz, done_by uuid,
    priority integer NOT NULL DEFAULT 0,
    color text,
    rrule text, rrule_until timestamptz,
    source text NOT NULL DEFAULT 'manual',
    source_note_id uuid, source_anchor text, source_sub_id uuid,
    link_state text NOT NULL DEFAULT 'linked',
    visibility text NOT NULL DEFAULT 'workspace',
    notebook_id uuid,
    assignee_user_id uuid,
    created_by uuid NOT NULL REFERENCES users(id),
    updated_by uuid NOT NULL REFERENCES users(id),
    trashed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'workspace'`,
  `CREATE OR REPLACE FUNCTION kb_note_tasks_sync() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO background_jobs(type,payload) VALUES('sync_note_tasks',jsonb_build_object('noteId',NEW.id)); RETURN NEW; END $$`,
  `DROP TRIGGER IF EXISTS notes_tasks_sync ON notes`,
  `CREATE TRIGGER notes_tasks_sync AFTER INSERT OR UPDATE OF body_md ON notes FOR EACH ROW EXECUTE FUNCTION kb_note_tasks_sync()`,
  `CREATE INDEX IF NOT EXISTS calendar_items_ws_start ON calendar_items (workspace_id, starts_at)`,
  `CREATE INDEX IF NOT EXISTS calendar_items_ws_due ON calendar_items (workspace_id, due_at)`,
  `CREATE INDEX IF NOT EXISTS calendar_items_note ON calendar_items (source_note_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS calendar_items_anchor ON calendar_items (source_note_id, source_anchor) WHERE source_anchor IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS calendar_overrides (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id uuid NOT NULL REFERENCES calendar_items(id),
    occurrence_start timestamptz NOT NULL,
    action text NOT NULL,
    new_start timestamptz, new_end timestamptz,
    done_at timestamptz, done_by uuid,
    UNIQUE (item_id, occurrence_start)
  )`,
  `CREATE TABLE IF NOT EXISTS calendar_reminders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id uuid NOT NULL REFERENCES calendar_items(id),
    kind text NOT NULL DEFAULT 'relative',
    offset_min integer NOT NULL DEFAULT -10,
    absolute_at timestamptz,
    channel text NOT NULL DEFAULT 'inapp',
    status text NOT NULL DEFAULT 'pending',
    fired_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS calendar_reminders_item ON calendar_reminders (item_id)`,
  `CREATE TABLE IF NOT EXISTS calendar_subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    name text NOT NULL, url text NOT NULL, color text,
    enabled boolean NOT NULL DEFAULT true,
    etag text, last_sync_at timestamptz, last_error text,
    fail_count integer NOT NULL DEFAULT 0,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS calendar_feed_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    user_id uuid NOT NULL REFERENCES users(id),
    token text NOT NULL UNIQUE,
    scope text NOT NULL DEFAULT 'mine',
    status text NOT NULL DEFAULT 'active',
    last_used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS moderation_enabled boolean NOT NULL DEFAULT false`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS moderation_square boolean NOT NULL DEFAULT true`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS moderation_circle boolean NOT NULL DEFAULT false`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS moderation_article boolean NOT NULL DEFAULT true`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS moderation_base_url text`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS moderation_model text`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS moderation_api_key text`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS moderation_rules text`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS moderation_categories jsonb NOT NULL DEFAULT '["politics","porn","violence","abuse","illegal","privacy","ad"]'::jsonb`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS moderation_threshold integer NOT NULL DEFAULT 60`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS moderation_on_error text NOT NULL DEFAULT 'review'`,
  `CREATE TABLE IF NOT EXISTS moderation_reviews (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    target_type text NOT NULL,
    target_id uuid NOT NULL,
    scope text NOT NULL,
    workspace_id uuid,
    author_user_id uuid NOT NULL REFERENCES users(id),
    snapshot text NOT NULL,
    ai_verdict text NOT NULL,
    ai_score integer,
    ai_categories jsonb NOT NULL DEFAULT '[]'::jsonb,
    ai_reason text,
    ai_model text,
    status text NOT NULL DEFAULT 'pending',
    reviewer_id uuid REFERENCES users(id),
    review_note text,
    reviewed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS moderation_reviews_pending_idx ON moderation_reviews (status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS moderation_reviews_target_idx ON moderation_reviews (target_type, target_id)`,
  `ALTER TABLE notes ADD COLUMN IF NOT EXISTS moderation_status text NOT NULL DEFAULT 'none'`,
  `ALTER TABLE moderation_reviews ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'publish'`,

  // —— 日历 P2：Web Push 与模板 ——
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS push_enabled boolean NOT NULL DEFAULT false`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS vapid_public_key text`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS vapid_private_key text`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS vapid_subject text`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id),
    endpoint text NOT NULL UNIQUE,
    p256dh text NOT NULL,
    auth text NOT NULL,
    user_agent text,
    status text NOT NULL DEFAULT 'active',
    fail_count integer NOT NULL DEFAULT 0,
    last_ok_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id, status)`,
  `CREATE TABLE IF NOT EXISTS calendar_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    name text NOT NULL,
    description text,
    scope text NOT NULL DEFAULT 'private',
    items jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS calendar_templates_ws_idx ON calendar_templates (workspace_id, scope)`,

  `ALTER TABLE themes ADD COLUMN IF NOT EXISTS installed_by uuid REFERENCES users(id)`,

  // —— 热路径上的索引。之前只有 links / comments / calendar 等几张表有，
  // 而 memberRole()、笔记树、附件、版本这些每次请求都要走的查询是全表扫的。——
  `CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members(user_id)`,
  `CREATE INDEX IF NOT EXISTS notes_workspace_idx ON notes(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS notes_notebook_idx ON notes(notebook_id)`,
  `CREATE INDEX IF NOT EXISTS notes_folder_idx ON notes(folder_id)`,
  `CREATE INDEX IF NOT EXISTS notes_created_by_idx ON notes(created_by)`,
  `CREATE INDEX IF NOT EXISTS notes_batch_idx ON notes(trash_batch_id)`,
  `CREATE INDEX IF NOT EXISTS folders_notebook_idx ON folders(notebook_id)`,
  `CREATE INDEX IF NOT EXISTS folders_workspace_idx ON folders(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS folders_batch_idx ON folders(trash_batch_id)`,
  `CREATE INDEX IF NOT EXISTS notebooks_workspace_idx ON notebooks(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS notebook_members_user_idx ON notebook_members(user_id)`,
  `CREATE INDEX IF NOT EXISTS attachments_note_idx ON attachments(note_id)`,
  `CREATE INDEX IF NOT EXISTS attachments_workspace_idx ON attachments(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS attachments_created_by_idx ON attachments(created_by)`,
  `CREATE INDEX IF NOT EXISTS note_versions_note_idx ON note_versions(note_id, version DESC)`,
  `CREATE INDEX IF NOT EXISTS share_links_workspace_idx ON share_links(workspace_id, status)`,
  `CREATE INDEX IF NOT EXISTS mcp_tokens_user_idx ON mcp_tokens(user_id, status)`,
  `CREATE INDEX IF NOT EXISTS audit_logs_workspace_idx ON audit_logs(workspace_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS posts_feed_idx ON posts(visibility, status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS post_reactions_post_idx ON post_reactions(post_id)`,
  `CREATE INDEX IF NOT EXISTS corrections_note_idx ON corrections(note_id, status)`,
  `CREATE INDEX IF NOT EXISTS backup_runs_ws_idx ON backup_runs(workspace_id, created_at DESC)`,

  // —— 枚举列的 CHECK。这些值全靠应用层 zod 把关，漏一处就直接落库了。
  // 用 DO 块是因为 ADD CONSTRAINT 没有 IF NOT EXISTS，而 push 会反复跑。——
  ...([
    ["users", "users_role_chk", "role_instance IN ('admin','user')"],
    ["users", "users_status_chk", "status IN ('active','banned','pending_verification','pending_deletion','deleted')"],
    ["workspaces", "workspaces_kind_chk", "kind IN ('personal','normal')"],
    ["workspace_members", "ws_members_role_chk", "role IN ('owner','admin','editor','viewer')"],
    ["notebooks", "notebooks_visibility_chk", "visibility IN ('open','private','restricted')"],
    ["notebook_members", "nb_members_role_chk", "role IN ('edit','view')"],
    ["mcp_tokens", "mcp_tokens_rw_chk", "rw IN ('read','write','manage')"],
    ["mcp_tokens", "mcp_tokens_mode_chk", "notebook_mode IN ('inherit','allowlist')"],
    ["share_links", "share_links_status_chk", "status IN ('active','revoked','expired')"],
  ].map(([table, name, expr]) => `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
      ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expr}) NOT VALID;
    END IF;
  END $$`)),


  // —— 协同编辑（设计 17 §3.4）。state 是 base64 的 Y 更新，存 text 省得为一张缓存表引入 bytea 的处理分支 ——
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS mcp_image_max_bytes bigint NOT NULL DEFAULT 5242880`,
  `CREATE TABLE IF NOT EXISTS note_collab (
    note_id uuid PRIMARY KEY REFERENCES notes(id),
    state text NOT NULL,
    updates integer NOT NULL DEFAULT 0,
    body_md text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS blob_store (
    sha256 text PRIMARY KEY,
    bytes bigint NOT NULL,
    refcount integer NOT NULL DEFAULT 0,
    path text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS attachments_sha256_idx ON attachments(sha256)`,

  // —— 实例导航页（设计 19）。图标走 blob_store，不进 attachments ——
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS nav_enabled boolean NOT NULL DEFAULT true`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS nav_public boolean NOT NULL DEFAULT true`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS nav_title text`,
  `ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS nav_subtitle text`,
  `CREATE TABLE IF NOT EXISTS nav_groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL,
    description text,
    sort_key integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS nav_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id uuid NOT NULL REFERENCES nav_groups(id) ON DELETE CASCADE,
    title text NOT NULL,
    url text NOT NULL,
    description text,
    icon_sha256 text,
    icon_mime text,
    sort_key integer NOT NULL DEFAULT 0,
    created_by uuid REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS nav_links_group_sort_idx ON nav_links(group_id, sort_key)`,

  // —— 智能体（设计 20）。实例级，回复走 comments.author_agent_id ——
  `CREATE TABLE IF NOT EXISTS agents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    handle text NOT NULL UNIQUE,
    display_name text NOT NULL,
    bio text,
    avatar_emoji text NOT NULL DEFAULT '🤖',
    system_prompt text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    allow_square boolean NOT NULL DEFAULT true,
    allow_circle boolean NOT NULL DEFAULT true,
    knowledge_enabled boolean NOT NULL DEFAULT false,
    base_url text NOT NULL,
    chat_model text NOT NULL,
    api_key text NOT NULL,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  )`,
  `ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_agent_id uuid`,
  `CREATE TABLE IF NOT EXISTS agent_replies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id uuid NOT NULL REFERENCES agents(id),
    source_type text NOT NULL,
    source_id uuid NOT NULL,
    comment_id uuid NOT NULL REFERENCES comments(id),
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS agent_replies_source_idx ON agent_replies(agent_id, source_type, source_id)`,
  `CREATE INDEX IF NOT EXISTS comments_agent_idx ON comments(author_agent_id)`,
];

async function main() {
  // 语句是按功能一路追加的，不保证拓扑有序：新库上 ALTER 可能排在它的 CREATE 前面。
  // 全部语句都幂等，所以失败的留到下一轮重试；某一轮一个都没成功才是真出错。
  let todo = statements;
  while (todo.length) {
    const failed: Array<{ sql: string; error: unknown }> = [];
    for (const s of todo) {
      try { await sql.unsafe(s); } catch (error) { failed.push({ sql: s, error }); }
    }
    if (failed.length === todo.length) {
      console.error(`还有 ${failed.length} 条语句无法执行，第一条：\n${failed[0]!.sql}`);
      throw failed[0]!.error;
    }
    todo = failed.map((f) => f.sql);
  }
  await seedBuiltin();
  console.log("schema ready");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
