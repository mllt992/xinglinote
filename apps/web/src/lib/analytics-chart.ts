import type { AnalyticsDay } from "@kb/shared";

/** SVG 只画最多 30 天；有限数兜底，空/全零数据不产生 NaN 或虚假坡度。 */
export function trendGeometry(days: AnalyticsDay[], width = 600, height = 180) {
  const value = (n: number) => Number.isFinite(n) ? Math.max(0, n) : 0;
  const peak = Math.max(1, ...days.flatMap(d => [value(d.created), value(d.edited), value(d.versions)]));
  const ceiling = Math.max(4, Math.ceil(peak / 4) * 4);
  const x = (i: number) => 8 + i * (width - 16) / Math.max(1, days.length - 1);
  const y = (n: number) => height - 8 - value(n) / ceiling * (height - 20);
  const path = (key: "created" | "edited" | "versions") => days.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(d[key]).toFixed(2)}`).join(" ");
  return { ceiling, x, y, created: path("created"), edited: path("edited"), versions: path("versions") };
}

export function analyticsPercent(part: number, total: number) {
  return total > 0 ? Math.max(0, Math.min(100, Math.round(part / total * 100))) : 0;
}
