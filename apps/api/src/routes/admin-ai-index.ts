import { Hono } from "hono";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { aiChunks, aiProviders, instanceSettings, notes, workspaceAiSettings, workspaces } from "../db/schema.ts";
import { ok } from "../http.ts";
import { enqueueIndexNotes } from "../lib/ai-index.ts";
import { providerWorkspaceIds } from "../lib/ai-provider-workspaces.ts";
import { likeContains } from "../lib/like.ts";
import { currentUser } from "../lib/session.ts";

export const adminAiIndexRoutes = new Hono();

async function instanceAdmin(c: Parameters<typeof currentUser>[0]) {
  const user = await currentUser(c);
  if (!user) throw fail("UNAUTHENTICATED", "未登录");
  if (user.roleInstance !== "admin") throw fail("FORBIDDEN", "仅实例管理员可管理全站量化");
  return user;
}

const optionalUuid = z.string().uuid().optional();
const filterSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(["indexed", "pending", "running", "processing", "stale", "missing", "failed"]).optional(),
  workspaceId: optionalUuid,
  userId: optionalUuid,
  notebookId: optionalUuid,
  workspaceKind: z.enum(["personal", "team"]).optional(),
  aiIndex: z.enum(["on", "off"]).optional(),
  workspaceAi: z.enum(["on", "off"]).optional(),
  providerState: z.enum(["configured", "unconfigured"]).optional(),
  updatedFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  updatedTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sort: z.enum(["updated_desc", "updated_asc", "title_asc", "title_desc"]).default("updated_desc"),
});
type IndexFilters = z.infer<typeof filterSchema>;

function parseFilters(raw: unknown): IndexFilters {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return filterSchema.parse(Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== "" && value != null)));
}

function queryFilters(c: Parameters<typeof currentUser>[0]) {
  const value = (key: string) => c.req.query(key)?.trim() || undefined;
  return parseFilters({
    q: value("q"), status: value("status"), workspaceId: value("workspaceId"), userId: value("userId"),
    notebookId: value("notebookId"), workspaceKind: value("workspaceKind"), aiIndex: value("aiIndex"),
    workspaceAi: value("workspaceAi"), providerState: value("providerState"), updatedFrom: value("updatedFrom"),
    updatedTo: value("updatedTo"), sort: value("sort"),
  });
}

function baseConditions(filters: IndexFilters) {
  const conditions = [sql`n.trashed_at IS NULL`];
  if (filters.q) {
    const pattern = likeContains(filters.q);
    conditions.push(sql`(n.title ILIKE ${pattern} OR nb.title ILIKE ${pattern} OR w.name ILIKE ${pattern} OR creator.display_name ILIKE ${pattern} OR creator.handle ILIKE ${pattern} OR creator.email ILIKE ${pattern})`);
  }
  if (filters.workspaceId) conditions.push(sql`n.workspace_id=${filters.workspaceId}::uuid`);
  if (filters.userId) conditions.push(sql`n.created_by=${filters.userId}::uuid`);
  if (filters.notebookId) conditions.push(sql`n.notebook_id=${filters.notebookId}::uuid`);
  if (filters.workspaceKind) conditions.push(sql`w.kind=${filters.workspaceKind}`);
  if (filters.aiIndex) conditions.push(sql`n.ai_index=${filters.aiIndex === "on"}`);
  if (filters.workspaceAi) conditions.push(sql`w.ai_enabled=${filters.workspaceAi === "on"}`);
  if (filters.updatedFrom) conditions.push(sql`n.updated_at>=${filters.updatedFrom}::date`);
  if (filters.updatedTo) conditions.push(sql`n.updated_at<(${filters.updatedTo}::date+interval '1 day')`);
  return sql.join(conditions, sql` AND `);
}

