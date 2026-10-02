export type GanttRange = { from: string; to: string };
type Dates = { startAt: string | null; dueAt: string | null };
const day = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value.slice(0, 10) : new Date(parsed.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
};
export function defaultGanttRange(today: string, days = 15): GanttRange {
  const date = new Date(`${today}T00:00:00Z`);
  const offset = Math.floor((days - 1) / 2);
  return { from: new Date(date.getTime() - offset * 86400_000).toISOString().slice(0, 10), to: new Date(date.getTime() + (days - offset - 1) * 86400_000).toISOString().slice(0, 10) };
}
export function ganttInterval(task: Dates): GanttRange | null {
  if (!task.startAt && !task.dueAt) return null;
  const a = day(task.startAt ?? task.dueAt!);
  const b = day(task.dueAt ?? task.startAt!);
  return { from: a < b ? a : b, to: a < b ? b : a };
}
export function overlapsGanttRange(task: Dates, range: GanttRange): boolean {
  const interval = ganttInterval(task);
  return !!interval && interval.from <= range.to && interval.to >= range.from;
}
