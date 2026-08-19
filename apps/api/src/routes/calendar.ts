import { Hono } from "hono";
import { and, count, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import { canReadNote, type NbMemberRole, type WsRole } from "@kb/core";
import { AppError, fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { auditLogs, backgroundJobs, calendarFeedTokens, calendarItems, calendarOverrides, calendarReminders, calendarSubscriptions, calendarTemplates, notebookMembers, notebooks, notes, noteVersions, users, workspaces } from "../db/schema.ts";
import { env } from "../env.ts";
import { ok } from "../http.ts";
import { currentUser } from "../lib/session.ts";
import { memberRole } from "../lib/workspace.ts";
import { notebookAccess } from "../lib/notebook-access.ts";
import { assertUserStorage, textBytes } from "../lib/quota.ts";
import { limit } from "../lib/rate-limit.ts";
import { secureToken } from "../lib/tokens.ts";
import { writeNoteFile } from "../lib/files.ts";
import { completeCalendarItem, DEFAULT_TZ, localDayKey, occurrencesOf, rescheduleReminders, wallParts } from "../lib/calendar.ts";
import { itemsToTemplate, MAX_TEMPLATE_ITEMS, planTemplate, type TemplateItem } from "../lib/calendar-template.ts";
import { assertPublicUrl, buildIcs, syncSubscription } from "../lib/ics.ts";
import { parseQuickAdd } from "../lib/quick-add.ts";

export const calendarRoutes = new Hono();
/** 公开 ICS 订阅地址挂在根路径（架构 03 §2.6），不走 /api/v1：日历客户端只认这一个地址。 */
export const calendarFeedRoutes = new Hono();

const MAX_ITEMS_PER_WORKSPACE = 50_000;
const MAX_WINDOW_DAYS = 400;

async function requireUser(c: Parameters<typeof currentUser>[0]) {
  const user = await currentUser(c);
  if (!user) throw fail("UNAUTHENTICATED", "未登录");
  return user;
}

async function workspaceContext(c: Parameters<typeof currentUser>[0], workspaceId: string) {
  const user = await requireUser(c);
  const role = await memberRole(workspaceId, user.id);
  if (!role) throw fail("NOT_FOUND", "工作区不存在");
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) throw fail("NOT_FOUND", "工作区不存在");
  return { user, role, ws };
}

/**
 * 可见笔记本集合。日历一次要过滤成百上千条，逐条走 noteAccess 太贵，
 * 但判定必须与 canReadNote 完全一致——所以这里直接调它，只是把笔记本当成一篇代表笔记。
 */
async function visibleNotebookIds(workspaceId: string, userId: string, role: WsRole) {
  const nbs = await db.select().from(notebooks).where(and(eq(notebooks.workspaceId, workspaceId), isNull(notebooks.trashedAt)));
  const acl = await db.select().from(notebookMembers).where(inArray(notebookMembers.notebookId, nbs.length ? nbs.map(n => n.id) : ["00000000-0000-0000-0000-000000000000"]));
  const mine = new Map(acl.filter(a => a.userId === userId).map(a => [a.notebookId, a.role as NbMemberRole]));
  const visible = new Set<string>();
  for (const nb of nbs) {
    const allowed = canReadNote({
      actor: { kind: "user", userId },
      note: { id: nb.id, workspaceId, notebookId: nb.id, trashed: false },
      notebook: { id: nb.id, workspaceId, visibility: nb.visibility as "open" | "private" | "restricted", createdBy: nb.createdBy, frozenWorkspace: false },
      wsRole: role,
      nbMemberRole: mine.get(nb.id) ?? null,
      canSeeTrash: false,
    });
    if (allowed) visible.add(nb.id);
  }
  return visible;
}

/** source=note 的条目完全继承来源笔记的可见性：无权时不返回，而不是灰显。 */
async function readableItems(workspaceId: string, userId: string, role: WsRole, rows: Array<typeof calendarItems.$inferSelect>) {
  const visible = await visibleNotebookIds(workspaceId, userId, role);
  const noteIds = [...new Set(rows.map(r => r.sourceNoteId).filter((x): x is string => !!x))];
  const sourceNotes = noteIds.length ? await db.select({ id: notes.id, title: notes.title, trashedAt: notes.trashedAt }).from(notes).where(inArray(notes.id, noteIds)) : [];
  const noteById = new Map(sourceNotes.map(n => [n.id, n]));
  const kept = rows.filter(r => {
    if (r.source === "note") {
      const note = r.sourceNoteId ? noteById.get(r.sourceNoteId) : null;
      return !!note && !note.trashedAt && !!r.notebookId && visible.has(r.notebookId);
    }
    return r.visibility !== "private" || r.createdBy === userId;
  });
  return { kept, noteById };
}

function itemDto(row: typeof calendarItems.$inferSelect, noteTitle?: string | null, occurrence?: { occurrenceStart: Date; start: Date; end: Date | null; status: string; recurring: boolean }) {
  return {
    id: row.id,
    occurrenceStart: occurrence?.occurrenceStart ?? row.startsAt ?? row.dueAt,
    kind: row.kind,
    title: row.title,
    bodyMd: row.bodyMd,
    allDay: row.allDay,
    startsAt: occurrence?.start ?? row.startsAt,
    endsAt: occurrence?.end ?? row.endsAt,
    dueAt: occurrence && row.kind === "task" ? occurrence.start : row.dueAt,
    timezone: row.timezone,
    status: occurrence?.status ?? row.status,
    priority: row.priority,
    color: row.color,
    rrule: row.rrule,
    recurring: occurrence?.recurring ?? !!row.rrule,
    source: row.source,
    sourceNoteId: row.sourceNoteId,
    sourceNoteTitle: noteTitle ?? null,
    linkState: row.linkState,
    visibility: row.visibility,
    assigneeUserId: row.assigneeUserId,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
  };
}

async function loadItem(c: Parameters<typeof currentUser>[0], id: string, mode: "read" | "edit" = "read") {
  const user = await requireUser(c);
  const [item] = await db.select().from(calendarItems).where(eq(calendarItems.id, id));
  if (!item || item.trashedAt) throw fail("NOT_FOUND", "日历项不存在");
  const role = await memberRole(item.workspaceId, user.id);
  if (!role) throw fail("NOT_FOUND", "日历项不存在");
  const { kept } = await readableItems(item.workspaceId, user.id, role, [item]);
  if (!kept.length) throw fail("NOT_FOUND", "日历项不存在");
  if (mode === "edit") {
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, item.workspaceId));
    if (ws?.frozen) throw fail("FORBIDDEN", "工作区已冻结，暂时只读");
    if (role === "viewer") throw fail("FORBIDDEN", "只读成员不能修改日历");
  }
  return { user, role, item };
}

/**
 * 日历的每一次写都要留痕（设计 16 §3.7）。撤销栈只活在当前会话，
 * 「谁在什么时候把这条挪到哪儿」只能靠审计答，所以这里不挑操作、一律记。
 */
async function audit(workspaceId: string, userId: string, action: string, targetId: string | null, details?: Record<string, unknown>, targetType = "calendar_item") {
  await db.insert(auditLogs).values({
    userId, workspaceId, actorType: "user", actorId: userId,
    action, targetType, targetId, result: "ok", details: details ?? null,
  });
}

