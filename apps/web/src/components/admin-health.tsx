import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
type Check = { key: string; label: string; status: "ok" | "warning" | "error"; detail: string; checkedAt?: string | null };
type Health = { checkedAt: string; checks: Check[]; onboarding: { instanceName: string; hasCodes: boolean; hasNotebook: boolean; hasBackup: boolean; hasAi: boolean; hasMcp: boolean; homeWorkspaceId: string | null } };
export function AdminSafetyNotice() {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => { let stop = false; const load = () => { void api<Health>("/api/v1/admin/health").then(x => { if (!stop) setHealth(x); }).catch(() => {}); }; load(); const timer = setInterval(load, 60000); return () => { stop = true; clearInterval(timer); }; }, []);
  const warnings = health?.checks.filter(x => ["secret", "backup"].includes(x.key) && x.status !== "ok") ?? [];
  if (!warnings.length) return null;
  return <Link to="/admin" role="status" className="block shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs">管理员提醒：{warnings.map(x => x.key === "secret" ? "APP_SECRET 不安全" : health?.onboarding.hasBackup ? "备份尚未确认成功" : "尚未开启备份").join(" · ")} · 查看健康检查</Link>;
}
export function AdminHealth() {
  const [health, setHealth] = useState<Health | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [skip, setSkip] = useState<string[]>([]);
  const load = useCallback(async () => { const value = await api<Health>("/api/v1/admin/health"); setHealth(value); setName(value.onboarding.instanceName); setError(""); }, []);
  useEffect(() => { let cancelled = false; void api<Health>("/api/v1/admin/health").then(value => { if (!cancelled) { setHealth(value); setName(value.onboarding.instanceName); } }).catch(e => { if (!cancelled) setError((e as Error).message); }); return () => { cancelled = true; }; }, []);
  async function run(fn: () => Promise<void>) { setBusy(true); try { await fn(); setError(""); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  const home = health?.onboarding.homeWorkspaceId;
  return <section className="space-y-5 rounded-xl border bg-background p-5" aria-label="首小时清单与健康检查">
    <div><h2 className="text-lg font-semibold">第一小时清单</h2><p className="text-xs text-muted-foreground">先完成前三步，即可开始记录。备份、AI 与 MCP 可稍后配置；跳过不会隐藏风险。</p></div>
    <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); void run(async () => { await api("/api/v1/admin/settings", { method: "PATCH", body: JSON.stringify({ instanceName: name }) }); await load(); }); }}><label className="grid min-w-0 flex-1 gap-1 text-sm">1. 实例名称<Input aria-label="实例名称" value={name} onChange={e => setName(e.target.value)} maxLength={60} required /></label><Button disabled={busy || !name.trim()}>保存名称</Button></form>
    {health && <ol className="space-y-3 text-sm">{[
      { key: "codes", label: "2. 发注册码邀请家人", done: health.onboarding.hasCodes, href: "/admin?tab=codes" },
      { key: "notebook", label: "3. 建立第一个笔记本", done: health.onboarding.hasNotebook, href: home ? `/w/${home}` : "/app" },
      { key: "backup", label: "4. 设置并测试异机备份", done: health.onboarding.hasBackup, href: "/admin?tab=backup", optional: true },
      { key: "ai", label: "5. AI 与 MCP（可选）", done: health.onboarding.hasAi || health.onboarding.hasMcp, href: home ? `/w/${home}/settings/integrations` : "/admin?tab=platformAi", optional: true },
    ].map(item => <li key={item.key} className="flex flex-wrap items-center gap-2"><span aria-label={item.done ? "已完成" : "待处理"}>{item.done ? "✓" : "○"}</span><Link className="underline underline-offset-4" to={item.href}>{item.label}</Link>{item.optional && !item.done && <Button size="sm" variant="ghost" onClick={() => setSkip(x => x.includes(item.key) ? x.filter(k => k !== item.key) : [...x, item.key])}>{skip.includes(item.key) ? "本次稍后配置" : "稍后配置"}</Button>}</li>)}</ol>}
    <div className="flex items-center justify-between gap-2 border-t pt-4"><h2 className="font-semibold">实例健康检查</h2><Button size="sm" variant="outline" disabled={busy} onClick={() => void run(load)}>刷新检查</Button></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!health && !error && <p role="status">正在检查…</p>}
    <ul className="space-y-3">{health?.checks.map(check => <li key={check.key} className="rounded-lg border p-3"><div className="flex flex-wrap items-center gap-2"><span className={check.status === "ok" ? "text-[var(--good)]" : check.status === "error" ? "text-destructive" : "text-amber-600"}>{check.status === "ok" ? "● 正常" : check.status === "error" ? "● 需处理" : "● 待确认"}</span><strong className="text-sm">{check.label}</strong>{check.key === "smtp" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => { const result = await api<Check>("/api/v1/admin/health/smtp", { method: "POST" }); setHealth(h => h ? { ...h, checks: h.checks.map(c => c.key === "smtp" ? result : c) } : h); })}>测试连接</Button>}</div><p className="mt-1 text-xs leading-5 text-muted-foreground">{check.detail}</p>{check.checkedAt && <p className="text-xs text-muted-foreground">记录时间：{new Date(check.checkedAt).toLocaleString()}</p>}</li>)}</ul>
  </section>;
}
