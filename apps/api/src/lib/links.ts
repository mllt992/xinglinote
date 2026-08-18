import { and, eq, isNull, sql } from "drizzle-orm";
import { normalizeTitle } from "@kb/shared";
import { db } from "../db/client.ts";
import { links, notes } from "../db/schema.ts";

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

export async function rebuildLinks(noteId: string, workspaceId: string, body: string) {
  const parsed = parseWikiLinks(body);
  const candidates = await db.select({ id: notes.id, title: notes.title, notebookId: notes.notebookId }).from(notes)
    .where(and(eq(notes.workspaceId, workspaceId), isNull(notes.trashedAt)));
  await db.transaction(async (tx) => {
    await tx.delete(links).where(eq(links.fromNoteId, noteId));
    if (!parsed.length) return;
    const rows = parsed.map((p) => {
      const matches = candidates.filter((n) => normalizeTitle(n.title) === normalizeTitle(p.title));
      const target = matches.length === 1 ? matches[0] : null;
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