function indexCte(filters: IndexFilters) {
  return sql`
    WITH latest_jobs AS (
      SELECT DISTINCT ON (payload->>'noteId') payload->>'noteId' note_id,status,run_after,last_error,created_at
      FROM background_jobs WHERE type='index_note'
      ORDER BY payload->>'noteId',created_at DESC
    ), chunk_state AS (
      SELECT note_id,count(*)::int chunks,max(created_at) indexed_at FROM ai_chunks GROUP BY note_id
    ), indexed_notes AS (
      SELECT n.id,n.title,n.workspace_id,n.notebook_id,n.created_by,n.ai_index,n.updated_at,
        w.name workspace_name,w.kind workspace_kind,w.ai_enabled workspace_ai_enabled,
        nb.title notebook_title,creator.display_name creator_name,creator.handle creator_handle,creator.email creator_email,
        coalesce(cs.chunks,0)::int chunks,cs.indexed_at,lj.status job_status,lj.run_after,lj.last_error,
        (ep.id IS NOT NULL AND em.model IS NOT NULL) provider_configured,
        ep.name provider_name,em.model embedding_model,
        CASE
          WHEN lj.status='running' THEN 'running'
          WHEN lj.status='pending' THEN 'pending'
          WHEN lj.status='failed' THEN 'failed'
          WHEN coalesce(cs.chunks,0)=0 THEN 'missing'
          WHEN cs.indexed_at<n.updated_at THEN 'stale'
          ELSE 'indexed'
        END status
      FROM notes n
      INNER JOIN workspaces w ON w.id=n.workspace_id
      INNER JOIN notebooks nb ON nb.id=n.notebook_id
      INNER JOIN users creator ON creator.id=n.created_by
      LEFT JOIN chunk_state cs ON cs.note_id=n.id
      LEFT JOIN latest_jobs lj ON lj.note_id=n.id::text
      LEFT JOIN workspace_ai_settings settings ON settings.workspace_id=w.id
      LEFT JOIN instance_settings inst ON inst.id=1
      -- 工作区没有单独配置向量模型时，沿用量化管理里的全站默认（与 aiEmbeddingProvider 一致）。
      LEFT JOIN LATERAL (SELECT CASE WHEN settings.embedding_provider_id IS NOT NULL AND settings.embedding_model IS NOT NULL
          THEN settings.embedding_provider_id ELSE inst.embedding_provider_id END provider_id,
        CASE WHEN settings.embedding_provider_id IS NOT NULL AND settings.embedding_model IS NOT NULL
          THEN settings.embedding_model ELSE inst.embedding_model END model) em ON true
      LEFT JOIN ai_providers ep ON ep.id=em.provider_id AND ep.enabled=true
        AND (ep.platform OR ep.workspace_id=w.id OR ep.workspace_ids @> jsonb_build_array(w.id::text))
      WHERE ${baseConditions(filters)}
    )
  `;
}

function postConditions(filters: IndexFilters, withStatus: boolean) {
  const conditions = [sql`true`];
  if (filters.providerState === "configured") conditions.push(sql`provider_configured=true`);
  if (filters.providerState === "unconfigured") conditions.push(sql`provider_configured=false`);
  if (withStatus && filters.status === "processing") conditions.push(sql`status IN ('pending','running')`);
  else if (withStatus && filters.status) conditions.push(sql`status=${filters.status}`);
  return sql.join(conditions, sql` AND `);
}

function orderBy(sort: IndexFilters["sort"]) {
  if (sort === "updated_asc") return sql`updated_at ASC,id ASC`;
  if (sort === "title_asc") return sql`lower(title) ASC,id ASC`;
  if (sort === "title_desc") return sql`lower(title) DESC,id DESC`;
  return sql`updated_at DESC,id DESC`;
}

type Raw = Record<string, unknown>;
const asRows = (value: unknown) => value as Raw[];
const text = (value: unknown) => value == null ? null : String(value);
const iso = (value: unknown) => value == null ? null : new Date(String(value)).toISOString();

