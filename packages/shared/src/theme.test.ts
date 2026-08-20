import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTheme, validateManifest, type ThemeManifest } from "./theme.ts";

const tokens = {
  bg: "#ffffff", "bg-subtle": "#fafafa", "bg-muted": "#f0f0f0",
  fg: "#111111", "fg-muted": "#555555", border: "#dddddd",
  accent: "#3b5bdb", good: "#2f9e44", danger: "#e03131", warning: "#f08c00",
  radius: "8px", "font-ui": "Inter, sans-serif", "font-mono": "monospace", "font-title": "Inter, sans-serif",
};
const manifest = () => ({
  id: "test-theme", name: "测试主题", version: "1.0.0",
  modes: ["light", "dark"],
  tokens: { light: { ...tokens }, dark: { ...tokens, bg: "#111111", fg: "#ffffff" } },
});

test("一份规规矩矩的主题能过", () => {
  const r = validateManifest(manifest());
  assert.equal(r.ok, true);
});

test("必填 token 缺一个就不行", () => {
  const m = manifest();
  delete (m.tokens.light as Record<string, unknown>).accent;
  const r = validateManifest(m);
  assert.equal(r.ok, false);
});

test("可选 token 填了也得是合法 hex", () => {
  // 这四个以前完全不校验，直接就进 resolveTheme 的 CSS 变量了
  for (const key of ["accent-fg", "accent-soft", "wiki", "wiki-unresolved"]) {
    const m = manifest();
    (m.tokens.light as Record<string, unknown>)[key] = "red; } body { display: none";
    const r = validateManifest(m);
    assert.equal(r.ok, false, `${key} 应当被拒`);
  }
});

test("可选 token 不填仍然可以", () => {
  assert.equal(validateManifest(manifest()).ok, true);
});

test("字体不许带外链", () => {
  const m = manifest();
  m.tokens.light["font-ui"] = "url(https://evil.example/x.woff2)";
  assert.equal(validateManifest(m).ok, false);
});

test("正文对比度不够直接拒", () => {
  const m = manifest();
  m.tokens.light.fg = "#eeeeee";
  assert.equal(validateManifest(m).ok, false);
});

test("resolveTheme 按外观挑一套 token", () => {
  const r = validateManifest(manifest());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const light = resolveTheme(r.value as ThemeManifest, "light", false);
  const dark = resolveTheme(r.value as ThemeManifest, "dark", false);
  assert.equal(light.vars["--bg"], "#ffffff");
  assert.equal(dark.vars["--bg"], "#111111");
  assert.equal(light.mode, "light");
});

test("用户自定义 accent 会覆盖主题的，并重算前景色", () => {
  const r = validateManifest(manifest());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const t = resolveTheme(r.value as ThemeManifest, "light", false, "#ffee00");
  assert.equal(t.vars["--accent"], "#ffee00");
  assert.equal(t.vars["--accent-fg"], "#0a0a0a", "亮色 accent 上必须配深色前景");
});