function windowFrom(c: { req: { query: (k: string) => string | undefined } }) {
  const now = Date.now();
  const from = new Date(c.req.query("from") ?? now - 7 * 86400_000);
  const to = new Date(c.req.query("to") ?? now + 30 * 86400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw fail("VALIDATION", "时间范围不合法");
  if (to <= from) throw fail("VALIDATION", "结束时间必须晚于开始时间");
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 86400_000) throw fail("VALIDATION", `一次最多查 ${MAX_WINDOW_DAYS} 天`);
  return { from, to };
}

// ── 读 ────────────────────────────────────────────────────────────────

calendarRoutes.get("/workspaces/:id/calendar", async c => {
  const workspaceId = c.req.param("id");
  const { user, role } = await workspaceContext(c, workspaceId);
  const { from, to } = windowFrom(c);
  const layers = new Set((c.req.query("layers") ?? "task,event,note").split(",").map(s => s.trim()));

  const rows = await db.select().from(calendarItems).where(and(eq(calendarItems.workspaceId, workspaceId), isNull(calendarItems.trashedAt)));
  const { kept, noteById } = await readableItems(workspaceId, user.id, role, rows);
  const scheduled = kept.filter(r => (r.startsAt ?? r.dueAt) && layers.has(r.kind));
  const overrides = scheduled.length
    ? await db.select().from(calendarOverrides).where(inArray(calendarOverrides.itemId, scheduled.map(r => r.id)))
    : [];
  const overridesByItem = new Map<string, Array<typeof calendarOverrides.$inferSelect>>();
  for (const o of overrides) overridesByItem.set(o.itemId, [...(overridesByItem.get(o.itemId) ?? []), o]);

  const items = scheduled
    .flatMap(row => occurrencesOf(row, overridesByItem.get(row.id) ?? [], from, to)
      .map(o => itemDto(row, row.sourceNoteId ? noteById.get(row.sourceNoteId)?.title : null, o)))
    .sort((a, b) => Number(a.startsAt ?? a.dueAt) - Number(b.startsAt ?? b.dueAt));

  // 足迹层：这天写了什么。只读，不可拖拽。
  let footprints: Array<{ id: string; title: string; notebookId: string; updatedAt: Date; createdAt: Date }> = [];
  if (layers.has("note")) {
    const visible = await visibleNotebookIds(workspaceId, user.id, role);
    footprints = visible.size
      ? (await db.select({ id: notes.id, title: notes.title, notebookId: notes.notebookId, updatedAt: notes.updatedAt, createdAt: notes.createdAt })
          .from(notes)
          .where(and(eq(notes.workspaceId, workspaceId), isNull(notes.trashedAt), gte(notes.updatedAt, from), lte(notes.updatedAt, to))))
          .filter(n => visible.has(n.notebookId))
      : [];
  }
  return ok(c, { items, notes: footprints, range: { from, to }, timezone: DEFAULT_TZ });
});

calendarRoutes.get("/workspaces/:id/calendar/inbox", async c => {
  const workspaceId = c.req.param("id");
  const { user, role, ws } = await workspaceContext(c, workspaceId);
  const rows = await db.select().from(calendarItems).where(and(eq(calendarItems.workspaceId, workspaceId), isNull(calendarItems.trashedAt)));
  const { kept, noteById } = await readableItems(workspaceId, user.id, role, rows);
  const tasks = kept.filter(r => r.kind === "task");
  const inbox = tasks.filter(r => !r.dueAt && !r.startsAt).map(r => itemDto(r, null));
  const groups = new Map<string, { noteId: string; noteTitle: string; items: ReturnType<typeof itemDto>[] }>();
  for (const r of tasks) {
    if (!r.sourceNoteId || (!r.dueAt && !r.startsAt)) continue;
    const title = noteById.get(r.sourceNoteId)?.title ?? "已删除的笔记";
    const group = groups.get(r.sourceNoteId) ?? { noteId: r.sourceNoteId, noteTitle: title, items: [] };
    group.items.push(itemDto(r, title));
    groups.set(r.sourceNoteId, group);
  }
  const now = Date.now();
  const overdue = tasks.filter(r => r.status === "open" && r.dueAt && r.dueAt.getTime() < now).length;
  // me / kind / canEdit 给面板用：「我的」筛选、指派下拉、只读成员藏掉写入口，都要它们
  return ok(c, { inbox, groups: [...groups.values()], overdue, me: user.id, workspaceKind: ws.kind, canEdit: role !== "viewer" && !ws.frozen, timezone: DEFAULT_TZ });
});

// ── 写 ────────────────────────────────────────────────────────────────

const itemBody = z.object({
  kind: z.enum(["task", "event"]).default("task"),
  title: z.string().min(1).max(200),
  bodyMd: z.string().max(2000).optional(),
  allDay: z.boolean().optional(),
  startsAt: z.string().datetime().nullish(),
  endsAt: z.string().datetime().nullish(),
  dueAt: z.string().datetime().nullish(),
  timezone: z.string().max(64).optional(),
  priority: z.number().int().min(0).max(3).optional(),
  color: z.string().max(32).nullish(),
  rrule: z.string().max(200).nullish(),
  rruleUntil: z.string().datetime().nullish(),
  visibility: z.enum(["workspace", "private"]).optional(),
  assigneeUserId: z.string().uuid().nullish(),
  reminders: z.array(z.object({ kind: z.enum(["relative", "absolute"]).default("relative"), offsetMin: z.number().int().min(-40320).max(0).default(-10), absoluteAt: z.string().datetime().nullish(), channel: z.enum(["inapp", "email", "push"]).default("inapp") })).max(5).optional(),
});

const date = (v: string | null | undefined) => (v ? new Date(v) : null);

calendarRoutes.post("/workspaces/:id/calendar/items", async c => {
  const workspaceId = c.req.param("id");
  const { user, role, ws } = await workspaceContext(c, workspaceId);
  if (role === "viewer") throw fail("FORBIDDEN", "只读成员不能创建日历项");
  if (ws.frozen) throw fail("FORBIDDEN", "工作区已冻结，暂时只读");
  limit(`calendar:create:${user.id}`, 30, 60_000);
  const [total] = await db.select({ n: count() }).from(calendarItems).where(eq(calendarItems.workspaceId, workspaceId));
  if ((total?.n ?? 0) >= MAX_ITEMS_PER_WORKSPACE) throw fail("QUOTA", "日历项已达上限，请先清理");
  const body = itemBody.parse(await c.req.json());
  if (body.kind === "event" && !body.startsAt) throw fail("VALIDATION", "日程必须有开始时间");
  if (body.assigneeUserId && ws.kind === "personal") throw fail("VALIDATION", "个人工作区不支持指派");
  const [row] = await db.insert(calendarItems).values({
    workspaceId, kind: body.kind, title: body.title.trim(), bodyMd: body.bodyMd ?? "",
    allDay: body.allDay ?? false, startsAt: date(body.startsAt), endsAt: date(body.endsAt),
    dueAt: date(body.dueAt) ?? date(body.startsAt), timezone: body.timezone ?? DEFAULT_TZ,
    priority: body.priority ?? 0, color: body.color ?? null, rrule: body.rrule ?? null, rruleUntil: date(body.rruleUntil),
    visibility: body.visibility ?? "workspace", assigneeUserId: body.assigneeUserId ?? null,
    source: "manual", createdBy: user.id, updatedBy: user.id,
  }).returning();
  if (body.reminders?.length) {
    await db.insert(calendarReminders).values(body.reminders.map(r => ({ itemId: row.id, kind: r.kind, offsetMin: r.offsetMin, absoluteAt: date(r.absoluteAt), channel: r.channel })));
    await rescheduleReminders(row.id);
  }
  await audit(workspaceId, user.id, "calendar.item.create", row.id, { kind: row.kind, title: row.title });
  return ok(c, itemDto(row), 201);
});

