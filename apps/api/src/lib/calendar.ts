import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { backgroundJobs, calendarItems, calendarOverrides, calendarReminders, notebooks, notes, noteVersions, users, workspaceMembers } from "../db/schema.ts";
import { writeNoteFile } from "./files.ts";

/** 没有工作区级时区设置之前的兜底。改这里等于改新条目的默认时区。 */
export const DEFAULT_TZ = process.env.KB_DEFAULT_TZ ?? "Asia/Shanghai";

// ── 时区：全部时刻存 UTC，展开重复必须按当地墙钟走，否则跨夏令时会漂 ──────────

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(tz, f);
  }
  return f;
}

export function wallParts(date: Date, tz: string) {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(date)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { y: p.year, m: p.month, d: p.day, hh: p.hour === 24 ? 0 : p.hour, mm: p.minute, ss: p.second ?? 0 };
}

function offsetMs(date: Date, tz: string) {
  const w = wallParts(date, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss) - date.getTime();
}

/** 当地墙钟 → 真实时刻。二次收敛处理夏令时切换那一小时。 */
export function wallToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const once = new Date(guess - offsetMs(new Date(guess), tz));
  return new Date(guess - offsetMs(once, tz));
}

/** 当地日历日的 00:00，全天条目按这个判归属，不按 UTC 日切。 */
export function startOfLocalDay(date: Date, tz: string) {
  const w = wallParts(date, tz);
  return wallToUtc(w.y, w.m, w.d, 0, 0, tz);
}

export function localDayKey(date: Date, tz: string) {
  const w = wallParts(date, tz);
  return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

// ── RRULE 子集（设计 16 §4.4）────────────────────────────────────────────

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
export type Rule = { freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"; interval: number; byDay: number[] | null; byMonthDay: number | null; count: number | null; until: Date | null };

function parseUntil(v: string | undefined): Date | null {
  if (!v) return null;
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)));
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseRrule(raw: string | null | undefined): Rule | null {
  if (!raw) return null;
  const parts = new Map<string, string>();
  for (const seg of raw.replace(/^RRULE:/i, "").split(";")) {
    const [k, v] = seg.split("=");
    if (k && v) parts.set(k.trim().toUpperCase(), v.trim().toUpperCase());
  }
  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const byDay = parts.get("BYDAY")?.split(",").map(d => WEEKDAYS.indexOf(d.slice(-2))).filter(i => i >= 0) ?? null;
  const until = parseUntil(parts.get("UNTIL"));
  return {
    freq,
    interval: Math.max(1, Number(parts.get("INTERVAL") ?? 1) || 1),
    byDay: byDay && byDay.length ? byDay : null,
    byMonthDay: parts.has("BYMONTHDAY") ? Number(parts.get("BYMONTHDAY")) || null : null,
    count: parts.has("COUNT") ? Number(parts.get("COUNT")) || null : null,
    until: until && !Number.isNaN(until.getTime()) ? until : null,
  };
}

/** 中文速记 → RRULE。只认这几种，认不出就当普通文字，不猜。 */
export function shorthandToRrule(text: string): string | null {
  const t = text.trim();
  if (/^FREQ=/i.test(t)) return t.toUpperCase();
  const week = t.match(/^每(?:周|週|星期)([一二三四五六日天])$/);
  if (week) {
    const idx = "一二三四五六".indexOf(week[1]);
    return `FREQ=WEEKLY;BYDAY=${idx >= 0 ? ["MO", "TU", "WE", "TH", "FR", "SA"][idx] : "SU"}`;
  }
  if (/^每(天|日)$/.test(t)) return "FREQ=DAILY";
  if (/^每(周|週|星期)$/.test(t)) return "FREQ=WEEKLY";
  const monthDay = t.match(/^每月(\d{1,2})(?:日|号)$/);
  if (monthDay) return `FREQ=MONTHLY;BYMONTHDAY=${Number(monthDay[1])}`;
  if (/^每月$/.test(t)) return "FREQ=MONTHLY";
  if (/^每年$/.test(t)) return "FREQ=YEARLY";
  return null;
}

const MAX_OCCURRENCES = 500;

