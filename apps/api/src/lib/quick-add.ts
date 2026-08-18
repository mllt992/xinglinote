import { wallParts, wallToUtc } from "./calendar.ts";

/**
 * 快速添加输入框的自然语言解析（设计 16 §3.4）。
 * 只在这里做，**不用于笔记正文** —— 正文误判一次待办就毁掉信任。
 * 解析结果以芯片回显给用户确认，因此宁可少认，也不要猜。
 */
export type QuickAdd = {
  title: string;
  startsAt: Date | null;
  endsAt: Date | null;
  dueAt: Date | null;
  allDay: boolean;
  priority: number;
  rrule: string | null;
  /** 命中的原文片段，前端据此渲染芯片并允许逐个撤掉。 */
  chips: Array<{ kind: "date" | "time" | "duration" | "priority" | "repeat"; text: string }>;
};

const CN_NUM: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function cnNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  if (s.length === 1) return CN_NUM[s] ?? null;
  if (s === "十") return 10;
  const m = s.match(/^(十)(.)$/);
  if (m) return 10 + (CN_NUM[m[2]] ?? 0);
  const m2 = s.match(/^(.)十(.)?$/);
  if (m2) return (CN_NUM[m2[1]] ?? 0) * 10 + (m2[2] ? CN_NUM[m2[2]] ?? 0 : 0);
  return null;
}

const WEEKDAY_CN = "一二三四五六日天";