calendarRoutes.post("/workspaces/:id/calendar/quick-add", async c => {
  const workspaceId = c.req.param("id");
  const { user, role, ws } = await workspaceContext(c, workspaceId);
  if (role === "viewer") throw fail("FORBIDDEN", "只读成员不能创建日历项");
  if (ws.frozen) throw fail("FORBIDDEN", "工作区已冻结，暂时只读");
  limit(`calendar:quickadd:${user.id}`, 30, 60_000);
  const body = z.object({ text: z.string().min(1).max(300), commit: z.boolean().default(false) }).parse(await c.req.json());
  const parsed = parseQuickAdd(body.text, DEFAULT_TZ);
  if (!parsed.title) throw fail("VALIDATION", "没解析出标题");
  // 默认只回解析结果，让前端渲染芯片给人确认——绝不静默猜错时间就写库。
  if (!body.commit) return ok(c, { preview: parsed });
  const [row] = await db.insert(calendarItems).values({
    workspaceId, kind: parsed.startsAt ? "event" : "task", title: parsed.title,
    allDay: parsed.allDay, startsAt: parsed.startsAt, endsAt: parsed.endsAt, dueAt: parsed.dueAt,
    timezone: DEFAULT_TZ, priority: parsed.priority, rrule: parsed.rrule,
    source: "manual", createdBy: user.id, updatedBy: user.id,
  }).returning();
  await audit(workspaceId, user.id, "calendar.item.create", row.id, { kind: row.kind, title: row.title, via: "quick-add" });
  return ok(c, { item: itemDto(row), preview: parsed }, 201);
});

calendarRoutes.patch("/calendar/items/:id", async c => {
  const { user, item } = await loadItem(c, c.req.param("id"), "edit");
  const body = itemBody.partial().extend({ ifUnmodifiedSince: z.string().datetime().optional() }).parse(await c.req.json());
  // 弱冲突校验：日历项粒度太小，不值得上 expectedVersion，但也不能静默覆盖别人的改动。
  if (body.ifUnmodifiedSince && item.updatedAt.getTime() > new Date(body.ifUnmodifiedSince).getTime() + 1000) {
    const [editor] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, item.updatedBy));
    throw fail("CONFLICT_VERSION", `这条刚被${editor?.displayName ?? "其他人"}改过`);
  }
  if (item.source === "note" && (body.title || body.dueAt !== undefined || body.startsAt !== undefined)) {
    throw fail("VALIDATION", "这条来自笔记，请到原文修改，或先转为独立任务");
  }
  const patch: Partial<typeof calendarItems.$inferInsert> = { updatedBy: user.id, updatedAt: new Date() };
  if (body.title !== undefined) patch.title = body.title.trim();
  if (body.bodyMd !== undefined) patch.bodyMd = body.bodyMd;
  if (body.allDay !== undefined) patch.allDay = body.allDay;
  if (body.startsAt !== undefined) patch.startsAt = date(body.startsAt);
  if (body.endsAt !== undefined) patch.endsAt = date(body.endsAt);
  if (body.dueAt !== undefined) patch.dueAt = date(body.dueAt);
  if (body.priority !== undefined) patch.priority = body.priority;
  if (body.color !== undefined) patch.color = body.color ?? null;
  if (body.rrule !== undefined) patch.rrule = body.rrule ?? null;
  if (body.rruleUntil !== undefined) patch.rruleUntil = date(body.rruleUntil);
  if (body.visibility !== undefined) patch.visibility = body.visibility;
  if (body.assigneeUserId !== undefined) patch.assigneeUserId = body.assigneeUserId ?? null;
  const [saved] = await db.update(calendarItems).set(patch).where(eq(calendarItems.id, item.id)).returning();
  await rescheduleReminders(saved.id);
  await audit(item.workspaceId, user.id, "calendar.item.update", item.id, { fields: Object.keys(patch).filter(k => k !== "updatedBy" && k !== "updatedAt") });
  return ok(c, itemDto(saved));
});

/** 改期。重复条目必须说清改的是哪一次，缺 scope 一律按「仅此一次」，不替用户做决定。 */
calendarRoutes.post("/calendar/items/:id/reschedule", async c => {
  const { user, item } = await loadItem(c, c.req.param("id"), "edit");
  const body = z.object({
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime().nullish(),
    occurrenceStart: z.string().datetime().optional(),
    scope: z.enum(["one", "following"]).default("one"),
  }).parse(await c.req.json());
  const start = new Date(body.startsAt);
  const end = date(body.endsAt);

  if (item.rrule && body.occurrenceStart) {
    const occurrence = new Date(body.occurrenceStart);
    if (body.scope === "one") {
      const [existing] = await db.select().from(calendarOverrides).where(and(eq(calendarOverrides.itemId, item.id), eq(calendarOverrides.occurrenceStart, occurrence)));
      if (existing) await db.update(calendarOverrides).set({ action: "moved", newStart: start, newEnd: end }).where(eq(calendarOverrides.id, existing.id));
      else await db.insert(calendarOverrides).values({ itemId: item.id, occurrenceStart: occurrence, action: "moved", newStart: start, newEnd: end });
      await audit(item.workspaceId, user.id, "calendar.item.reschedule", item.id, { scope: "one", occurrenceStart: occurrence, startsAt: start });
      return ok(c, { scope: "one", occurrenceStart: occurrence, startsAt: start });
    }
    // 此后全部：原序列在该时刻前截断 + 新建后续序列，不原地改历史。
    await db.update(calendarItems).set({ rruleUntil: new Date(occurrence.getTime() - 1000), updatedBy: user.id, updatedAt: new Date() }).where(eq(calendarItems.id, item.id));
    const [created] = await db.insert(calendarItems).values({
      workspaceId: item.workspaceId, kind: item.kind, title: item.title, bodyMd: item.bodyMd, allDay: item.allDay,
      startsAt: item.startsAt ? start : null,
      endsAt: end ?? (item.startsAt && item.endsAt ? new Date(start.getTime() + (item.endsAt.getTime() - item.startsAt.getTime())) : null),
      dueAt: item.dueAt ? start : null, timezone: item.timezone, priority: item.priority, color: item.color,
      rrule: item.rrule, rruleUntil: null, visibility: item.visibility, assigneeUserId: item.assigneeUserId,
      source: item.source === "note" ? "manual" : item.source, createdBy: user.id, updatedBy: user.id,
    }).returning();
    await rescheduleReminders(created.id);
    await audit(item.workspaceId, user.id, "calendar.item.reschedule", item.id, { scope: "following", splitAt: occurrence, newItemId: created.id });
    return ok(c, { scope: "following", item: itemDto(created) }, 201);
  }

  const [saved] = await db.update(calendarItems).set({
    startsAt: item.startsAt ? start : null,
    endsAt: end ?? (item.startsAt && item.endsAt ? new Date(start.getTime() + (item.endsAt.getTime() - item.startsAt.getTime())) : null),
    dueAt: start,
    updatedBy: user.id, updatedAt: new Date(),
  }).where(eq(calendarItems.id, item.id)).returning();
  await rescheduleReminders(saved.id);
  await audit(item.workspaceId, user.id, "calendar.item.reschedule", item.id, { scope: "one", startsAt: start });
  return ok(c, { scope: "one", item: itemDto(saved) });
});