/** 把一条重复规则展开成窗口内的实例。base 决定时刻（时:分），规则只决定日期。 */
export function expandRule(base: Date, rule: Rule | null, tz: string, from: Date, to: Date): Date[] {
  if (!rule) return base >= from && base <= to ? [base] : [];
  const w = wallParts(base, tz);
  const out: Date[] = [];
  const hardStop = rule.until && rule.until < to ? rule.until : to;
  let produced = 0;
  const emit = (y: number, m: number, d: number) => {
    if (out.length >= MAX_OCCURRENCES || (rule.count && produced >= rule.count)) return false;
    const inst = wallToUtc(y, m, d, w.hh, w.mm, tz);
    if (inst < base) return true;
    produced++;
    if (inst > hardStop) return false;
    if (inst >= from) out.push(inst);
    return true;
  };

  if (rule.freq === "DAILY") {
    let cursor = Date.UTC(w.y, w.m - 1, w.d);
    for (let i = 0; i < 4000; i++) {
      const c = new Date(cursor);
      if (!emit(c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate())) break;
      cursor += rule.interval * 86400_000;
    }
  } else if (rule.freq === "WEEKLY") {
    const days = rule.byDay ?? [new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay()];
    let weekStart = Date.UTC(w.y, w.m - 1, w.d) - new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay() * 86400_000;
    outer: for (let i = 0; i < 1000; i++) {
      for (const day of [...days].sort((a, b) => a - b)) {
        const c = new Date(weekStart + day * 86400_000);
        if (!emit(c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate())) break outer;
      }
      weekStart += rule.interval * 7 * 86400_000;
    }
  } else if (rule.freq === "MONTHLY") {
    const day = rule.byMonthDay ?? w.d;
    for (let i = 0; i < 600; i++) {
      const y = w.y + Math.floor((w.m - 1 + i * rule.interval) / 12);
      const m = ((w.m - 1 + i * rule.interval) % 12) + 1;
      if (day > new Date(Date.UTC(y, m, 0)).getUTCDate()) continue; // 2月30日之类：跳过，不顺延
      if (!emit(y, m, day)) break;
    }
  } else {
    for (let i = 0; i < 200; i++) if (!emit(w.y + i * rule.interval, w.m, w.d)) break;
  }
  return out;
}

// ── 笔记任务行解析（设计 16 §5.1）─────────────────────────────────────────

export type ParsedTask = {
  anchor: string | null;
  key: string;
  checked: boolean;
  title: string;
  dueAt: Date | null;
  startsAt: Date | null;
  endsAt: Date | null;
  allDay: boolean;
  priority: number;
  rrule: string | null;
  assignee: string | null;
  line: number;
};

const ANCHOR_RE = /\s*\^tk-([0-9a-f]{8})\b/;
const TIME_RE = /@(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?:\s*-\s*(\d{1,2}):(\d{2}))?)?/;
const PRIORITY_RE = /!(高|中|低|high|medium|med|low)/i;
const RRULE_RE = /(?:^|\s)~(?!~)([^\s~]+)/;
const ASSIGN_RE = /(?:^|\s)\+@([a-z][a-z0-9_]{2,31})\b/;
const TASK_RE = /^(\s*)([-*+])\s+\[([ xX])\]\s*(.*)$/;

const PRIORITY_MAP: Record<string, number> = { 高: 3, high: 3, 中: 2, medium: 2, med: 2, 低: 1, low: 1 };

function taskKey(anchor: string | null, title: string) {
  return anchor ?? `h:${createHash("sha1").update(title.normalize("NFKC").trim().toLocaleLowerCase()).digest("hex").slice(0, 16)}`;
}