export function parseQuickAdd(input: string, tz: string, now = new Date()): QuickAdd {
  let text = ` ${input} `;
  const chips: QuickAdd["chips"] = [];
  const today = wallParts(now, tz);
  let y = today.y, mo = today.m, d = today.d;
  let hasDate = false, hasTime = false;
  let hh = 9, mm = 0;
  let durationMin: number | null = null;
  let priority = 0;
  let rrule: string | null = null;

  const eat = (re: RegExp, kind: QuickAdd["chips"][number]["kind"]) => {
    const m = text.match(re);
    if (!m) return null;
    chips.push({ kind, text: m[0].trim() });
    text = text.replace(m[0], " ");
    return m;
  };

  // 重复：先吃掉，免得「每周五」里的「周五」被当成单次日期
  const repeat = eat(new RegExp(`每(?:天|日|周|週|星期|月|年)(?:[${WEEKDAY_CN}])?(?:\\d{1,2}(?:日|号))?`), "repeat");
  if (repeat) {
    const t = repeat[0].trim();
    const wd = t.match(new RegExp(`每(?:周|週|星期)([${WEEKDAY_CN}])`));
    const md = t.match(/每月(\d{1,2})(?:日|号)/);
    if (wd) { const i = "一二三四五六".indexOf(wd[1]); rrule = `FREQ=WEEKLY;BYDAY=${i >= 0 ? ["MO", "TU", "WE", "TH", "FR", "SA"][i] : "SU"}`; }
    else if (md) rrule = `FREQ=MONTHLY;BYMONTHDAY=${Number(md[1])}`;
    else if (/每(天|日)/.test(t)) rrule = "FREQ=DAILY";
    else if (/每(周|週|星期)/.test(t)) rrule = "FREQ=WEEKLY";
    else if (/每月/.test(t)) rrule = "FREQ=MONTHLY";
    else rrule = "FREQ=YEARLY";
    hasDate = true;
  }

  // 绝对日期
  const iso = eat(/(\d{4})-(\d{1,2})-(\d{1,2})/, "date");
  const slash = iso ? null : eat(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/, "date");
  const cnDate = iso || slash ? null : eat(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})(?:日|号)/, "date");
  if (iso) { y = +iso[1]; mo = +iso[2]; d = +iso[3]; hasDate = true; }
  else if (slash) { mo = +slash[1]; d = +slash[2]; hasDate = true; }
  else if (cnDate) { if (cnDate[1]) y = +cnDate[1]; mo = +cnDate[2]; d = +cnDate[3]; hasDate = true; }

  // 相对日期
  if (!hasDate) {
    const rel = eat(/(今天|今日|明天|明日|后天|後天|大后天|昨天)/, "date");
    if (rel) {
      const shift = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 後天: 2, 大后天: 3, 昨天: -1 }[rel[1]] ?? 0;
      const moved = new Date(Date.UTC(y, mo - 1, d) + shift * 86400_000);
      y = moved.getUTCFullYear(); mo = moved.getUTCMonth() + 1; d = moved.getUTCDate();
      hasDate = true;
    }
  }
  if (!hasDate) {
    // 负向后顾挡掉「上周三」「前星期五」：那是在说过去，不是在排期。
    // 认错一次日期比漏认一次代价大得多，所以这里宁可不认。
    const wd = eat(new RegExp(`(?<![上前去])(这|本|下)?(?:周|週|星期)([${WEEKDAY_CN}])`), "date");
    if (wd) {
      const idx = "一二三四五六".indexOf(wd[2]);
      const want = idx >= 0 ? idx + 1 : 0; // 周日 = 0
      const cur = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
      let delta = (want - cur + 7) % 7;
      if (wd[1] === "下") delta += 7;
      const moved = new Date(Date.UTC(y, mo - 1, d) + delta * 86400_000);
      y = moved.getUTCFullYear(); mo = moved.getUTCMonth() + 1; d = moved.getUTCDate();
      hasDate = true;
    }
  }

  // 时刻：HH:MM 或「下午3点半」
  const clock = eat(/(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/, "time");
  if (clock) { hh = +clock[1]; mm = +clock[2]; hasTime = true; }
  else {
    const cn = eat(new RegExp(`(上午|早上|中午|下午|晚上|傍晚)?\\s*([0-9]{1,2}|[${Object.keys(CN_NUM).join("")}]{1,3})\\s*[点時时]\\s*(半|[0-9]{1,2}\\s*分|[${Object.keys(CN_NUM).join("")}]{1,3}\\s*分)?`), "time");
    if (cn) {
      const raw = cnNumber(cn[2].trim());
      if (raw !== null) {
        hh = raw;
        const period = cn[1];
        if ((period === "下午" || period === "晚上" || period === "傍晚") && hh < 12) hh += 12;
        if (period === "中午" && hh < 12) hh = 12;
        if ((period === "上午" || period === "早上") && hh === 12) hh = 0;
        if (!period && hh < 7) hh += 12; // 「3点」默认下午，符合中文口语
        if (cn[3]) mm = cn[3].trim() === "半" ? 30 : cnNumber(cn[3].replace(/\s*分/, "").trim()) ?? 0;
        hasTime = hh <= 23;
      } else chips.pop();
    }
  }

  const dur = eat(/(\d{1,3})\s*(分钟|分|小时|个?小时|h|min)/i, "duration");
  if (dur) durationMin = /分/.test(dur[2]) || /min/i.test(dur[2]) ? +dur[1] : +dur[1] * 60;

  const prio = eat(/!(高|中|低|high|medium|low)/i, "priority");
  if (prio) priority = { 高: 3, high: 3, 中: 2, medium: 2, 低: 1, low: 1 }[prio[1].toLowerCase()] ?? 0;

  const title = text.replace(/\s+/g, " ").trim();
  if (!hasDate && !hasTime) return { title, startsAt: null, endsAt: null, dueAt: null, allDay: false, priority, rrule, chips };

  const at = wallToUtc(y, mo, d, hasTime ? hh : 0, hasTime ? mm : 0, tz);
  return {
    title,
    startsAt: hasTime && durationMin ? at : null,
    endsAt: hasTime && durationMin ? new Date(at.getTime() + durationMin * 60_000) : null,
    dueAt: at,
    allDay: !hasTime,
    priority,
    rrule,
    chips,
  };
}
