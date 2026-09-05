import { and, count, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.ts";
import { notes } from "../db/schema.ts";
import { instanceConfig, moderationOn, queueReview } from "./moderation.ts";

/**
 * 文档站对外可见 = notes.published ∧ moderation_status=none ∧ 未进回收站。
 * 「发布为文档站」只翻 notebooks.site_published；笔记默认 published=false，
 * 站点一上线就会空壳——issue #38。首次上线时若还没有任何标了 published 的笔记，
 * 就把本里现有笔记一并标公开（开审核则进 pending_review）。
 *
 * 用「是否已有 published=true」而不是「是否已有对外可见页」做门槛，
 * 避免审核挂起时每次打开站点又重复入队。
 */
export function shouldSeedSiteNotes(publishedIntentCount: number, liveCount: number) {
  return publishedIntentCount === 0 && liveCount > 0;
}

/** 已对文档站表达过公开意图的篇（含审核中）。 */
export async function countPublishedIntentNotes(notebookId: string) {
  const [row] = await db.select({ n: count() }).from(notes).where(and(
    eq(notes.notebookId, notebookId),
    eq(notes.published, true),
    isNull(notes.trashedAt),
  ));
  return Number(row?.n ?? 0);
}

export async function countSitePublicNotes(notebookId: string) {
  const [row] = await db.select({ n: count() }).from(notes).where(and(
    eq(notes.notebookId, notebookId),
    eq(notes.published, true),
    eq(notes.moderationStatus, "none"),
    isNull(notes.trashedAt),
  ));
  return Number(row?.n ?? 0);
}

export async function countLiveNotes(notebookId: string) {
  const [row] = await db.select({ n: count() }).from(notes).where(and(
    eq(notes.notebookId, notebookId),
    isNull(notes.trashedAt),
  ));
  return Number(row?.n ?? 0);
}

/**
 * 站点刚上线（或已经上线却一片空白）时补齐公开页。
 * 已经有人按篇勾选过公开的，不动——保留「整本上线 + 单篇挑选」的两层模型。
 */
export async function seedSiteNotesIfEmpty(input: {
  notebookId: string;
  workspaceId: string;
  actorUserId: string;
}): Promise<{ seeded: number; heldForModeration: number }> {
  const [publishedIntent, liveCount] = await Promise.all([
    countPublishedIntentNotes(input.notebookId),
    countLiveNotes(input.notebookId),
  ]);
  if (!shouldSeedSiteNotes(publishedIntent, liveCount)) {
    return { seeded: 0, heldForModeration: 0 };
  }

  const rows = await db.select({
    id: notes.id,
    title: notes.title,
    bodyMd: notes.bodyMd,
    published: notes.published,
    moderationStatus: notes.moderationStatus,
  }).from(notes).where(and(
    eq(notes.notebookId, input.notebookId),
    isNull(notes.trashedAt),
  ));

  const targets = rows.filter(n => !n.published);
  if (!targets.length) return { seeded: 0, heldForModeration: 0 };

  const settings = await instanceConfig();
  const hold = moderationOn(settings, "article");
  let held = 0;

  for (const note of targets) {
    await db.update(notes).set({
      published: true,
      moderationStatus: hold ? "pending_review" : "none",
      updatedAt: new Date(),
      updatedBy: input.actorUserId,
    }).where(eq(notes.id, note.id));
    if (hold) {
      await queueReview({
        targetType: "note",
        targetId: note.id,
        scope: "article",
        workspaceId: input.workspaceId,
        authorUserId: input.actorUserId,
        snapshot: `${note.title}\n\n${note.bodyMd}`,
      });
      held += 1;
    }
  }

  return { seeded: targets.length, heldForModeration: held };
}
