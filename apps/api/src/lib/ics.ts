import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { and, eq } from "drizzle-orm";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { calendarItems, calendarSubscriptions, notifications } from "../db/schema.ts";
import { DEFAULT_TZ, wallToUtc, wallParts } from "./calendar.ts";

/**
 * ICS 进出（设计 16 §4.6）。
 * 出：只含标题、时间与指回本实例的链接，绝不含笔记正文。
 * 进：只读，且 URL 必须过 SSRF 校验——订阅地址是用户填的，等于让服务器替人发请求。
 */

// ── 序列化 ────────────────────────────────────────────────────────────────

/** RFC 5545 规定一行最多 75 个八位组，超了要折行并以空格续行。中文一个字符三字节，按字节折。 */
export function foldLine(line: string) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const take = out.length === 0 ? 75 : 74;
    let end = Math.min(cursor + take, bytes.length);
    // 别把一个多字节字符劈成两半：续行字节都是 10xxxxxx，往回退到字符边界
    while (end > cursor && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push((out.length ? " " : "") + bytes.subarray(cursor, end).toString("utf8"));
    cursor = end;
  }
  return out.join("\r\n");
}

export function escapeText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

export function icsUtc(date: Date) {
  return `${date.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
}

export function icsDate(date: Date, tz: string) {
  const w = wallParts(date, tz);
  return `${w.y}${String(w.m).padStart(2, "0")}${String(w.d).padStart(2, "0")}`;
}

export type FeedItem = {
  id: string;
  kind: string;
  title: string;
  allDay: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  dueAt: Date | null;
  timezone: string;
  status: string;
  rrule: string | null;
  updatedAt: Date;
  workspaceId: string;
};

/**
 * 任务也导成 VEVENT 而不是 VTODO：VTODO 在 Google / Outlook 里根本不显示，
 * 导出的意义就是让人在系统日历里看见。用 ☐ / ☑ 前缀把状态写进标题，而不是靠客户端理解。
 */
export function buildIcs(items: FeedItem[], opts: { name: string; publicUrl: string; now?: Date }) {
  const stamp = icsUtc(opts.now ?? new Date());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//星璃笔记//日历导出//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(opts.name)}`,
  ];
  for (const item of items) {
    const start = item.startsAt ?? item.dueAt;
    if (!start) continue;
    const summary = item.kind === "task" ? `${item.status === "done" ? "☑" : "☐"} ${item.title}` : item.title;
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${item.id}@kb`);
    lines.push(`DTSTAMP:${stamp}`);
    if (item.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(start, item.timezone)}`);
      const endDay = item.endsAt ?? new Date(start.getTime() + 86400_000);
      lines.push(`DTEND;VALUE=DATE:${icsDate(endDay, item.timezone)}`);
    } else {
      lines.push(`DTSTART:${icsUtc(start)}`);
      lines.push(`DTEND:${icsUtc(item.endsAt ?? new Date(start.getTime() + 30 * 60_000))}`);
    }
    lines.push(`SUMMARY:${escapeText(summary)}`);
    lines.push(`URL:${opts.publicUrl}/w/${item.workspaceId}/calendar?item=${item.id}`);
    lines.push(`STATUS:${item.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`);
    if (item.rrule) lines.push(`RRULE:${item.rrule.replace(/^RRULE:/i, "")}`);
    lines.push(`LAST-MODIFIED:${icsUtc(item.updatedAt)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

// ── 解析 ──────────────────────────────────────────────────────────────────

export type IcsEvent = { uid: string; summary: string; startsAt: Date; endsAt: Date | null; allDay: boolean; rrule: string | null };

function unescapeText(value: string) {
  return value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

/** 续行是「行首一个空格或制表符」。先合并再切，否则长中文标题会被截断。 */
function unfold(text: string) {
  return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

function parseIcsTime(value: string, params: Map<string, string>, fallbackTz: string): { at: Date; allDay: boolean } | null {
  const dateOnly = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  const tz = params.get("TZID") ?? fallbackTz;
  if (dateOnly) return { at: wallToUtc(+dateOnly[1], +dateOnly[2], +dateOnly[3], 0, 0, tz), allDay: true };
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  // 带 Z 的是绝对时刻；不带的按 TZID（没有就按订阅默认时区）当地墙钟解释
  if (m[7]) return { at: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])), allDay: false };
  return { at: wallToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], tz), allDay: false };
}

export function parseIcs(text: string, fallbackTz: string): IcsEvent[] {
  const out: IcsEvent[] = [];
  let current: Partial<IcsEvent> | null = null;
  for (const line of unfold(text)) {
    const trimmed = line.trim();
    if (trimmed === "BEGIN:VEVENT") { current = {}; continue; }
    if (trimmed === "END:VEVENT") {
      if (current?.uid && current.startsAt) {
        out.push({
          uid: current.uid,
          summary: current.summary || "（无标题）",
          startsAt: current.startsAt,
          endsAt: current.endsAt ?? null,
          allDay: current.allDay ?? false,
          rrule: current.rrule ?? null,
        });
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const sep = trimmed.indexOf(":");
    if (sep < 0) continue;
    const [rawName, ...paramParts] = trimmed.slice(0, sep).split(";");
    const name = rawName.toUpperCase();
    const value = trimmed.slice(sep + 1);
    const params = new Map(paramParts.map(p => {
      const i = p.indexOf("=");
      return [p.slice(0, i).toUpperCase(), p.slice(i + 1).replace(/^"|"$/g, "")] as [string, string];
    }));
    if (name === "UID") current.uid = value;
    else if (name === "SUMMARY") current.summary = unescapeText(value).slice(0, 200);
    else if (name === "RRULE") current.rrule = value.toUpperCase().slice(0, 200);
    else if (name === "DTSTART") {
      const parsed = parseIcsTime(value, params, fallbackTz);
      if (parsed) { current.startsAt = parsed.at; current.allDay = parsed.allDay; }
    } else if (name === "DTEND") {
      const parsed = parseIcsTime(value, params, fallbackTz);
      if (parsed) current.endsAt = parsed.at;
    }
  }
  return out;
}

// ── 抓取：订阅 URL 是用户填的，等于让服务器替人发请求，必须挡住内网 ─────────────

const MAX_ICS_BYTES = 5 * 1024 * 1024;

/** 私有 / 保留网段。命中就拒，不给「解析到内网再跳转」的机会。 */
export function isPrivateAddress(ip: string) {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 168 || b === 0)) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (low === "::" || low === "::1") return true;
    if (/^f[cd]/.test(low)) return true;          // fc00::/7 唯一本地
    if (/^fe[89ab]/.test(low)) return true;       // fe80::/10 链路本地
    return false;
  }
  return true;
}

export async function assertPublicUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw fail("VALIDATION", "订阅地址不合法"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw fail("VALIDATION", "订阅地址只允许 http/https");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw fail("VALIDATION", "订阅地址解析不到主机");
  for (const a of addresses) if (isPrivateAddress(a.address)) throw fail("VALIDATION", "订阅地址指向内网，已拒绝");
  return url;
}

/** 条件请求 + 手动跟随重定向：每一跳都要重新过 SSRF 校验，否则挡了首跳等于没挡。 */
export async function fetchIcs(rawUrl: string, etag: string | null): Promise<{ status: number; body: string | null; etag: string | null }> {
  let target = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicUrl(target);
    const res = await fetch(target, {
      redirect: "manual",
      headers: { accept: "text/calendar,text/plain;q=0.8", "user-agent": "knowledge-calendar/1.0", ...(etag ? { "if-none-match": etag } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 304) return { status: 304, body: null, etag };
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) throw fail("VALIDATION", "订阅地址重定向缺少目标");
      target = new URL(next, target).toString();
      continue;
    }
    if (!res.ok) throw fail("VALIDATION", `订阅地址返回 ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ICS_BYTES) throw fail("QUOTA", "订阅日历超过 5MB");
    return { status: res.status, body: buf.toString("utf8"), etag: res.headers.get("etag") };
  }
  throw fail("VALIDATION", "订阅地址重定向次数过多");
}