/** 勾选。来自笔记的条目要回写正文，且回写结果必须让用户看得见（返回 noteWritten）。 */
calendarRoutes.post("/calendar/items/:id/complete", async c => {
  const { user, item } = await loadItem(c, c.req.param("id"), "edit");
  const body = z.object({ done: z.boolean().default(true), occurrenceStart: z.string().datetime().optional() }).parse(await c.req.json().catch(() => ({})));
  const r = await completeCalendarItem(item, user.id, body.done, body.occurrenceStart ? new Date(body.occurrenceStart) : undefined);
  await audit(item.workspaceId, user.id, body.done ? "calendar.task.complete" : "calendar.task.reopen", item.id, { noteWritten: r.noteWritten, detached: r.detached, noteId: r.noteId, occurrenceStart: body.occurrenceStart ?? null });
  return ok(c, r);
});

calendarRoutes.delete("/calendar/items/:id", async c => {
  const { user, item } = await loadItem(c, c.req.param("id"), "edit");
  await db.update(calendarItems).set({ trashedAt: new Date(), updatedBy: user.id, updatedAt: new Date() }).where(eq(calendarItems.id, item.id));
  await rescheduleReminders(item.id);
  await audit(item.workspaceId, user.id, "calendar.item.trash", item.id, { title: item.title });
  return ok(c, { id: item.id, trashed: true });
});

calendarRoutes.post("/calendar/items/:id/restore", async c => {
  const user = await requireUser(c);
  const [item] = await db.select().from(calendarItems).where(eq(calendarItems.id, c.req.param("id")));
  if (!item) throw fail("NOT_FOUND", "日历项不存在");
  const role = await memberRole(item.workspaceId, user.id);
  if (!role || role === "viewer") throw fail("FORBIDDEN", "无权恢复");
  await db.update(calendarItems).set({ trashedAt: null, updatedBy: user.id, updatedAt: new Date() }).where(eq(calendarItems.id, item.id));
  await rescheduleReminders(item.id);
  await audit(item.workspaceId, user.id, "calendar.item.restore", item.id, { title: item.title });
  return ok(c, itemDto({ ...item, trashedAt: null }));
});

/** 脱离原文的条目：转成独立任务，而不是让用户面对一个断链。 */
calendarRoutes.post("/calendar/items/:id/detach", async c => {
  const { user, item } = await loadItem(c, c.req.param("id"), "edit");
  if (item.source !== "note") throw fail("VALIDATION", "这条本来就不来自笔记");
  const [saved] = await db.update(calendarItems).set({ source: "manual", sourceNoteId: null, sourceAnchor: null, linkState: "linked", updatedBy: user.id, updatedAt: new Date() }).where(eq(calendarItems.id, item.id)).returning();
  await audit(item.workspaceId, user.id, "calendar.item.detach", item.id, { fromNoteId: item.sourceNoteId });
  return ok(c, itemDto(saved));
});

// ── 提醒 ──────────────────────────────────────────────────────────────

calendarRoutes.get("/calendar/items/:id/reminders", async c => {
  const { item } = await loadItem(c, c.req.param("id"));
  const rows = await db.select().from(calendarReminders).where(eq(calendarReminders.itemId, item.id));
  return ok(c, { reminders: rows });
});

calendarRoutes.put("/calendar/items/:id/reminders", async c => {
  const { user, item } = await loadItem(c, c.req.param("id"), "edit");
  const body = z.object({
    reminders: z.array(z.object({
      kind: z.enum(["relative", "absolute"]).default("relative"),
      offsetMin: z.number().int().min(-40320).max(0).default(-10),
      absoluteAt: z.string().datetime().nullish(),
      channel: z.enum(["inapp", "email", "push"]).default("inapp"),
    })).max(5),
  }).parse(await c.req.json());
  await db.delete(calendarReminders).where(eq(calendarReminders.itemId, item.id));
  if (body.reminders.length) {
    await db.insert(calendarReminders).values(body.reminders.map(r => ({ itemId: item.id, kind: r.kind, offsetMin: r.offsetMin, absoluteAt: date(r.absoluteAt), channel: r.channel })));
  }
  await rescheduleReminders(item.id);
  await audit(item.workspaceId, user.id, "calendar.reminders.set", item.id, { count: body.reminders.length });
  const rows = await db.select().from(calendarReminders).where(eq(calendarReminders.itemId, item.id));
  return ok(c, { reminders: rows });
});

// ── 今天 ──────────────────────────────────────────────────────────────

calendarRoutes.get("/workspaces/:id/today", async c => {
  const workspaceId = c.req.param("id");
  const { user, role } = await workspaceContext(c, workspaceId);
  const now = new Date();
  const w = wallParts(now, DEFAULT_TZ);
  const from = new Date(Date.UTC(w.y, w.m - 1, w.d) - 12 * 3600_000);
  const to = new Date(from.getTime() + 48 * 3600_000);
  const rows = await db.select().from(calendarItems).where(and(eq(calendarItems.workspaceId, workspaceId), isNull(calendarItems.trashedAt)));
  const { kept, noteById } = await readableItems(workspaceId, user.id, role, rows);
  const overrides = kept.length ? await db.select().from(calendarOverrides).where(inArray(calendarOverrides.itemId, kept.map(r => r.id))) : [];
  const byItem = new Map<string, Array<typeof calendarOverrides.$inferSelect>>();
  for (const o of overrides) byItem.set(o.itemId, [...(byItem.get(o.itemId) ?? []), o]);
  const today = kept.flatMap(row => occurrencesOf(row, byItem.get(row.id) ?? [], from, to).map(o => itemDto(row, row.sourceNoteId ? noteById.get(row.sourceNoteId)?.title : null, o)));
  const overdue = kept.filter(r => r.status === "open" && r.dueAt && r.dueAt < from && !r.rrule).map(r => itemDto(r, r.sourceNoteId ? noteById.get(r.sourceNoteId)?.title : null));
  const visible = await visibleNotebookIds(workspaceId, user.id, role);
  const touched = (await db.select({ id: notes.id, title: notes.title, notebookId: notes.notebookId, updatedAt: notes.updatedAt })
    .from(notes).where(and(eq(notes.workspaceId, workspaceId), isNull(notes.trashedAt), gte(notes.updatedAt, from))))
    .filter(n => visible.has(n.notebookId));
  return ok(c, { date: `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`, timezone: DEFAULT_TZ, items: today, overdue, notes: touched });
});

// ── ICS 订阅（入）：只读，且 URL 必须过 SSRF 校验 ──────────────────────────

const MAX_SUBSCRIPTIONS = 5;

function subDto(row: typeof calendarSubscriptions.$inferSelect) {
  return { id: row.id, name: row.name, url: row.url, color: row.color, enabled: row.enabled, lastSyncAt: row.lastSyncAt, lastError: row.lastError, failCount: row.failCount, createdBy: row.createdBy };
}