adminAiIndexRoutes.get("/admin/ai/index/options", async c => {
  await instanceAdmin(c);
  const [workspaceRows, userRows, notebookRows, providers, assignments] = await Promise.all([
    db.execute(sql`SELECT w.id,w.name,w.kind,count(n.id)::int note_count FROM workspaces w LEFT JOIN notes n ON n.workspace_id=w.id AND n.trashed_at IS NULL GROUP BY w.id,w.name,w.kind ORDER BY lower(w.name),w.id`),
    db.execute(sql`SELECT u.id,u.display_name,u.handle,u.email,count(n.id)::int note_count FROM users u INNER JOIN notes n ON n.created_by=u.id AND n.trashed_at IS NULL GROUP BY u.id,u.display_name,u.handle,u.email ORDER BY lower(u.display_name),u.id`),
    db.execute(sql`SELECT nb.id,nb.title,nb.workspace_id,count(n.id)::int note_count FROM notebooks nb LEFT JOIN notes n ON n.notebook_id=nb.id AND n.trashed_at IS NULL GROUP BY nb.id,nb.title,nb.workspace_id HAVING count(n.id)>0 ORDER BY lower(nb.title),nb.id`),
    db.select().from(aiProviders).where(and(eq(aiProviders.enabled, true), isNull(aiProviders.ownerUserId))).orderBy(desc(aiProviders.updatedAt)),
    db.select({ providerId: workspaceAiSettings.embeddingProviderId, model: workspaceAiSettings.embeddingModel, updatedAt: workspaceAiSettings.updatedAt }).from(workspaceAiSettings).orderBy(desc(workspaceAiSettings.updatedAt)),
  ]);
  const assignedModels = new Map<string, Set<string>>();
  for (const row of assignments) if (row.providerId && row.model) {
    const models = assignedModels.get(row.providerId) ?? new Set<string>();
    models.add(row.model); assignedModels.set(row.providerId, models);
  }
  const providerOptions = providers.map(provider => ({
    id: provider.id, name: provider.name, platform: provider.platform, models: [...new Set([...(Array.isArray(provider.chatModels) ? provider.chatModels.filter((m): m is string => typeof m === "string") : []), ...(assignedModels.get(provider.id) ?? [])])],
  }));
  const preferred = assignments.find(row => row.providerId && row.model && providerOptions.some(provider => provider.id === row.providerId));
  return ok(c, {
    workspaces: asRows(workspaceRows).map(row => ({ id: String(row.id), name: String(row.name), kind: String(row.kind), noteCount: Number(row.note_count ?? 0) })),
    users: asRows(userRows).map(row => ({ id: String(row.id), displayName: String(row.display_name), handle: String(row.handle), email: String(row.email), noteCount: Number(row.note_count ?? 0) })),
    notebooks: asRows(notebookRows).map(row => ({ id: String(row.id), title: String(row.title), workspaceId: String(row.workspace_id), noteCount: Number(row.note_count ?? 0) })),
    providers: providerOptions,
    preferred: preferred ? { providerId: preferred.providerId, model: preferred.model } : null,
  });
});

adminAiIndexRoutes.get("/admin/ai/index", async c => {
  await instanceAdmin(c);
  const filters = queryFilters(c);
  const page = z.coerce.number().int().min(1).default(1).parse(c.req.query("page") || undefined);
  const pageSize = z.coerce.number().int().min(10).max(100).default(20).parse(c.req.query("pageSize") || undefined);
  const facetWhere = postConditions(filters, false), listWhere = postConditions(filters, true);
  const [aggregateResult, listResult] = await Promise.all([
    db.execute(sql`${indexCte(filters)} SELECT count(*)::int total,
      count(*) FILTER (WHERE status='indexed')::int indexed,
      count(*) FILTER (WHERE status='pending')::int pending,
      count(*) FILTER (WHERE status='running')::int running,
      count(*) FILTER (WHERE status='stale')::int stale,
      count(*) FILTER (WHERE status='missing')::int missing,
      count(*) FILTER (WHERE status='failed')::int failed,
      count(*) FILTER (WHERE provider_configured=false)::int unconfigured
      FROM indexed_notes WHERE ${facetWhere}`),
    db.execute(sql`${indexCte(filters)} SELECT * FROM indexed_notes WHERE ${listWhere} ORDER BY ${orderBy(filters.sort)} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`),
  ]);
  const aggregate = asRows(aggregateResult)[0] ?? {};
  const summary = { total: Number(aggregate.total ?? 0), indexed: Number(aggregate.indexed ?? 0), pending: Number(aggregate.pending ?? 0), running: Number(aggregate.running ?? 0), stale: Number(aggregate.stale ?? 0), missing: Number(aggregate.missing ?? 0), failed: Number(aggregate.failed ?? 0), unconfigured: Number(aggregate.unconfigured ?? 0) };
  const total = filters.status === "processing" ? summary.pending + summary.running : filters.status ? summary[filters.status] : summary.total;
  return ok(c, {
    summary, total, page, pageSize,
    notes: asRows(listResult).map(row => ({
      id: String(row.id), title: String(row.title), workspaceId: String(row.workspace_id), workspaceName: String(row.workspace_name), workspaceKind: String(row.workspace_kind), workspaceAiEnabled: Boolean(row.workspace_ai_enabled),
      notebookId: String(row.notebook_id), notebookTitle: String(row.notebook_title), creatorId: String(row.created_by), creatorName: String(row.creator_name), creatorHandle: String(row.creator_handle), creatorEmail: String(row.creator_email),
      aiIndex: Boolean(row.ai_index), updatedAt: iso(row.updated_at)!, indexedAt: iso(row.indexed_at), chunks: Number(row.chunks ?? 0), status: String(row.status), runAfter: iso(row.run_after), lastError: text(row.last_error),
      providerConfigured: Boolean(row.provider_configured), providerName: text(row.provider_name), embeddingModel: text(row.embedding_model),
    })),
  });
});

