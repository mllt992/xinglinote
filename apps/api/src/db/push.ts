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