async function loadSubscription(c: Parameters<typeof currentUser>[0], id: string) {
  const user = await requireUser(c);
  const [sub] = await db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.id, id));
  if (!sub) throw fail("NOT_FOUND", "订阅不存在");
  const role = await memberRole(sub.workspaceId, user.id);
  if (!role) throw fail("NOT_FOUND", "订阅不存在");
  if (role === "viewer" || (sub.createdBy !== user.id && role !== "owner" && role !== "admin")) throw fail("FORBIDDEN", "无权管理这个订阅");
  return { user, sub };
}

calendarRoutes.get("/workspaces/:id/calendar/subscriptions", async c => {
  const workspaceId = c.req.param("id");
  await workspaceContext(c, workspaceId);
  const rows = await db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.workspaceId, workspaceId)).orderBy(desc(calendarSubscriptions.createdAt));
  return ok(c, { subscriptions: rows.map(subDto), max: MAX_SUBSCRIPTIONS });
});

calendarRoutes.post("/workspaces/:id/calendar/subscriptions", async c => {
  const workspaceId = c.req.param("id");
  const { user, role, ws } = await workspaceContext(c, workspaceId);
  if (role === "viewer") throw fail("FORBIDDEN", "只读成员不能添加订阅");
  if (ws.frozen) throw fail("FORBIDDEN", "工作区已冻结，暂时只读");
  const body = z.object({ name: z.string().min(1).max(80), url: z.string().min(1).max(2000), color: z.string().max(32).nullish() }).parse(await c.req.json());
  const [total] = await db.select({ n: count() }).from(calendarSubscriptions).where(eq(calendarSubscriptions.workspaceId, workspaceId));
  if ((total?.n ?? 0) >= MAX_SUBSCRIPTIONS) throw fail("QUOTA", `一个工作区最多 ${MAX_SUBSCRIPTIONS} 个订阅`);
  await assertPublicUrl(body.url);
  const [row] = await db.insert(calendarSubscriptions).values({ workspaceId, name: body.name.trim(), url: body.url.trim(), color: body.color ?? null, createdBy: user.id }).returning();
  // 建完立刻拉一次，让人马上看见结果，而不是等半小时的轮询
  await db.insert(backgroundJobs).values({ type: "calendar_ics_sync", payload: { subscriptionId: row.id } });
  await audit(workspaceId, user.id, "calendar.subscription.create", row.id, { name: row.name, url: row.url }, "calendar_subscription");
  return ok(c, subDto(row), 201);
});

calendarRoutes.patch("/calendar/subscriptions/:sid", async c => {
  const { user, sub } = await loadSubscription(c, c.req.param("sid"));
  const body = z.object({ name: z.string().min(1).max(80).optional(), color: z.string().max(32).nullish(), enabled: z.boolean().optional() }).parse(await c.req.json());
  const [saved] = await db.update(calendarSubscriptions).set({
    ...(body.name !== undefined ? { name: body.name.trim() } : {}),
    ...(body.color !== undefined ? { color: body.color ?? null } : {}),
    // 重新启用 = 用户已经处理了问题，清掉失败计数，否则再失败一次就又被停用
    ...(body.enabled !== undefined ? { enabled: body.enabled, ...(body.enabled ? { failCount: 0, lastError: null } : {}) } : {}),
  }).where(eq(calendarSubscriptions.id, sub.id)).returning();
  await audit(sub.workspaceId, user.id, "calendar.subscription.update", sub.id, { enabled: saved.enabled }, "calendar_subscription");
  return ok(c, subDto(saved));
});

calendarRoutes.post("/calendar/subscriptions/:sid/sync", async c => {
  const { user, sub } = await loadSubscription(c, c.req.param("sid"));
  limit(`calendar:icssync:${user.id}`, 10, 600_000);
  try {
    const r = await syncSubscription(sub.id);
    const [saved] = await db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.id, sub.id));
    return ok(c, { ...r, subscription: subDto(saved) });
  } catch (e) {
    // 网络层的失败（DNS、超时）是 TypeError，落到全局兜底会变成没头没脑的「服务器错误」。
    // 手动同步是人按下去的，必须把真正的原因还给他。
    if (e instanceof AppError) throw e;
    throw fail("VALIDATION", `同步失败：${e instanceof Error ? e.message : String(e)}`);
  }
});

calendarRoutes.delete("/calendar/subscriptions/:sid", async c => {
  const { user, sub } = await loadSubscription(c, c.req.param("sid"));
  // 订阅内容本来就不可编辑，删订阅就把它带进来的条目一并清掉，不留孤儿
  await db.delete(calendarItems).where(and(eq(calendarItems.source, "ics"), eq(calendarItems.sourceSubId, sub.id)));
  await db.delete(calendarSubscriptions).where(eq(calendarSubscriptions.id, sub.id));
  await audit(sub.workspaceId, user.id, "calendar.subscription.delete", sub.id, { name: sub.name }, "calendar_subscription");
  return ok(c, { id: sub.id, deleted: true });
});

// ── ICS 导出（出）：对外唯一通道，token 与 share_links 同级别，可吊销可轮换 ────

function feedDto(row: typeof calendarFeedTokens.$inferSelect) {
  return { id: row.id, scope: row.scope, status: row.status, url: `${env.publicUrl}/calendar/feed/${row.token}.ics`, lastUsedAt: row.lastUsedAt, createdAt: row.createdAt };
}

calendarRoutes.get("/workspaces/:id/calendar/feed-tokens", async c => {
  const workspaceId = c.req.param("id");
  const { user } = await workspaceContext(c, workspaceId);
  const rows = await db.select().from(calendarFeedTokens)
    .where(and(eq(calendarFeedTokens.workspaceId, workspaceId), eq(calendarFeedTokens.userId, user.id)))
    .orderBy(desc(calendarFeedTokens.createdAt));
  return ok(c, { feeds: rows.filter(r => r.status === "active").map(feedDto) });
});

calendarRoutes.post("/workspaces/:id/calendar/feed-tokens", async c => {
  const workspaceId = c.req.param("id");
  const { user } = await workspaceContext(c, workspaceId);
  const body = z.object({ scope: z.enum(["mine", "workspace"]).default("mine") }).parse(await c.req.json().catch(() => ({})));
  const [row] = await db.insert(calendarFeedTokens).values({ workspaceId, userId: user.id, token: secureToken(32), scope: body.scope }).returning();
  await audit(workspaceId, user.id, "calendar.feed.create", row.id, { scope: row.scope }, "calendar_feed_token");
  return ok(c, feedDto(row), 201);
});

calendarRoutes.post("/calendar/feed-tokens/:fid/rotate", async c => {
  const user = await requireUser(c);
  const [old] = await db.select().from(calendarFeedTokens).where(and(eq(calendarFeedTokens.id, c.req.param("fid")), eq(calendarFeedTokens.userId, user.id)));
  if (!old || old.status !== "active") throw fail("NOT_FOUND", "订阅地址不存在");
  await db.update(calendarFeedTokens).set({ status: "revoked" }).where(eq(calendarFeedTokens.id, old.id));
  const [row] = await db.insert(calendarFeedTokens).values({ workspaceId: old.workspaceId, userId: old.userId, token: secureToken(32), scope: old.scope }).returning();
  await audit(old.workspaceId, user.id, "calendar.feed.rotate", row.id, { replaced: old.id, scope: row.scope }, "calendar_feed_token");
  return ok(c, feedDto(row), 201);
});

