import { sql } from "drizzle-orm";
import { z } from "zod";

export const analyticsQuerySchema = z.object({
  days: z.enum(["7", "30"]).default("30"),
  notebookId: z.string().uuid().optional(),
});

/** 含今天的 UTC 自然日。不用本地时区加减小时，跨夏令时仍然恰好 7/30 格。 */
export function analyticsWindow(days: 7 | 30, now = new Date()) {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    from: new Date(midnight - (days - 1) * 86400_000).toISOString(),
    until: new Date(midnight + 86400_000).toISOString(),
    through: new Date(midnight).toISOString().slice(0, 10),
  };
}

/**
 * 所有分支从 visible_notebooks / visible_notes 出发；包括双链另一端。
 * 成员资格放进同一 SQL 快照，不能先取一批 id 再用旧 ACL 跑聚合。
 * 只把 length(body_md) 带出基表，历史版本正文完全不读取。
 */
export function buildAnalyticsQuery(input: {
  workspaceId: string; userId: string; notebookId?: string; days: 7 | 30; now?: Date;
}) {
  const now = input.now ?? new Date();
  const range = analyticsWindow(input.days, now);
  return sql`
    with accessible_workspace as (
      select w.id, w.name, w.kind, w.frozen, m.role
      from workspaces w join workspace_members m on m.workspace_id = w.id
      where w.id = ${input.workspaceId}::uuid and m.user_id = ${input.userId}::uuid
    ), visible_notebooks as (
      select b.id, b.title, b.site_published from notebooks b
      join accessible_workspace w on w.id = b.workspace_id
      where b.trashed_at is null and (
        b.visibility = 'open' or b.created_by = ${input.userId}::uuid
        or (b.visibility = 'restricted' and exists (
          select 1 from notebook_members m
          where m.notebook_id = b.id and m.user_id = ${input.userId}::uuid
        ))
      )
    ), visible_notes as (
      select n.id, n.notebook_id, n.folder_id, n.tags, n.created_at,
        char_length(n.body_md) as characters,
        (n.published and n.moderation_status = 'none' and b.site_published) as published
      from notes n join visible_notebooks b on b.id = n.notebook_id
      where n.workspace_id = ${input.workspaceId}::uuid and n.trashed_at is null
    ), scope_notebooks as (
      select * from visible_notebooks where ${input.notebookId ?? null}::uuid is null or id = ${input.notebookId ?? null}::uuid
    ), scope_notes as (
      select n.* from visible_notes n join scope_notebooks b on b.id = n.notebook_id
    ), scope_folders as (
      select f.id, f.title from folders f join scope_notebooks b on b.id = f.notebook_id
      where f.trashed_at is null and f.workspace_id = ${input.workspaceId}::uuid
    ), recent_versions as (
      select v.note_id, v.version, (v.created_at at time zone 'UTC')::date as day
      from note_versions v join visible_notes n on n.id = v.note_id
      where v.created_at >= ${range.from}::timestamptz and v.created_at < ${range.until}::timestamptz
    ), scope_versions as (
      select v.* from recent_versions v join scope_notes n on n.id = v.note_id
    ), edited_notes as (
      select distinct note_id from recent_versions where version > 1
    ), visible_edges as (
      select distinct l.from_note_id, l.target_note_id from links l
      join visible_notes a on a.id = l.from_note_id
      join visible_notes b on b.id = l.target_note_id
      where l.state = 'resolved' and l.from_note_id <> l.target_note_id
    ), scope_edges as (
      select e.* from visible_edges e
      left join scope_notes a on a.id = e.from_note_id
      left join scope_notes b on b.id = e.target_note_id
      where a.id is not null or b.id is not null
    ), connected_notes as (
      select from_note_id as id from scope_edges union select target_note_id as id from scope_edges
    ), scope_attachments as (
      select a.mime, a.bytes from attachments a join scope_notes n on n.id = a.note_id
      where a.trashed_at is null and a.workspace_id = ${input.workspaceId}::uuid
    ), scope_tasks as (
      select t.status from calendar_items t join scope_notes n on n.id = t.source_note_id
      where t.source = 'note' and t.kind = 'task' and t.link_state = 'linked'
        and t.trashed_at is null and t.status in ('open', 'done')
        and t.workspace_id = ${input.workspaceId}::uuid
    ), days as (
      select ((${range.from}::timestamptz at time zone 'UTC')::date + i)::date as day
      from generate_series(0, ${input.days - 1}) i
    ), creations as (
      select (created_at at time zone 'UTC')::date as day, count(*) as total from scope_notes
      where created_at >= ${range.from}::timestamptz and created_at < ${range.until}::timestamptz
      group by 1
    ), edits as (
      select day, count(*) as versions, count(distinct note_id) filter (where version > 1) as edited
      from scope_versions group by day
    ), notebook_counts as (
      select b.id, b.title, count(n.id) as notes, coalesce(sum(n.characters), 0) as characters,
        count(e.note_id) as edited
      from visible_notebooks b left join visible_notes n on n.notebook_id = b.id
      left join edited_notes e on e.note_id = n.id group by b.id, b.title
    ), folder_counts as (
      select coalesce(f.id::text, 'root') as id, coalesce(f.title, '根目录') as title, count(*) as notes
      from scope_notes n left join scope_folders f on f.id = n.folder_id
      group by f.id, f.title
    ), top_folders as (
      select * from folder_counts order by notes desc, title, id limit 8
    ), note_tags as (
      select distinct n.id, btrim(tag #>> '{}') as title from scope_notes n
      cross join lateral jsonb_array_elements(case when jsonb_typeof(n.tags) = 'array' then n.tags else '[]'::jsonb end) tag
      where jsonb_typeof(tag) = 'string' and btrim(tag #>> '{}') <> ''
    ), top_tags as (
      select title as id, title, count(*) as notes from note_tags group by title order by notes desc, title limit 8
    )
    select
      (select row_to_json(w) from accessible_workspace w) as workspace,
      (${input.notebookId ?? null}::uuid is null or exists(select 1 from scope_notebooks)) as "scopeValid",
      jsonb_build_object(
        'scope', jsonb_build_object('notebookId', ${input.notebookId ?? null}::text,
          'title', coalesce((select title from scope_notebooks where id = ${input.notebookId ?? null}::uuid), '全部可读笔记本'),
          'days', ${input.days}::int, 'from', ${range.from.slice(0, 10)}::text, 'through', ${range.through}::text, 'timezone', 'UTC'),
        'generatedAt', ${now.toISOString()}::text,
        'summary', jsonb_build_object(
          'notebooks', (select count(*) from scope_notebooks), 'notes', (select count(*) from scope_notes),
          'folders', (select count(*) from scope_folders), 'characters', (select coalesce(sum(characters), 0) from scope_notes),
          'attachments', (select count(*) from scope_attachments), 'images', (select count(*) from scope_attachments where mime like 'image/%'),
          'attachmentBytes', (select coalesce(sum(bytes), 0) from scope_attachments), 'published', (select count(*) from scope_notes where published),
          'created', (select coalesce(sum(total), 0) from creations),
          'edited', (select count(distinct note_id) from scope_versions where version > 1),
          'versions', (select count(*) from scope_versions),
          'links', (select count(*) from scope_edges),
          'connectedNotes', (select count(*) from scope_notes n join connected_notes c on c.id = n.id),
          'isolatedNotes', (select count(*) from scope_notes n where not exists(select 1 from connected_notes c where c.id = n.id)),
          'tasks', (select count(*) from scope_tasks), 'tasksDone', (select count(*) from scope_tasks where status = 'done')
        ),
        'trend', (select jsonb_agg(jsonb_build_object('date', d.day::text, 'created', coalesce(c.total, 0), 'edited', coalesce(e.edited, 0), 'versions', coalesce(e.versions, 0)) order by d.day)
          from days d left join creations c on c.day = d.day left join edits e on e.day = d.day),
        'notebooks', coalesce((select jsonb_agg(n order by n.notes desc, n.title, n.id) from notebook_counts n), '[]'::jsonb),
        'folders', coalesce((select jsonb_agg(f order by f.notes desc, f.title, f.id) from top_folders f), '[]'::jsonb),
        'folderOtherNotes', (select coalesce(sum(notes), 0) from folder_counts where id not in (select id from top_folders)),
        'tags', coalesce((select jsonb_agg(t order by t.notes desc, t.title) from top_tags t), '[]'::jsonb)
      ) as data
  `;
}
