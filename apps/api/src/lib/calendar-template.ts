/**
 * 日历模板里不碰数据库的那部分（设计 16 §3.12）：
 * 把一组绝对时刻的条目折算成相对偏移，以及把相对偏移摊回某一天。
 * 单独拆出来是为了能对着夏令时、跨天、无期限这些边界写单测。
 */
import { wallParts, wallToUtc } from "./calendar.ts";

export type TemplateItem = {
  kind: "task" | "event";
  title: string;
  bodyMd: string;
  allDay: boolean;
  offsetDays: number;
  /** 当地零点起的分钟数。null = 不定时刻（全天条目，或只有期限没有时刻的任务）。 */
  startMin: number | null;
  durationMin: number | null;
  priority: number;
  reminders: number[];
};

export type SourceItem = {
  kind: string; title: string; bodyMd: string; allDay: boolean;
  startsAt: Date | null; endsAt: Date | null; dueAt: Date | null;
  timezone: string; priority: number;
};

export const MAX_TEMPLATE_ITEMS = 100;

/**
 * 第 0 天 = 选中条目里最早的那个**当地日**，不是最早的那个时刻——
 * 按时刻算的话「周一 09:00 和周一 23:00」会被折成相差一天。
 *
 * 天数与时刻都从当地墙钟读，不拿「时刻 − 当地零点」去算：
 * 夏令时切换那天的一天是 23 或 25 小时，减出来的分钟数会平白差一个小时。
 */
export function itemsToTemplate(rows: SourceItem[]): TemplateItem[] {
  const anchored = rows.flatMap(r => {
    const at = r.startsAt ?? r.dueAt;
    if (!at) return [];
    const w = wallParts(at, r.timezone);
    return [{ r, w, day: Date.UTC(w.y, w.m - 1, w.d) }];
  });
  const undated = rows.filter(r => !r.startsAt && !r.dueAt);
  const day0 = anchored.length ? Math.min(...anchored.map(x => x.day)) : 0;
  const out: TemplateItem[] = anchored.map(({ r, w, day }) => ({
    kind: r.kind === "event" ? "event" : "task",
    title: r.title, bodyMd: r.bodyMd, allDay: r.allDay,
    offsetDays: Math.max(0, (day - day0) / 86400_000),
    startMin: r.allDay ? null : w.hh * 60 + w.mm,
    durationMin: r.startsAt && r.endsAt ? Math.round((r.endsAt.getTime() - r.startsAt.getTime()) / 60_000) : null,
    priority: r.priority, reminders: [],
  }));
  // 收件箱里那些没期限的也收进来，套用后照样没期限
  for (const r of undated) out.push({ kind: "task", title: r.title, bodyMd: r.bodyMd, allDay: false, offsetDays: 0, startMin: null, durationMin: null, priority: r.priority, reminders: [] });
  return out.slice(0, MAX_TEMPLATE_ITEMS);
}

export type Planned = { item: TemplateItem; base: Date; start: Date | null; end: Date | null };

/**
 * 摊回某一天。日期与时刻一起交给 `wallToUtc` 解析成当地墙钟，
 * **不能**先算出当地零点再加分钟数——夏令时切换那天零点还是旧偏移，
 * 加满 9 小时会落在当地 08:00 而不是 09:00。`d + offsetDays` 越界由 `Date.UTC` 归一。
 *
 * 时长仍按真实流逝时间加：一场 60 分钟的会跨过切换点也还是开 60 分钟。
 */
export function planTemplate(items: TemplateItem[], date: string, tz: string): Planned[] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return items.map(item => {
    const day = d + item.offsetDays;
    const base = wallToUtc(y, m, day, 0, 0, tz);
    const start = item.startMin == null ? null : wallToUtc(y, m, day, Math.floor(item.startMin / 60), item.startMin % 60, tz);
    const end = start && item.durationMin ? new Date(start.getTime() + item.durationMin * 60_000) : null;
    return { item, base, start, end };
  });
}
