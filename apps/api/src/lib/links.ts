import { and, eq, isNull } from "drizzle-orm";
import { normalizeTitle } from "@kb/shared";
import { applyWikiRawRewrites, previousWikiTargetId, retitleWikiRaw } from "@kb/shared/markdown";
import { db } from "../db/client.ts";
import { links, notes } from "../db/schema.ts";
import { writeNoteFile } from "./files.ts";
import { recordNoteVersion } from "./versions.ts";

type Parsed = { raw: string; title: string; heading: string | null; display: string | null; kind: "wiki" | "embed"; pos: number };

export function parseWikiLinks(body: string): Parsed[] {
  const out: Parsed[] = [];
  const codeRanges: Array<[number, number]> = [];
  for (const m of body.matchAll(/```[\s\S]*?```|`[^`\n]*`/g)) codeRanges.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const inCode = (pos: number) => codeRanges.some(([a, b]) => pos >= a && pos < b);
  for (const m of body.matchAll(/(!?)\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g)) {
    const pos = m.index ?? 0;
    if (inCode(pos)) continue;
    out.push({
      raw: m[0],
      title: m[2].trim(),
      heading: m[3]?.trim() ?? null,
      display: m[4]?.trim() ?? null,
      kind: m[1] ? "embed" : "wiki",
      pos,
    });
  }
  return out;
}

/** 一个工作区里所有能被 `[[标题]]` 命中的笔记。批量重建时查一次共用，别每篇各扫一遍。 */
export async function noteCandidates(workspaceId: string) {
  return db.select({ id: notes.id, title: notes.title, notebookId: notes.notebookId }).from(notes)
    .where(and(eq(notes.workspaceId, workspaceId), isNull(notes.trashedAt)));
}

export async function rebuildLinks(
  noteId: string,
  workspaceId: string,
  body: string,
  pool?: Awaited<ReturnType<typeof noteCandidates>>,
  opts?: { skipIncomingSync?: boolean },
) {
  const parsed = parseWikiLinks(body);
  const candidates = pool ?? await noteCandidates(workspaceId);
  const previous = await db.select({
    pos: links.pos,
    raw: links.raw,
    targetNoteId: links.targetNoteId,
  }).from(links).where(eq(links.fromNoteId, noteId));
  await db.transaction(async (tx) => {
    await tx.delete(links).where(eq(links.fromNoteId, noteId));
    if (!parsed.length) return;
    const rows = parsed.map((p) => {
      const matches = candidates.filter((n) => normalizeTitle(n.title) === normalizeTitle(p.title));
      let target = matches.length === 1 ? matches[0] : null;
      if (!target) {
        const prevId = previousWikiTargetId(p, previous);
        if (prevId && candidates.some(n => n.id === prevId)) {
          target = candidates.find(n => n.id === prevId) ?? null;
        }
      }
      return {
        fromNoteId: noteId,
        raw: p.raw,
        targetNoteId: target?.id ?? null,
        targetHeading: p.heading,
        display: p.display,
        kind: p.kind,
        state: target ? "resolved" : "unresolved",
        pos: p.pos,
      };
    });
    await tx.insert(links).values(rows);
  });
  if (!opts?.skipIncomingSync) await syncIncomingWikiTitles(noteId, workspaceId);
}

/**
 * 设计 04 §5.3：改名后按 target_note_id 回写入链 raw 的标题段。
 * 跳过自身（避免保存后又 bump 一版让编辑器 409）。
 * 对方 version 对不上说明那边有未保存的编辑，留给下次保存再写。
 */
async function syncIncomingWikiTitles(noteId: string, workspaceId: string) {
  const [me] = await db.select({
    id: notes.id,
    title: notes.title,
    updatedBy: notes.updatedBy,
  }).from(notes).where(eq(notes.id, noteId));
  if (!me) return;

  const incoming = await db
    .select({
      fromId: links.fromNoteId,
      raw: links.raw,
      pos: links.pos,
      title: notes.title,
      bodyMd: notes.bodyMd,
      version: notes.version,
      notebookId: notes.notebookId,
      published: notes.published,
      aiIndex: notes.aiIndex,
    })
    .from(links)
    .innerJoin(notes, eq(notes.id, links.fromNoteId))
    .where(and(eq(links.targetNoteId, noteId), isNull(notes.trashedAt)));

  const grouped = new Map<string, typeof incoming>();
  for (const row of incoming) {
    if (row.fromId === noteId) continue;
    const list = grouped.get(row.fromId) ?? [];
    list.push(row);
    grouped.set(row.fromId, list);
  }

  for (const [fromId, rows] of grouped) {
    const first = rows[0]!;
    const replacements = [];
    for (const row of rows) {
      const next = retitleWikiRaw(row.raw, me.title);
      if (next && next !== row.raw) replacements.push({ raw: row.raw, pos: row.pos, next });
    }
    if (!replacements.length) continue;
    const nextBody = applyWikiRawRewrites(first.bodyMd, replacements);
    if (nextBody === first.bodyMd) continue;
    const nextVersion = first.version + 1;
    const updated = await db.update(notes).set({
      bodyMd: nextBody,
      version: nextVersion,
      updatedAt: new Date(),
    }).where(and(eq(notes.id, fromId), eq(notes.version, first.version))).returning({ id: notes.id });
    if (!updated.length) continue;
    await recordNoteVersion(db, {
      noteId: fromId,
      version: nextVersion,
      previousVersion: first.version,
      title: first.title,
      bodyMd: nextBody,
      editorId: me.updatedBy,
      source: "link_rewrite",
    });
    await writeNoteFile({
      workspaceId,
      notebookId: first.notebookId,
      noteId: fromId,
      title: first.title,
      bodyMd: nextBody,
      published: first.published,
      aiIndex: first.aiIndex,
    });
    await rebuildLinks(fromId, workspaceId, nextBody, undefined, { skipIncomingSync: true });
  }
}

export async function backlinksFor(noteId: string) {
  return db
    .select({
      id: notes.id,
      title: notes.title,
      bodyMd: notes.bodyMd,
      raw: links.raw,
    })
    .from(links)
    .innerJoin(notes, eq(notes.id, links.fromNoteId))
    .where(and(eq(links.targetNoteId, noteId), isNull(notes.trashedAt)));
}

export function snippetAround(body: string, raw: string, length = 160) {
  const i = body.indexOf(raw);
  if (i < 0) return body.slice(0, length);
  const start = Math.max(0, i - Math.floor(length / 2));
  return body.slice(start, start + length).replace(/\s+/g, " ");
}
