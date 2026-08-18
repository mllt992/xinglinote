export const THEME_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
export const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export const RADIUS_RE = /^\d+(\.\d+)?(px|rem)$/;
export const BUILTIN_THEME_ID = "mono-modern";

export const REQUIRED_TOKEN_KEYS = [
  "bg",
  "bg-subtle",
  "bg-muted",
  "fg",
  "fg-muted",
  "border",
  "accent",
  "good",
  "danger",
  "warning",
  "radius",
  "font-ui",
  "font-mono",
  "font-title",
] as const;

export type TokenKey = (typeof REQUIRED_TOKEN_KEYS)[number];
export type ThemeMode = "light" | "dark";

export type ThemeTokens = Record<TokenKey, string> & {
  "accent-fg"?: string;
  "accent-soft"?: string;
  wiki?: string;
  "wiki-unresolved"?: string;
};

export type ThemeManifest = {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  homepage?: string;
  modes: ThemeMode[];
  navActiveStyle?: "solid" | "soft";
  tokens: { light: ThemeTokens; dark: ThemeTokens };
};

export type Appearance = "system" | "light" | "dark";

export function expandHex(hex: string): string {
  const h = hex.toLowerCase();
  if (h.length === 4) {
    return `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  }
  return h;
}

export function relLuminance(hex: string): number {
  const h = expandHex(hex).slice(1);
  const toLin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = toLin(parseInt(h.slice(0, 2), 16));
  const g = toLin(parseInt(h.slice(2, 4), 16));
  const b = toLin(parseInt(h.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const l1 = relLuminance(a);
  const l2 = relLuminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

export function pickAccentFg(accent: string): string {
  return relLuminance(accent) > 0.55 ? "#0a0a0a" : "#fafafa";
}

export function mixHex(a: string, b: string, amountA: number): string {
  const pa = expandHex(a).slice(1);
  const pb = expandHex(b).slice(1);
  const ch = (i: number) => {
    const va = parseInt(pa.slice(i, i + 2), 16);
    const vb = parseInt(pb.slice(i, i + 2), 16);
    return Math.round(va * amountA + vb * (1 - amountA))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${ch(0)}${ch(2)}${ch(4)}`;
}

export type ThemeIssue = { level: "error" | "warn"; message: string };

export function validateManifest(raw: unknown): { ok: true; value: ThemeManifest } | { ok: false; issues: ThemeIssue[] } {
  const issues: ThemeIssue[] = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, issues: [{ level: "error", message: "theme.json 必须是对象" }] };
  }
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string" || !THEME_ID_RE.test(m.id)) {
    issues.push({ level: "error", message: "id 必须是 2–64 位小写字母、数字或短横线，且以字母开头" });
  }
  if (typeof m.name !== "string" || m.name.trim().length < 1 || m.name.length > 40) {
    issues.push({ level: "error", message: "name 必填，最长 40 字" });
  }
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+/.test(m.version)) {
    issues.push({ level: "error", message: "version 必须是 semver，如 1.0.0" });
  }
  const modes = m.modes;
  if (!Array.isArray(modes) || !modes.includes("light") || !modes.includes("dark")) {
    issues.push({ level: "error", message: "modes 必须包含 light 和 dark" });
  }
  const tokens = m.tokens as Record<string, Record<string, string>> | undefined;
  for (const mode of ["light", "dark"] as const) {
    const t = tokens?.[mode];
    if (!t || typeof t !== "object") {
      issues.push({ level: "error", message: `缺少 tokens.${mode}` });
      continue;
    }
    for (const key of REQUIRED_TOKEN_KEYS) {
      const v = t[key];
      if (typeof v !== "string") {
        issues.push({ level: "error", message: `缺少 tokens.${mode}.${key}` });
        continue;
      }
      if (key === "radius") {
        if (!RADIUS_RE.test(v)) issues.push({ level: "error", message: `${mode}.radius 只允许如 8px / 0.5rem` });
      } else if (key.startsWith("font-")) {
        if (v.length < 2 || /url\s*\(/i.test(v)) {
          issues.push({ level: "error", message: `${mode}.${key} 非法或含外链` });
        }
      } else if (!HEX_RE.test(v)) {
        issues.push({ level: "error", message: `${mode}.${key} 必须是 #RGB 或 #RRGGBB` });
      }
    }
    if (t.fg && t.bg && HEX_RE.test(t.fg) && HEX_RE.test(t.bg)) {
      const c = contrastRatio(t.fg, t.bg);
      if (c < 4.5) issues.push({ level: "error", message: `${mode} 正文对比度 ${c.toFixed(2)} < 4.5` });
      else if (c < 7) issues.push({ level: "warn", message: `${mode} 正文对比度 ${c.toFixed(2)}，建议 ≥ 7` });
    }
  }
  if (issues.some((i) => i.level === "error")) return { ok: false, issues };
  return { ok: true, value: m as unknown as ThemeManifest };
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export type ResolvedTheme = {
  id: string;
  name: string;
  mode: ThemeMode;
  navActiveStyle: "solid" | "soft";
  vars: Record<string, string>;
};

export function resolveTheme(
  manifest: ThemeManifest,
  appearance: Appearance,
  systemDark: boolean,
  accentOverride?: string | null,
): ResolvedTheme {
  const mode: ThemeMode = appearance === "system" ? (systemDark ? "dark" : "light") : appearance;
  const t = manifest.tokens[mode];
  const accent = accentOverride && HEX_RE.test(accentOverride) ? expandHex(accentOverride) : t.accent;
  const accentFg = t["accent-fg"] && !accentOverride ? t["accent-fg"] : pickAccentFg(accent);
  const accentSoft = t["accent-soft"] && !accentOverride ? t["accent-soft"] : mixHex(accent, t.bg, 0.12);
  const vars: Record<string, string> = {
    "--bg": t.bg,
    "--bg-subtle": t["bg-subtle"],
    "--bg-muted": t["bg-muted"],
    "--fg": t.fg,
    "--fg-muted": t["fg-muted"],
    "--border": t.border,
    "--accent": accent,
    "--accent-fg": accentFg,
    "--accent-soft": accentSoft,
    "--good": t.good,
    "--danger": t.danger,
    "--warning": t.warning,
    "--wiki": t.wiki ?? accent,
    "--wiki-unresolved": t["wiki-unresolved"] ?? t["fg-muted"],
    "--radius": t.radius,
    "--font-ui": t["font-ui"],
    "--font-mono": t["font-mono"],
    "--font-title": t["font-title"],
  };
  return {
    id: manifest.id,
    name: manifest.name,
    mode,
    navActiveStyle: manifest.navActiveStyle ?? "solid",
    vars,
  };
}