calendarRoutes.delete("/calendar/feed-tokens/:fid", async c => {
  const user = await requireUser(c);
  const [row] = await db.select().from(calendarFeedTokens).where(and(eq(calendarFeedTokens.id, c.req.param("fid")), eq(calendarFeedTokens.userId, user.id)));
  if (!row) throw fail("NOT_FOUND", "订阅地址不存在");
  await db.update(calendarFeedTokens).set({ status: "revoked" }).where(eq(calendarFeedTokens.id, row.id));
  await audit(row.workspaceId, user.id, "calendar.feed.revoke", row.id, { scope: row.scope }, "calendar_feed_token");
  return ok(c, { id: row.id, revoked: true });
});

/**
 * 公开的 ICS 订阅地址。无 Cookie、无 CSRF，只认 token。
 * 对「不存在 / 已吊销 / 持有人已不是成员」一律回同一句话，不泄露是哪一种。
 */
calendarFeedRoutes.get("/calendar/feed/:token", async c => {
  const token = c.req.param("token").replace(/\.ics$/i, "");
  const [feed] = await db.select().from(calendarFeedTokens).where(eq(calendarFeedTokens.token, token));
  if (!feed || feed.status !== "active") throw fail("NOT_FOUND", "内容不存在或已失效");
  const role = await memberRole(feed.workspaceId, feed.userId);
  const [owner] = await db.select().from(users).where(eq(users.id, feed.userId));
  if (!role || owner?.status !== "active") throw fail("NOT_FOUND", "内容不存在或已失效");
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, feed.workspaceId));

  const from = new Date(Date.now() - 90 * 86400_000);
  const rows = await db.select().from(calendarItems).where(and(eq(calendarItems.workspaceId, feed.workspaceId), isNull(calendarItems.trashedAt)));
  const { kept } = await readableItems(feed.workspaceId, feed.userId, role, rows);
  const items = kept.filter(r => {
    if (feed.scope === "mine" && r.createdBy !== feed.userId && r.assigneeUserId !== feed.userId) return false;
    const at = r.startsAt ?? r.dueAt;
    // 重复条目靠 RRULE 表达，本体一律带上，不按开始时刻裁掉
    return !!at && (!!r.rrule || at >= from);
  });

  await db.update(calendarFeedTokens).set({ lastUsedAt: new Date() }).where(eq(calendarFeedTokens.id, feed.id));
  const body = buildIcs(items, { name: `${ws?.name ?? "工作区"}${feed.scope === "mine" ? " · 我的" : ""}`, publicUrl: env.publicUrl });
  return c.body(body, 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": `inline; filename="calendar-${feed.scope}.ics"`,
    "Cache-Control": "private, max-age=900",
    "X-Robots-Tag": "noindex, nofollow",
  });
});

// ── 日记：点日期格就能写今天，按模板落到固定笔记本 ─────────────────────────

const DIARY_SLUG = "diary";

calendarRoutes.post("/workspaces/:id/calendar/diary", async c => {
  const workspaceId = c.req.param("id");
  const { user, role, ws } = await workspaceContext(c, workspaceId);
  if (role === "viewer") throw fail("FORBIDDEN", "只读成员不能写日记");
  if (ws.frozen) throw fail("FORBIDDEN", "工作区已冻结，暂时只读");
  const body = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(await c.req.json().catch(() => ({})));
  const day = body.date ?? localDayKey(new Date(), DEFAULT_TZ);
  const [y, m, d] = day.split("-").map(Number);
  const weekday = "日一二三四五六"[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];

  // slug 在工作区内唯一：回收站里那本也占着名额，不能当它不存在再插一本
  let [nb] = await db.select().from(notebooks).where(and(eq(notebooks.workspaceId, workspaceId), eq(notebooks.slug, DIARY_SLUG)));
  if (nb?.trashedAt) throw fail("GONE_TRASHED", "日记本在回收站里，先把它恢复出来");
  if (!nb) {
    if (role !== "owner" && role !== "admin") throw fail("FORBIDDEN", "还没有日记本，请让管理员先建一个");
    [nb] = await db.insert(notebooks).values({ workspaceId, slug: DIARY_SLUG, title: "日记", visibility: "private", createdBy: user.id }).returning();
  }
  await notebookAccess(nb.id, user.id, "edit");

  // 同一天只有一篇：第二次点「写今天的日记」是打开，不是再建一篇
  const [existing] = await db.select().from(notes).where(and(eq(notes.notebookId, nb.id), eq(notes.title, day), isNull(notes.trashedAt)));
  if (existing) return ok(c, { noteId: existing.id, notebookId: nb.id, created: false, date: day });

  const template = `# ${y}年${m}月${d}日 周${weekday}\n\n## 今天做了什么\n\n\n## 待办\n\n- [ ] \n\n## 想到什么\n\n`;
  await assertUserStorage(user.id, textBytes(day, template));
  const [note] = await db.insert(notes).values({
    workspaceId, notebookId: nb.id, folderId: null, title: day, bodyMd: template,
    aiIndex: nb.defaultAiIndex, createdBy: user.id, updatedBy: user.id,
  }).returning();
  await db.insert(noteVersions).values({ noteId: note.id, version: note.version, title: note.title, bodyMd: note.bodyMd, editorId: user.id, source: "ui" });
  await writeNoteFile({ ...note, noteId: note.id });
  await audit(workspaceId, user.id, "calendar.diary.create", note.id, { date: day }, "note");
  return ok(c, { noteId: note.id, notebookId: nb.id, created: true, date: day }, 201);
});

// ── 批量操作（设计 16 §3.11）────────────────────────────────────────────

const MAX_BATCH = 200;

/** 只快照这次动作会碰的字段。撤销是拿它原样写回去，多存的字段只会在并发时把别人的改动一起回滚。 */
type Snapshot = { id: string; status?: string; dueAt?: string | null; startsAt?: string | null; endsAt?: string | null; assigneeUserId?: string | null; priority?: number; trashed?: boolean };

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * 一次一批，逐条鉴权，部分成功。整批因为其中一条没权限就回滚，会让用户完全不知道是哪条卡住了。
 * 重复条目只作用于整条序列——要改单次仍走「仅此一次 / 此后全部」那条路径。
 */