// ── 订阅同步 ──────────────────────────────────────────────────────────────

const MAX_SUB_EVENTS = 2000;
const SUB_FAIL_LIMIT = 5;

/**
 * 拉一个外部订阅。UID 存进 sourceAnchor（这一列对 source=note 存块锚，对 source=ics 存 UID）。
 * 解析失败不清空既有数据，只记 last_error——网络抖一下就把用户日历清空是不可接受的。
 */
export async function syncSubscription(subscriptionId: string) {
  const [sub] = await db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.id, subscriptionId));
  if (!sub || !sub.enabled) return { skipped: true, added: 0, updated: 0, removed: 0 };

  let fetched: Awaited<ReturnType<typeof fetchIcs>>;
  try {
    fetched = await fetchIcs(sub.url, sub.etag);
  } catch (e) {
    const failCount = sub.failCount + 1;
    const message = e instanceof Error ? e.message : String(e);
    await db.update(calendarSubscriptions)
      .set({ lastError: message.slice(0, 500), failCount, enabled: failCount < SUB_FAIL_LIMIT, lastSyncAt: new Date() })
      .where(eq(calendarSubscriptions.id, sub.id));
    // 连续失败 5 次自动停用并通知创建者，而不是每 30 分钟静默重试到天荒地老
    if (failCount >= SUB_FAIL_LIMIT) {
      await db.insert(notifications).values({
        userId: sub.createdBy, type: "calendar_subscription_failed",
        title: `日历订阅「${sub.name}」已停用`, body: `连续 ${failCount} 次同步失败：${message.slice(0, 120)}`,
        href: `/w/${sub.workspaceId}/calendar`,
      });
    }
    throw e;
  }

  if (fetched.status === 304 || !fetched.body) {
    await db.update(calendarSubscriptions).set({ lastSyncAt: new Date(), lastError: null, failCount: 0 }).where(eq(calendarSubscriptions.id, sub.id));
    return { skipped: true, added: 0, updated: 0, removed: 0 };
  }

  const events = parseIcs(fetched.body, DEFAULT_TZ).slice(0, MAX_SUB_EVENTS);
  const existing = await db.select().from(calendarItems).where(and(eq(calendarItems.source, "ics"), eq(calendarItems.sourceSubId, sub.id)));
  const byUid = new Map(existing.map(e => [e.sourceAnchor ?? e.id, e]));
  const seen = new Set<string>();
  let added = 0, updated = 0;

  for (const ev of events) {
    seen.add(ev.uid);
    const row = byUid.get(ev.uid);
    const values = {
      title: ev.summary, allDay: ev.allDay, startsAt: ev.startsAt, endsAt: ev.endsAt,
      dueAt: ev.startsAt, rrule: ev.rrule, color: sub.color, updatedAt: new Date(), trashedAt: null,
    };
    if (row) { await db.update(calendarItems).set(values).where(eq(calendarItems.id, row.id)); updated++; }
    else {
      await db.insert(calendarItems).values({
        ...values, workspaceId: sub.workspaceId, kind: "event", timezone: DEFAULT_TZ,
        source: "ics", sourceSubId: sub.id, sourceAnchor: ev.uid,
        createdBy: sub.createdBy, updatedBy: sub.createdBy,
      });
      added++;
    }
  }

  // 对端已消失的 UID 走软删，跟回收站同一套语义
  const gone = existing.filter(e => !seen.has(e.sourceAnchor ?? e.id) && !e.trashedAt);
  for (const e of gone) await db.update(calendarItems).set({ trashedAt: new Date() }).where(eq(calendarItems.id, e.id));

  await db.update(calendarSubscriptions)
    .set({ lastSyncAt: new Date(), lastError: null, failCount: 0, etag: fetched.etag })
    .where(eq(calendarSubscriptions.id, sub.id));
  return { skipped: false, added, updated, removed: gone.length };
}