adminAiIndexRoutes.post("/admin/ai/index/config", async c => {
  await instanceAdmin(c);
  const body = z.object({ providerId: z.string().uuid(), embeddingModel: z.string().trim().min(1).max(200), autoEmbed: z.boolean().default(true) }).parse(await c.req.json());
  const [provider] = await db.select().from(aiProviders).where(and(eq(aiProviders.id, body.providerId), eq(aiProviders.enabled, true), isNull(aiProviders.ownerUserId)));
  if (!provider) throw fail("NOT_FOUND", "共享模型渠道不存在或已停用");
  const workspaceRows = await db.select({ id: workspaces.id }).from(workspaces);
  const workspaceIds = workspaceRows.map(row => row.id);
  const existing = workspaceIds.length ? await db.select().from(workspaceAiSettings).where(inArray(workspaceAiSettings.workspaceId, workspaceIds)) : [];
  const previous = new Map(existing.map(row => [row.workspaceId, row]));
  const changed = workspaceIds.filter(id => { const row = previous.get(id); return !row || row.embeddingProviderId !== provider.id || row.embeddingModel !== body.embeddingModel; });
  const noteRows = await db.select({ id: notes.id }).from(notes).where(isNull(notes.trashedAt));
  await db.transaction(async tx => {
    // 平台渠道本来就全站可用，不需要把工作区一个个挂上去。
    if (!provider.platform) await tx.update(aiProviders).set({ workspaceIds: [...new Set([...providerWorkspaceIds(provider), ...workspaceIds])], updatedAt: new Date() }).where(eq(aiProviders.id, provider.id));
    // 记成全站默认：之后新建的工作区没有单独配置时自动沿用。
    const embeddingDefault = { embeddingProviderId: provider.id, embeddingModel: body.embeddingModel, embeddingAutoEmbed: body.autoEmbed };
    await tx.insert(instanceSettings).values({ id: 1, ...embeddingDefault }).onConflictDoUpdate({ target: instanceSettings.id, set: embeddingDefault });
    for (const workspaceId of workspaceIds) await tx.insert(workspaceAiSettings).values({ workspaceId, embeddingProviderId: provider.id, embeddingModel: body.embeddingModel, autoEmbed: body.autoEmbed, updatedAt: new Date() }).onConflictDoUpdate({ target: workspaceAiSettings.workspaceId, set: { embeddingProviderId: provider.id, embeddingModel: body.embeddingModel, autoEmbed: body.autoEmbed, updatedAt: new Date() } });
    if (changed.length) await tx.delete(aiChunks).where(inArray(aiChunks.workspaceId, changed));
    await enqueueIndexNotes(tx, noteRows.map(row => row.id), { force: true, includeExcluded: true });
  });
  return ok(c, { workspaces: workspaceIds.length, queued: noteRows.length, invalidatedWorkspaces: changed.length });
});

adminAiIndexRoutes.post("/admin/ai/index/rebuild", async c => {
  await instanceAdmin(c);
  const body = z.object({
    filters: z.unknown().optional(),
    scope: z.enum(["all", "incomplete", "failed", "stale", "missing"]).default("incomplete"),
    noteIds: z.array(z.string().uuid()).max(500).optional(),
  }).parse(await c.req.json().catch(() => ({})));
  const filters = parseFilters(body.filters);
  const conditions = [postConditions(filters, !body.noteIds?.length)];
  if (body.noteIds?.length) conditions.push(sql`id IN (${sql.join(body.noteIds.map(id => sql`${id}::uuid`), sql`, `)})`);
  else if (body.scope === "incomplete") conditions.push(sql`status IN ('missing','stale','failed')`);
  else if (body.scope !== "all") conditions.push(sql`status=${body.scope}`);
  conditions.push(sql`status<>'running'`);
  const result = await db.execute(sql`${indexCte(filters)} SELECT id,provider_configured FROM indexed_notes WHERE ${sql.join(conditions, sql` AND `)}`);
  const rows = asRows(result), selected = rows.filter(row => Boolean(row.provider_configured));
  await enqueueIndexNotes(db, selected.map(row => String(row.id)), { force: true, includeExcluded: true });
  return ok(c, { queued: selected.length, skippedUnconfigured: rows.length - selected.length });
});