/** 只认严格语法。自然语言解析只在快速添加输入框做，正文误判的代价太大。 */
export function parseTaskLines(body: string, tz: string): ParsedTask[] {
  const lines = body.split(/\r?\n/);
  const out: ParsedTask[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMark = line.match(/^\s*(```+|~~~+)/);
    if (fenceMark) {
      if (!fence) fence = fenceMark[1][0];
      else if (fenceMark[1][0] === fence) fence = null;
      continue;
    }
    if (fence || /^\s*>/.test(line)) continue;
    const m = line.match(TASK_RE);
    if (!m) continue;
    let text = m[4];
    const anchorMatch = text.match(ANCHOR_RE);
    const anchor = anchorMatch ? `^tk-${anchorMatch[1]}` : null;
    if (anchorMatch) text = text.replace(ANCHOR_RE, "");
    const timeMatch = text.match(TIME_RE);
    let dueAt: Date | null = null, startsAt: Date | null = null, endsAt: Date | null = null, allDay = false;
    if (timeMatch) {
      const [y, mo, d] = [Number(timeMatch[1]), Number(timeMatch[2]), Number(timeMatch[3])];
      if (timeMatch[4]) {
        const start = wallToUtc(y, mo, d, Number(timeMatch[4]), Number(timeMatch[5]), tz);
        if (timeMatch[6]) { startsAt = start; endsAt = wallToUtc(y, mo, d, Number(timeMatch[6]), Number(timeMatch[7]), tz); }
        dueAt = start;
      } else {
        allDay = true;
        dueAt = wallToUtc(y, mo, d, 0, 0, tz);
      }
      text = text.replace(TIME_RE, "");
    }
    const prio = text.match(PRIORITY_RE);
    if (prio) text = text.replace(PRIORITY_RE, "");
    const rruleMatch = text.match(RRULE_RE);
    const rrule = rruleMatch ? shorthandToRrule(rruleMatch[1]) : null;
    if (rruleMatch && rrule) text = text.replace(RRULE_RE, "");
    const assign = text.match(ASSIGN_RE);
    if (assign) text = text.replace(ASSIGN_RE, "");
    const title = text.replace(/\s+/g, " ").trim();
    if (!title) continue;
    out.push({
      anchor, key: taskKey(anchor, title), checked: m[3].toLowerCase() === "x", title,
      dueAt, startsAt, endsAt, allDay,
      priority: prio ? PRIORITY_MAP[prio[1].toLowerCase()] ?? 0 : 0,
      rrule, assignee: assign?.[1] ?? null, line: i,
    });
  }
  return out;
}

export function newAnchor() {
  return `^tk-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/** 给缺锚的任务行补锚。返回 null 表示无需改写。 */
export function writeAnchors(body: string, tasks: ParsedTask[]): string | null {
  const missing = tasks.filter(t => !t.anchor);
  if (!missing.length) return null;
  const lines = body.split(/\r?\n/);
  for (const t of missing) {
    const anchor = newAnchor();
    lines[t.line] = `${lines[t.line].replace(/\s+$/, "")} ${anchor}`;
    t.anchor = anchor;
    t.key = anchor;
  }
  return lines.join("\n");
}

/** 勾选回写。找不到目标行返回 null，调用方据此把条目标 detached。 */
export function toggleTaskLine(body: string, key: string, done: boolean): string | null {
  const lines = body.split(/\r?\n/);
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const fenceMark = lines[i].match(/^\s*(```+|~~~+)/);
    if (fenceMark) { if (!fence) fence = fenceMark[1][0]; else if (fenceMark[1][0] === fence) fence = null; continue; }
    if (fence) continue;
    const m = lines[i].match(TASK_RE);
    if (!m) continue;
    const anchorMatch = m[4].match(ANCHOR_RE);
    const anchor = anchorMatch ? `^tk-${anchorMatch[1]}` : null;
    const bare = m[4].replace(ANCHOR_RE, "").replace(TIME_RE, "").replace(PRIORITY_RE, "").replace(RRULE_RE, "").replace(ASSIGN_RE, "").replace(/\s+/g, " ").trim();
    if (taskKey(anchor, bare) !== key) continue;
    if ((m[3].toLowerCase() === "x") === done) return body;
    lines[i] = `${m[1]}${m[2]} [${done ? "x" : " "}] ${m[4]}`;
    return lines.join("\n");
  }
  return null;
}

// ── 差量同步：新增插入、消失标 detached、内容变更更新，绝不整表删重建 ──────────

export async function syncNoteTasks(noteId: string) {
  const [note] = await db.select().from(notes).where(eq(notes.id, noteId));
  if (!note) return { added: 0, updated: 0, detached: 0 };
  const [notebook] = await db.select().from(notebooks).where(eq(notebooks.id, note.notebookId));
  const tz = DEFAULT_TZ;
  const tasks = parseTaskLines(note.bodyMd, tz);

  if (notebook?.taskAnchors !== false) {
    const rewritten = writeAnchors(note.bodyMd, tasks);
    if (rewritten) {
      // 补锚是系统标注，不算用户编辑：不升 version、不写 note_versions。
      // 带 version 条件，正文在解析期间被改过就跳过，下一轮再补。
      const [saved] = await db.update(notes).set({ bodyMd: rewritten }).where(and(eq(notes.id, note.id), eq(notes.version, note.version))).returning();
      if (saved) await writeNoteFile({ ...saved, noteId: saved.id });
      else return { added: 0, updated: 0, detached: 0 };
    }
  }

  // +@handle 只在本工作区成员里解析；认不出就当没写，不建幽灵指派
  const handles = [...new Set(tasks.map(t => t.assignee).filter((h): h is string => !!h))];
  const assignees = new Map<string, string>();
  if (handles.length) {
    const rows = await db.select({ id: users.id, handle: users.handle, role: workspaceMembers.role })
      .from(users)
      .innerJoin(workspaceMembers, and(eq(workspaceMembers.userId, users.id), eq(workspaceMembers.workspaceId, note.workspaceId)))
      .where(inArray(users.handle, handles));
    for (const r of rows) assignees.set(r.handle, r.id);
  }

  const existing = await db.select().from(calendarItems).where(and(eq(calendarItems.sourceNoteId, note.id), eq(calendarItems.source, "note")));
  const byKey = new Map(existing.map(e => [e.sourceAnchor ?? `h:${createHash("sha1").update(e.title.normalize("NFKC").trim().toLocaleLowerCase()).digest("hex").slice(0, 16)}`, e]));
  const seen = new Set<string>();
  let added = 0, updated = 0, detached = 0;

  for (const t of tasks) {
    seen.add(t.key);
    const row = byKey.get(t.key);
    const values = {
      title: t.title,
      kind: t.startsAt ? "event" : "task",
      allDay: t.allDay,
      startsAt: t.startsAt,
      endsAt: t.endsAt,
      dueAt: t.dueAt,
      priority: t.priority,
      rrule: t.rrule,
      notebookId: note.notebookId,
      assigneeUserId: t.assignee ? assignees.get(t.assignee) ?? null : null,
      linkState: "linked",
      updatedAt: new Date(),
    };
    if (!row) {
      await db.insert(calendarItems).values({
        ...values, workspaceId: note.workspaceId, timezone: tz, source: "note", sourceNoteId: note.id,
        sourceAnchor: t.anchor, status: t.checked ? "done" : "open", doneAt: t.checked ? new Date() : null,
        createdBy: note.updatedBy, updatedBy: note.updatedBy,
      });
      added++;
    } else {
      const statusChanged = (row.status === "done") !== t.checked;
      await db.update(calendarItems).set({
        ...values, updatedBy: note.updatedBy,
        ...(statusChanged ? { status: t.checked ? "done" : "open", doneAt: t.checked ? new Date() : null, doneBy: t.checked ? note.updatedBy : null } : {}),
      }).where(eq(calendarItems.id, row.id));
      updated++;
    }
  }

  for (const [key, row] of byKey) {
    if (seen.has(key) || row.linkState === "detached") continue;
    await db.update(calendarItems).set({ linkState: "detached", updatedAt: new Date() }).where(eq(calendarItems.id, row.id));
    detached++;
  }
  return { added, updated, detached };
}

// ── 展开窗口内的实例，供列表接口用 ────────────────────────────────────────

export type Occurrence = {
  item: typeof calendarItems.$inferSelect;
  occurrenceStart: Date;
  start: Date;
  end: Date | null;
  status: string;
  recurring: boolean;
};

export function occurrencesOf(item: typeof calendarItems.$inferSelect, overrides: Array<typeof calendarOverrides.$inferSelect>, from: Date, to: Date): Occurrence[] {
  const base = item.startsAt ?? item.dueAt;
  if (!base) return [];
  const rule = parseRrule(item.rrule);
  const duration = item.startsAt && item.endsAt ? item.endsAt.getTime() - item.startsAt.getTime() : 0;
  const byStart = new Map(overrides.map(o => [o.occurrenceStart.getTime(), o]));
  const out: Occurrence[] = [];
  // rrule_until 是列上的截断，「此后全部」靠它把原序列停在分裂点之前。
  // RRULE 文本里的 UNTIL 由 parseRrule 管，两者都要生效，取更早的那个。
  const stop = rule && item.rruleUntil && item.rruleUntil < to ? item.rruleUntil : to;
  for (const inst of expandRule(base, rule, item.timezone, from, stop)) {
    const ov = byStart.get(inst.getTime());
    if (ov?.action === "cancelled") continue;
    const start = ov?.action === "moved" && ov.newStart ? ov.newStart : inst;
    out.push({
      item,
      occurrenceStart: inst,
      start,
      end: ov?.newEnd ?? (duration ? new Date(start.getTime() + duration) : null),
      status: ov?.action === "done" ? "done" : item.status,
      recurring: !!rule,
    });
  }
  return out;
}

export function nextOccurrence(item: typeof calendarItems.$inferSelect, after = new Date()): Date | null {
  const base = item.startsAt ?? item.dueAt;
  if (!base) return null;
  const rule = parseRrule(item.rrule);
  if (!rule) return base;
  // 已被「此后全部」截断的序列不该再排提醒，所以这里也认 rrule_until
  const horizon = new Date(after.getTime() + 400 * 86400_000);
  const stop = item.rruleUntil && item.rruleUntil < horizon ? item.rruleUntil : horizon;
  if (stop < after) return null;
  return expandRule(base, rule, item.timezone, after, stop)[0] ?? null;
}

/** 条目改期或完成后重排提醒。重复条目只排「下一个未来实例」，不预生成整条序列。 */
export function reminderFireAt(item: typeof calendarItems.$inferSelect, reminder: typeof calendarReminders.$inferSelect, occurrenceStart?: Date) {
  if (reminder.kind === "absolute") return reminder.absoluteAt;
  const base = occurrenceStart ?? item.startsAt ?? item.dueAt;
  if (!base) return null;
  if (item.allDay) {
    const day = startOfLocalDay(base, item.timezone);
    return new Date(day.getTime() + 9 * 3600_000 + reminder.offsetMin * 60_000);
  }
  return new Date(base.getTime() + reminder.offsetMin * 60_000);
}

/**
 * 重排一条日历项的提醒 job。条目完成/取消/删除后未触发的提醒置 skipped。
 * 只为「下一个未来实例」排一条，触发后由 worker 再排下一条——否则「每天 9 点」会往 jobs 表灌几千行。
 */
export async function rescheduleReminders(itemId: string) {
  const [item] = await db.select().from(calendarItems).where(eq(calendarItems.id, itemId));
  if (!item) return;
  await db.delete(backgroundJobs).where(and(eq(backgroundJobs.type, "calendar_reminder"), eq(backgroundJobs.status, "pending"), sql`payload->>'itemId' = ${itemId}`));
  const reminders = await db.select().from(calendarReminders).where(eq(calendarReminders.itemId, itemId));
  if (item.trashedAt || item.status !== "open") {
    for (const r of reminders) if (r.status !== "fired") await db.update(calendarReminders).set({ status: "skipped" }).where(eq(calendarReminders.id, r.id));
    return;
  }
  const occurrence = nextOccurrence(item);
  for (const r of reminders) {
    const at = reminderFireAt(item, r, occurrence ?? undefined);
    // 停机错过的只补发 2 小时内的，更早的直接跳过（设计 16 §4.5）
    if (!at || at.getTime() < Date.now() - 2 * 3600_000) {
      if (r.status !== "fired") await db.update(calendarReminders).set({ status: "skipped" }).where(eq(calendarReminders.id, r.id));
      continue;
    }
    await db.insert(backgroundJobs).values({ type: "calendar_reminder", payload: { itemId, reminderId: r.id, occurrenceStart: occurrence?.toISOString() ?? null }, runAfter: at });
    await db.update(calendarReminders).set({ status: "scheduled", firedAt: null }).where(eq(calendarReminders.id, r.id));
  }
}

/** 勾选历史合并：同篇同人 5 分钟内的连续勾选复用同一条版本记录（设计 16 §4.3）。 */
export function mergeableTaskVersion(rows: Array<{ id: string; version: number; source: string; editorId: string; createdAt: Date }>, editorId: string, currentVersion: number) {
  const last = rows.find(r => r.version === currentVersion);
  if (!last || last.source !== "task_toggle" || last.editorId !== editorId) return null;
  return Date.now() - last.createdAt.getTime() < 5 * 60_000 ? last.id : null;
}

/**
 * 勾选一条日历项（设计 16 §5.3）。REST 与 MCP 共用这一份：
 * 回写笔记、版本合并、脱锚判定只允许有一套实现，否则两条路迟早会给出不同结果。
 * 权限由调用方先判完，这里只管写。
 */
export async function completeCalendarItem(item: typeof calendarItems.$inferSelect, actorId: string, done: boolean, occurrenceStart?: Date, source: "ui" | "mcp" = "ui") {
  // 重复条目：只在 overrides 上记这一次，不动本体，否则整条序列都被标完成
  if (item.rrule && occurrenceStart) {
    const [existing] = await db.select().from(calendarOverrides).where(and(eq(calendarOverrides.itemId, item.id), eq(calendarOverrides.occurrenceStart, occurrenceStart)));
    if (done) {
      if (existing) await db.update(calendarOverrides).set({ action: "done", doneAt: new Date(), doneBy: actorId }).where(eq(calendarOverrides.id, existing.id));
      else await db.insert(calendarOverrides).values({ itemId: item.id, occurrenceStart, action: "done", doneAt: new Date(), doneBy: actorId });
    } else if (existing?.action === "done") {
      await db.delete(calendarOverrides).where(eq(calendarOverrides.id, existing.id));
    }
    return { status: done ? "done" : "open", occurrenceStart, noteWritten: false, detached: false, noteId: item.sourceNoteId };
  }

  const [saved] = await db.update(calendarItems).set({
    status: done ? "done" : "open",
    doneAt: done ? new Date() : null,
    doneBy: done ? actorId : null,
    updatedBy: actorId, updatedAt: new Date(),
  }).where(eq(calendarItems.id, item.id)).returning();
  await rescheduleReminders(saved.id);

  let noteWritten = false;
  let detached = false;
  if (item.source === "note" && item.sourceNoteId) {
    const [note] = await db.select().from(notes).where(eq(notes.id, item.sourceNoteId));
    const key = item.sourceAnchor ?? null;
    const nextBody = note && key ? toggleTaskLine(note.bodyMd, key, done) : null;
    if (!note || nextBody === null) {
      // 锚丢了：条目状态照记，但明确标出已脱离原文，不静默消失
      await db.update(calendarItems).set({ linkState: "detached" }).where(eq(calendarItems.id, item.id));
      detached = true;
    } else if (nextBody !== note.bodyMd) {
      const version = note.version + 1;
      const [written] = await db.update(notes).set({ bodyMd: nextBody, version, updatedBy: actorId, updatedAt: new Date() }).where(and(eq(notes.id, note.id), eq(notes.version, note.version))).returning();
      if (written) {
        const history = await db.select().from(noteVersions).where(eq(noteVersions.noteId, note.id)).orderBy(desc(noteVersions.version)).limit(3);
        const mergeInto = mergeableTaskVersion(history, actorId, note.version);
        // 5 分钟内的连续勾选合并成一条历史，否则版本列表会被待办淹掉（设计 16 §4.3）
        if (mergeInto) await db.update(noteVersions).set({ version, bodyMd: written.bodyMd, title: written.title, createdAt: new Date() }).where(eq(noteVersions.id, mergeInto));
        else await db.insert(noteVersions).values({ noteId: note.id, version, title: written.title, bodyMd: written.bodyMd, editorId: actorId, source: source === "mcp" ? "mcp" : "task_toggle" });
        await writeNoteFile({ ...written, noteId: written.id });
        // 回写不触发 note.rewrite_links（防环）。向量由 notes 触发器排队，已有索引的篇会再等 5 分钟。
        noteWritten = true;
      }
    } else noteWritten = true;
  }
  return { status: saved.status, occurrenceStart: null, noteWritten, detached, noteId: item.sourceNoteId };
}