calendarRoutes.post("/workspaces/:id/calendar/batch", async c => {
  const workspaceId = c.req.param("id");
  const { user, role, ws } = await workspaceContext(c, workspaceId);
  if (role === "viewer") throw fail("FORBIDDEN", "只读成员不能修改日历");
  if (ws.frozen) throw fail("FORBIDDEN", "工作区已冻结，暂时只读");
  limit(`calendar:batch:${user.id}`, 10, 60_000);
  const body = z.object({
    ids: z.array(z.string().uuid()).min(1).max(MAX_BATCH),
    action: z.enum(["complete", "reopen", "shift", "setDue", "assign", "priority", "trash", "restore", "revert"]),
    days: z.number().int().min(-3650).max(3650).optional(),
    dueAt: z.string().datetime().nullish(),
    assigneeUserId: z.string().uuid().nullish(),
    priority: z.number().int().min(0).max(3).optional(),
    snapshot: z.array(z.object({
      id: z.string().uuid(), status: z.string().optional(),
      dueAt: z.string().datetime().nullish(), startsAt: z.string().datetime().nullish(), endsAt: z.string().datetime().nullish(),
      assigneeUserId: z.string().uuid().nullish(), priority: z.number().int().min(0).max(3).optional(), trashed: z.boolean().optional(),
    })).max(MAX_BATCH).optional(),
  }).parse(await c.req.json());
  if (body.action === "shift" && body.days == null) throw fail("VALIDATION", "改期要带天数");
  if (body.action === "revert" && !body.snapshot?.length) throw fail("VALIDATION", "撤销要带快照");
  if (body.action === "assign" && body.assigneeUserId && ws.kind === "personal") throw fail("VALIDATION", "个人工作区不支持指派");

  const ids = [...new Set(body.ids)];
  const rows = await db.select().from(calendarItems).where(and(eq(calendarItems.workspaceId, workspaceId), inArray(calendarItems.id, ids)));
  // 回收站里的条目对 restore / revert 仍然可见，其余动作按「不存在」处理
  const allowTrashed = body.action === "restore" || body.action === "revert";
  const { kept } = await readableItems(workspaceId, user.id, role, rows.filter(r => allowTrashed || !r.trashedAt));
  const byId = new Map(kept.map(r => [r.id, r]));
  const snapshotById = new Map((body.snapshot ?? []).map(s => [s.id, s]));

  const batch = crypto.randomUUID();
  const done: Snapshot[] = [];
  const failed: Array<{ id: string; code: string; message: string }> = [];
  const now = new Date();

  for (const id of ids) {
    const item = byId.get(id);
    if (!item) { failed.push({ id, code: "NOT_FOUND", message: "看不到这一条，或它已被删除" }); continue; }
    try {
      const before: Snapshot = { id };
      const patch: Partial<typeof calendarItems.$inferInsert> = { updatedBy: user.id, updatedAt: now };

      if (body.action === "complete" || body.action === "reopen") {
        before.status = item.status;
        // 来自笔记的条目要回写正文，这条路径必须复用单条那套，不能直接 UPDATE status
        await completeCalendarItem(item, user.id, body.action === "complete");
        done.push(before);
        await audit(workspaceId, user.id, body.action === "complete" ? "calendar.task.complete" : "calendar.task.reopen", id, { batch });
        continue;
      }

      if (body.action === "trash" || body.action === "restore") {
        before.trashed = !!item.trashedAt;
        patch.trashedAt = body.action === "trash" ? now : null;
      } else if (body.action === "shift" || body.action === "setDue") {
        if (item.source === "note") throw fail("VALIDATION", "这条来自笔记，请到原文改期");
        before.dueAt = iso(item.dueAt); before.startsAt = iso(item.startsAt); before.endsAt = iso(item.endsAt);
        if (body.action === "setDue") {
          const target = date(body.dueAt);
          patch.dueAt = target;
          // 只挪日程的起止，不动时长；清掉期限时整条落回收件箱
          if (item.startsAt) patch.startsAt = target;
          if (item.startsAt && item.endsAt && target) patch.endsAt = new Date(target.getTime() + (item.endsAt.getTime() - item.startsAt.getTime()));
          else if (!target) patch.endsAt = null;
        } else {
          const ms = body.days! * 86400_000;
          if (item.dueAt) patch.dueAt = new Date(item.dueAt.getTime() + ms);
          if (item.startsAt) patch.startsAt = new Date(item.startsAt.getTime() + ms);
          if (item.endsAt) patch.endsAt = new Date(item.endsAt.getTime() + ms);
        }
      } else if (body.action === "assign") {
        before.assigneeUserId = item.assigneeUserId;
        patch.assigneeUserId = body.assigneeUserId ?? null;
      } else if (body.action === "priority") {
        before.priority = item.priority;
        patch.priority = body.priority ?? 0;
      } else {
        const snap = snapshotById.get(id);
        if (!snap) throw fail("VALIDATION", "这一条没有快照");
        before.status = item.status; before.trashed = !!item.trashedAt;
        before.dueAt = iso(item.dueAt); before.startsAt = iso(item.startsAt); before.endsAt = iso(item.endsAt);
        before.assigneeUserId = item.assigneeUserId; before.priority = item.priority;
        if (snap.status !== undefined && snap.status !== item.status) await completeCalendarItem(item, user.id, snap.status === "done");
        if (snap.dueAt !== undefined) patch.dueAt = date(snap.dueAt);
        if (snap.startsAt !== undefined) patch.startsAt = date(snap.startsAt);
        if (snap.endsAt !== undefined) patch.endsAt = date(snap.endsAt);
        if (snap.assigneeUserId !== undefined) patch.assigneeUserId = snap.assigneeUserId ?? null;
        if (snap.priority !== undefined) patch.priority = snap.priority;
        if (snap.trashed !== undefined) patch.trashedAt = snap.trashed ? (item.trashedAt ?? now) : null;
      }

      await db.update(calendarItems).set(patch).where(eq(calendarItems.id, id));
      await rescheduleReminders(id);
      done.push(before);
      await audit(workspaceId, user.id, `calendar.batch.${body.action}`, id, { batch });
    } catch (e) {
      // 一条炸了不能带走整批：记下来继续跑下一条
      failed.push({ id, code: e instanceof AppError ? e.code : "VALIDATION", message: e instanceof Error ? e.message : "处理失败" });
    }
  }
  return ok(c, { batch, changed: done.length, snapshot: done, failed });
});

// ── 模板（设计 16 §3.12）────────────────────────────────────────────────

const MAX_TEMPLATES = 50;

const templateItem = z.object({
  kind: z.enum(["task", "event"]).default("task"),
  title: z.string().min(1).max(200),
  bodyMd: z.string().max(2000).default(""),
  allDay: z.boolean().default(false),
  offsetDays: z.number().int().min(0).max(365).default(0),
  /** 当地零点起的分钟数。null = 不定时刻（全天条目，或只有期限没有时刻的任务）。 */
  startMin: z.number().int().min(0).max(1439).nullish(),
  durationMin: z.number().int().min(0).max(1440).nullish(),
  priority: z.number().int().min(0).max(3).default(0),
  reminders: z.array(z.number().int().min(-40320).max(0)).max(5).default([]),
});

function templateDto(row: typeof calendarTemplates.$inferSelect, mine: boolean) {
  const items = (row.items as TemplateItem[]) ?? [];
  return { id: row.id, name: row.name, description: row.description, scope: row.scope, itemCount: items.length, items, createdBy: row.createdBy, mine, updatedAt: row.updatedAt };
}

async function loadTemplate(c: Parameters<typeof currentUser>[0], id: string, mode: "read" | "edit") {
  const user = await requireUser(c);
  const [row] = await db.select().from(calendarTemplates).where(eq(calendarTemplates.id, id));
  if (!row) throw fail("NOT_FOUND", "模板不存在");
  const role = await memberRole(row.workspaceId, user.id);
  if (!role) throw fail("NOT_FOUND", "模板不存在");
  if (row.scope === "private" && row.createdBy !== user.id) throw fail("NOT_FOUND", "模板不存在");
  if (mode === "edit" && role === "viewer") throw fail("FORBIDDEN", "只读成员不能改模板");
  // 工作区模板是公共资产，改它得是管理员；自己的私有模板自己随便改
  if (mode === "edit" && row.scope === "workspace" && role !== "owner" && role !== "admin") throw fail("FORBIDDEN", "只有管理员能改工作区模板");
  return { user, role, row };
}

