import { useCallback, useEffect, useState } from "react";
import { Check, Paintbrush, Plus } from "lucide-react";
import { api, type Me } from "../api";
import { cn } from "../lib/utils";
import { useThemeRefresh } from "../theme";
import { Field, SectionCard, SettingsShell } from "./settings-shell";
import { Button } from "./ui/button";
import { FormError } from "./ui/form-error";
import { Textarea } from "./ui/textarea";
import { useToast } from "./ui/toast";

type Theme = { id: string; name: string; author?: string };

const MODES = [
  { v: "system", label: "跟随系统", desc: "白天浅色，夜里深色" },
  { v: "light", label: "浅色", desc: "始终用浅色" },
  { v: "dark", label: "深色", desc: "始终用深色" },
] as const;

const ACCENTS = ["#111111", "#52525b", "#2563eb", "#7c3aed", "#0f766e", "#c2410c"];

/** 外观是账号级的，没有 wsId；壳会挑最近待过的库来撑左栏，这样从设置点过来不会整条导航塌掉。 */
export function AppearancePage() {
  const { refresh } = useThemeRefresh();
  const toast = useToast();
  const [me, setMe] = useState<Me | null>(null);
  const [themes, setThemes] = useState<Theme[]>([]);
  const [accent, setAccent] = useState("#111111");
  const [raw, setRaw] = useState("");
  const [importErr, setImportErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [m, t] = await Promise.all([api<Me>("/api/v1/me"), api<{ themes: Theme[] }>("/api/v1/themes")]);
    setMe(m); setAccent(m.accent ?? "#111111"); setThemes(t.themes);
  }, []);
  const reload = useCallback(() => {
    setLoading(true);
    load().then(() => setError("")).catch(e => setError((e as Error).message)).finally(() => setLoading(false));
  }, [load]);
  useEffect(() => { reload(); }, [reload]);

  async function patch(p: Partial<{ appearance: Me["appearance"]; themeId: string; accent: string | null }>) {
    try { await api("/api/v1/me/appearance", { method: "PATCH", body: JSON.stringify(p) }); refresh(); }
    catch (e) { toast.error("保存失败", (e as Error).message); void load(); }
  }

  async function importTheme() {
    setImportErr("");
    try {
      await api("/api/v1/themes/import", { method: "POST", body: JSON.stringify(JSON.parse(raw)) });
      setThemes((await api<{ themes: Theme[] }>("/api/v1/themes")).themes);
      setRaw("");
      toast.success("主题已安装");
    } catch (e) { setImportErr((e as Error).message); }
  }

  return <SettingsShell current="appearance" loading={loading} error={error} onRetry={reload}>
    <div className="space-y-4">
      <SectionCard title="显示模式" desc="跟随操作系统，或固定为浅色、深色。">
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          {MODES.map(m => <button key={m.v} type="button" aria-pressed={me?.appearance === m.v}
            onClick={() => { setMe(me && { ...me, appearance: m.v }); void patch({ appearance: m.v }); }}
            className={cn("rounded-xl border border-border p-3 text-left outline-none transition hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring/50",
              me?.appearance === m.v && "border-primary ring-2 ring-primary/10")}>
            <div className={cn("mb-3 h-20 rounded-lg border border-border p-2",
              m.v === "dark" ? "bg-zinc-900" : m.v === "light" ? "bg-white" : "bg-gradient-to-r from-white to-zinc-900")}>
              <div className="h-2 w-1/2 rounded bg-zinc-400/40" />
              <div className="mt-2 h-8 rounded border border-zinc-400/20" />
            </div>
            <span className="block text-sm font-medium">{m.label}</span>
            <span className="block text-xs text-muted-foreground">{m.desc}</span>
          </button>)}
        </div>
      </SectionCard>

      <SectionCard title="强调色" desc="用于按钮、链接和选中状态。">
        <div className="flex flex-wrap items-center gap-3 p-4">
          {ACCENTS.map(c => <button key={c} type="button" aria-label={`强调色 ${c}`} aria-pressed={accent === c}
            onClick={() => { setAccent(c); void patch({ accent: c }); }}
            className={cn("size-8 rounded-full border-2 border-background shadow-sm ring-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring", accent === c && "ring-2 ring-foreground")}
            style={{ backgroundColor: c }} />)}
          <label className="relative grid size-8 cursor-pointer place-items-center rounded-full border border-dashed border-border" title="自定义颜色">
            <Plus className="size-3.5" />
            <input className="absolute inset-0 cursor-pointer opacity-0" type="color" aria-label="自定义强调色"
              value={accent} onChange={e => { setAccent(e.target.value); void patch({ accent: e.target.value }); }} />
          </label>
        </div>
      </SectionCard>

      <SectionCard title="主题包" desc="主题包只能定义安全的 JSON 设计令牌，不会引入脚本。">
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          {themes.map(t => <button key={t.id} type="button" aria-pressed={me?.themeId === t.id}
            onClick={() => { setMe(me && { ...me, themeId: t.id }); void patch({ themeId: t.id }); }}
            className={cn("flex items-center gap-3 rounded-xl border border-border p-4 text-left outline-none transition hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50",
              me?.themeId === t.id && "border-primary ring-2 ring-primary/10")}>
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-foreground text-background"><Paintbrush className="size-4" /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{t.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{t.author ?? "本地主题"}</span>
            </span>
            {me?.themeId === t.id && <Check className="size-4 shrink-0 text-primary" />}
          </button>)}
        </div>
        <details className="border-t border-border px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">导入 theme.json</summary>
          <div className="mt-4 grid gap-3">
            <Field label="主题 JSON" htmlFor="theme-json" hint="从主题作者那里拿到的 theme.json 全文。">
              <Textarea id="theme-json" className="min-h-40 font-mono text-xs" value={raw} onChange={e => setRaw(e.target.value)} placeholder="粘贴主题 JSON…" />
            </Field>
            <FormError>{importErr}</FormError>
            <Button size="sm" className="w-fit" disabled={!raw.trim()} onClick={() => void importTheme()}>导入主题</Button>
          </div>
        </details>
      </SectionCard>
    </div>
  </SettingsShell>;
}