calendarRoutes.get("/workspaces/:id/calendar/templates", async c => {
  const workspaceId = c.req.param("id");
  const { user } = await workspaceContext(c, workspaceId);
  const rows = await db.select().from(calendarTemplates).where(eq(calendarTemplates.workspaceId, workspaceId)).orderBy(desc(calendarTemplates.updatedAt));
  const visible = rows.filter(r => r.scope === "workspace" || r.createdBy === user.id);
  return ok(c, { templates: visible.map(r => templateDto(r, r.createdBy === user.id)), max: MAX_TEMPLATES });
});

/**
 * 建模板：要么直接给条目，要么给一组现有条目 id 由服务端折算成相对结构。
 * 存绝对日期的模板只能用一次，所以这里一律折算。
 */
calendarRoutes.post("/workspaces/:id/calendar/templates", async c => {
  const workspaceId = c.req.param("id");
  const { user, role, ws } = await workspaceContext(c, workspaceId);
  if (role === "viewer") throw fail("FORBIDDEN", "只读成员不能建模板");
  if (ws.frozen) throw fail("FORBIDDEN", "工作区已冻结，暂时只读");
  const body = z.object({
    name: z.string().min(1).max(80),
    description: z.string().max(300).nullish(),
    scope: z.enum(["workspace", "private"]).default("private"),
    items: z.array(templateItem).max(MAX_TEMPLATE_ITEMS).optional(),
    fromItemIds: z.array(z.string().uuid()).max(MAX_TEMPLATE_ITEMS).optional(),
  }).parse(await c.req.json());
  if (body.scope === "workspace" && role !== "owner" && role !== "admin") throw fail("FORBIDDEN", "只有管理员能建工作区模板");
  const [total] = await db.select({ n: count() }).from(calendarTemplates).where(eq(calendarTemplates.workspaceId, workspaceId));
  if ((total?.n ?? 0) >= MAX_TEMPLATES) throw fail("QUOTA", `模板最多 ${MAX_TEMPLATES} 个，请先清理`);

  let items = body.items ?? [];
  if (body.fromItemIds?.length) {
    const rows = await db.select().from(calendarItems).where(and(eq(calendarItems.workspaceId, workspaceId), inArray(calendarItems.id, body.fromItemIds), isNull(calendarItems.trashedAt)));
    const { kept } = await readableItems(workspaceId, user.id, role, rows);
    items = itemsToTemplate(kept);
  }
  if (!items.length) throw fail("VALIDATION", "模板至少要有一条内容");
  const [row] = await db.insert(calendarTemplates).values({
    workspaceId, name: body.name.trim(), description: body.description ?? null,
    scope: body.scope, items, createdBy: user.id,
  }).returning();
  await audit(workspaceId, user.id, "calendar.template.create", row.id, { name: row.name, count: items.length }, "calendar_template");
  return ok(c, templateDto(row, true), 201);
});

calendarRoutes.patch("/calendar/templates/:tid", async c => {
  const { user, role, row } = await loadTemplate(c, c.req.param("tid"), "edit");
  const body = z.object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(300).nullish(),
    scope: z.enum(["workspace", "private"]).optional(),
    items: z.array(templateItem).max(MAX_TEMPLATE_ITEMS).optional(),
  }).parse(await c.req.json());
  if (body.items && !body.items.length) throw fail("VALIDATION", "模板至少要有一条内容");
  // 把私有模板升成工作区模板，等于往公共区放东西，同样是管理员的事
  if (body.scope === "workspace" && row.scope !== "workspace" && role !== "owner" && role !== "admin") throw fail("FORBIDDEN", "只有管理员能把模板放到工作区");
  const [saved] = await db.update(calendarTemplates).set({
    ...(body.name !== undefined ? { name: body.name.trim() } : {}),
    ...(body.description !== undefined ? { description: body.description ?? null } : {}),
    ...(body.scope !== undefined ? { scope: body.scope } : {}),
    ...(body.items !== undefined ? { items: body.items } : {}),
    updatedAt: new Date(),
  }).where(eq(calendarTemplates.id, row.id)).returning();
  await audit(row.workspaceId, user.id, "calendar.template.update", row.id, { name: saved.name }, "calendar_template");
  return ok(c, templateDto(saved, saved.createdBy === user.id));
});

calendarRoutes.delete("/calendar/templates/:tid", async c => {
  const { user, row } = await loadTemplate(c, c.req.param("tid"), "edit");
  await db.delete(calendarTemplates).where(eq(calendarTemplates.id, row.id));
  await audit(row.workspaceId, user.id, "calendar.template.delete", row.id, { name: row.name }, "calendar_template");
  return ok(c, {});
});

/**
 * 套用到某一天。preview=true 只算不写，让人先看清要落几条、分别落在哪天。
 * 落地的条目 source=manual，跟模板此后无关联——模板改了不追溯已排好的日程。
 */
calendarRoutes.post("/calendar/templates/:tid/apply", async c => {
  const { user, role, row } = await loadTemplate(c, c.req.param("tid"), "read");
  const body = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timezone: z.string().max(64).optional(),
    preview: z.boolean().default(false),
  }).parse(await c.req.json());
  const tz = body.timezone ?? DEFAULT_TZ;
  const items = (row.items as TemplateItem[]) ?? [];

  const planned = planTemplate(items, body.date, tz);

  if (body.preview) {
    return ok(c, {
      date: body.date, timezone: tz,
      items: planned.map(({ item: t, base, start, end }) => ({
        kind: t.kind, title: t.title, allDay: t.allDay, priority: t.priority,
        day: localDayKey(base, tz),
        startsAt: iso(t.kind === "event" ? (start ?? base) : null),
        endsAt: iso(t.kind === "event" ? end : null),
        dueAt: iso(start ?? base),
      })),
    });
  }

  if (role === "viewer") throw fail("FORBIDDEN", "只读成员不能套用模板");
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId));
  if (ws?.frozen) throw fail("FORBIDDEN", "工作区已冻结，暂时只读");
  const [total] = await db.select({ n: count() }).from(calendarItems).where(eq(calendarItems.workspaceId, row.workspaceId));
  if ((total?.n ?? 0) + items.length > MAX_ITEMS_PER_WORKSPACE) throw fail("QUOTA", "日历项已达上限，请先清理");

  const created: Array<typeof calendarItems.$inferSelect> = [];
  for (const { item: t, base, start, end } of planned) {
    const [made] = await db.insert(calendarItems).values({
      workspaceId: row.workspaceId, kind: t.kind, title: t.title, bodyMd: t.bodyMd, allDay: t.allDay,
      startsAt: t.kind === "event" ? (start ?? base) : null,
      endsAt: t.kind === "event" ? end : null,
      dueAt: start ?? base,
      timezone: tz, priority: t.priority, source: "manual", createdBy: user.id, updatedBy: user.id,
    }).returning();
    if (t.reminders.length) {
      await db.insert(calendarReminders).values(t.reminders.map(offsetMin => ({ itemId: made.id, kind: "relative", offsetMin, channel: "inapp" })));
      await rescheduleReminders(made.id);
    }
    created.push(made);
  }
  await audit(row.workspaceId, user.id, "calendar.template.apply", row.id, { date: body.date, count: created.length }, "calendar_template");
  return ok(c, { date: body.date, items: created.map(r => itemDto(r)) }, 201);
});
