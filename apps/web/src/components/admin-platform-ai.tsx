import { useCallback, useEffect, useMemo, useState, type ReactNode, type SelectHTMLAttributes } from "react";
import {
  Activity, CalendarDays, Check, Gauge, Globe2, KeyRound, Layers3, LoaderCircle, Pencil, Plus, Power, RefreshCw, Search, Star, Trash2, Users, X,
} from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useConfirm } from "./ui/confirm";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { useToast } from "./ui/toast";

/**
 * 实例后台 → 平台 AI（issue #64）。
 * 管理员在这里准备全站可用的 AI 渠道、默认渠道和每人每日次数；工作区成员只能看到渠道名称和模型。
 */
type Channel = {
  id: string; name: string; baseUrl: string; keySuffix: string; models: string[]; defaultModel: string;
  enabled: boolean; platformDefault: boolean; workspaces: number; usageToday: number; usage7d: number; createdAt: string;
};
type PlatformData = { defaultDailyLimit: number | null; channels: Channel[] };
type UsageRow = {
  id: string; displayName: string; handle: string; email: string; admin: boolean;
  override: number | null; effectiveLimit: number | null; today: number; last7d: number; tokens7d: number; lastUsedAt: string | null;
};
type UsageData = { defaultDailyLimit: number | null; totals: { today: number; last7d: number; users: number }; users: UsageRow[] };
type Draft = { name: string; baseUrl: string; apiKey: string; clearApiKey: boolean; models: string[]; defaultModel: string; platformDefault: boolean };

const EMPTY_DRAFT: Draft = { name: "", baseUrl: "https://api.openai.com/v1", apiKey: "", clearApiKey: false, models: [], defaultModel: "", platformDefault: false };
const uniq = (values: string[]) => [...new Set(values.map(v => v.trim()).filter(Boolean))];
const limitText = (limit: number | null) => limit === null ? "不限" : limit === 0 ? "不开放" : `${limit} 次/天`;

function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn("h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20", className)} {...props} />;
}

export function AdminPlatformAi() {
  const toast = useToast(), askConfirm = useConfirm();
  const [data, setData] = useState<PlatformData | null>(null);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState(""), [searching, setSearching] = useState(false);
  const [editor, setEditor] = useState<Channel | "new" | null>(null);

  const loadChannels = useCallback(async () => setData(await api<PlatformData>("/api/v1/admin/ai/platform")), []);
  const loadUsage = useCallback(async (q = "") => setUsage(await api<UsageData>(`/api/v1/admin/ai/usage${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`)), []);
  useEffect(() => {
    Promise.all([loadChannels(), loadUsage()])
      .catch(e => toast.error("平台 AI 暂时打不开", (e as Error).message))
      .finally(() => setLoading(false));
  }, [loadChannels, loadUsage, toast]);

  async function refreshAll() { try { await Promise.all([loadChannels(), loadUsage(query)]); } catch (e) { toast.error("刷新失败", (e as Error).message); } }
  async function search(q: string) {
    setSearching(true);
    try { await loadUsage(q); } catch (e) { toast.error("搜索失败", (e as Error).message); } finally { setSearching(false); }
  }
  async function patchChannel(c: Channel, body: Record<string, unknown>, success: string) {
    try {
      const r = await api<{ resetWorkspaces?: number }>(`/api/v1/admin/ai/platform/channels/${c.id}`, { method: "PATCH", body: JSON.stringify(body) });
      toast.success(success, r.resetWorkspaces ? `${r.resetWorkspaces} 个选用它的工作区已改回「自动」。` : undefined);
      await loadChannels();
    } catch (e) { toast.error("操作失败", (e as Error).message); }
  }
  async function remove(c: Channel) {
    const yes = await askConfirm({
      title: `删除「${c.name}」？`,
      description: c.workspaces ? `有 ${c.workspaces} 个工作区正在选用它，删除后这些工作区会改回「自动」。` : "删除后全站用户都不能再使用这个渠道。",
      confirmText: "删除渠道", destructive: true,
    });
    if (!yes) return;
    try { await api(`/api/v1/admin/ai/platform/channels/${c.id}`, { method: "DELETE" }); toast.success("渠道已删除"); await loadChannels(); }
    catch (e) { toast.error("无法删除", (e as Error).message); }
  }

  if (loading) return <div className="grid gap-3 sm:grid-cols-2">{[0, 1, 2, 3].map(i => <div key={i} className="h-28 animate-pulse rounded-xl border bg-muted/60" />)}</div>;
  const channels = data?.channels ?? [];
  const defaultChannel = channels.find(c => c.platformDefault && c.enabled);

  return <div className="space-y-6">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric icon={<Activity />} label="今天调用" value={String(usage?.totals.today ?? 0)} hint="只统计平台提供的渠道" />
      <Metric icon={<Users />} label="今天使用人数" value={String(usage?.totals.users ?? 0)} hint="至少用过一次的人" />
      <Metric icon={<CalendarDays />} label="近 7 天调用" value={String(usage?.totals.last7d ?? 0)} hint="含今天" />
      <Metric icon={<Gauge />} label="每人每日额度" value={limitText(data?.defaultDailyLimit ?? null)} hint="可以给个别用户单独设置" />
    </div>

    <section className="rounded-2xl border border-border bg-background shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">平台渠道</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            这里添加的渠道对全站所有工作区可用。成员只能看到渠道名称和模型，看不到接口地址和密钥。
            {defaultChannel ? <>没有自行设置的工作区会自动使用「{defaultChannel.name}」。</> : <>还没有默认渠道，没配置 AI 的用户暂时用不了。</>}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" onClick={() => void refreshAll()}><RefreshCw />刷新</Button>
          <Button size="sm" onClick={() => setEditor("new")}><Plus />添加渠道</Button>
        </div>
      </div>
      {!channels.length ? <div className="p-10 text-center">
        <span className="mx-auto grid size-11 place-items-center rounded-xl bg-primary/10 text-primary"><Globe2 className="size-5" /></span>
        <p className="mt-3 text-sm font-medium">还没有平台渠道</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">添加一个 OpenAI 兼容的渠道，全站用户就能直接使用 AI 写作、知识问答和导图生成，不必各自准备密钥。</p>
        <Button className="mt-4" size="sm" onClick={() => setEditor("new")}><Plus />添加第一个渠道</Button>
      </div> : <div className="grid gap-3 p-4 lg:grid-cols-2">
        {channels.map(c => <ChannelCard key={c.id} channel={c}
          onEdit={() => setEditor(c)}
          onDefault={() => void patchChannel(c, { platformDefault: true }, `「${c.name}」已设为默认`)}
          onToggle={() => void patchChannel(c, { enabled: !c.enabled }, c.enabled ? "渠道已停用" : "渠道已启用")}
          onRemove={() => void remove(c)} />)}
      </div>}
    </section>

    <LimitCard value={data?.defaultDailyLimit ?? null} onSaved={async () => { await Promise.all([loadChannels(), loadUsage(query)]); }} />

    <section className="rounded-2xl border border-border bg-background shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border p-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-base font-semibold">用户用量</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">默认列出近 7 天用过平台 AI 或单独设置过额度的用户；搜索可以找到任何人。按北京时间 0 点重置。</p>
        </div>
        <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void search(query); }}>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="姓名、账号或邮箱" className="w-56 pl-8" />
          </div>
          <Button type="submit" variant="outline" size="sm" disabled={searching}>{searching ? <LoaderCircle className="animate-spin" /> : "搜索"}</Button>
          {query && <Button type="button" variant="ghost" size="sm" onClick={() => { setQuery(""); void search(""); }}><X />清除</Button>}
        </form>
      </div>
      {!usage?.users.length ? <p className="p-10 text-center text-sm text-muted-foreground">{query ? "没有找到匹配的用户。" : "近 7 天还没有人使用平台 AI。"}</p> :
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-5 py-2.5 font-medium">用户</th>
              <th className="px-3 py-2.5 font-medium">今天</th>
              <th className="px-3 py-2.5 font-medium">近 7 天</th>
              <th className="px-3 py-2.5 font-medium">近 7 天 token</th>
              <th className="px-3 py-2.5 font-medium">最近使用</th>
              <th className="px-5 py-2.5 font-medium">每日额度</th>
            </tr></thead>
            <tbody>{usage.users.map(u => <UsageTableRow key={u.id} row={u} defaultLimit={usage.defaultDailyLimit} onSaved={() => loadUsage(query)} />)}</tbody>
          </table>
        </div>}
    </section>

    <div className="rounded-xl border bg-muted/30 px-4 py-3 text-xs leading-6 text-muted-foreground">
      <p className="font-medium text-foreground">额度怎么算</p>
      <p>只有实际用到平台渠道的 AI 请求才计次：AI 写作、知识问答（含 MCP 提问）、导图和画板的 AI 生成、日历任务提取都算一次；用户自己配置的渠道不受限制。</p>
      <p>请求失败不计次；笔记的后台向量化不计次。多个请求同时发出时，临界点可能多放行一两次。</p>
    </div>

    <ChannelDialog editor={editor} onClose={() => setEditor(null)} onSaved={async () => { setEditor(null); await loadChannels(); }} />
  </div>;
}

function Metric({ icon, label, value, hint }: { icon: ReactNode; label: string; value: string; hint: string }) {
  return <div className="rounded-xl border bg-background p-4">
    <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="[&_svg]:size-3.5">{icon}</span>{label}</div>
    <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
    <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
  </div>;
}

function ChannelCard({ channel: c, onEdit, onDefault, onToggle, onRemove }: { channel: Channel; onEdit: () => void; onDefault: () => void; onToggle: () => void; onRemove: () => void }) {
  return <article className={cn("flex flex-col gap-3 rounded-xl border p-4 transition", c.platformDefault ? "border-primary/40 bg-primary/[0.03]" : "border-border", !c.enabled && "opacity-70")}>
    <div className="flex items-start gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Globe2 className="size-4" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <h3 className="truncate text-sm font-semibold">{c.name}</h3>
          {c.platformDefault && <Badge className="border-primary/30 bg-primary/10 text-primary"><Star className="mr-1 size-3" />默认</Badge>}
          {!c.enabled && <Badge>已停用</Badge>}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{c.baseUrl}</p>
      </div>
    </div>
    <div className="grid gap-1.5 text-xs text-muted-foreground">
      <Row icon={<KeyRound />} label="密钥" value={c.keySuffix ? `••••${c.keySuffix}` : "未填写"} />
      <Row icon={<Layers3 />} label="模型" value={c.models.length ? `${c.models.length} 个，默认 ${c.defaultModel || c.models[0]}` : "还没选模型"} />
      <Row icon={<Users />} label="工作区选用" value={`${c.workspaces} 个`} />
      <Row icon={<Activity />} label="调用" value={`今天 ${c.usageToday} · 近 7 天 ${c.usage7d}`} />
    </div>
    <div className="mt-auto flex flex-wrap gap-1.5 border-t border-border pt-3">
      <Button variant="outline" size="sm" onClick={onEdit}><Pencil />编辑</Button>
      {!c.platformDefault && c.enabled && <Button variant="outline" size="sm" onClick={onDefault}><Star />设为默认</Button>}
      <Button variant="ghost" size="sm" onClick={onToggle}><Power />{c.enabled ? "停用" : "启用"}</Button>
      <Button variant="ghost" size="sm" className="ml-auto text-destructive hover:text-destructive" onClick={onRemove}><Trash2 />删除</Button>
    </div>
  </article>;
}

function Row({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return <div className="flex min-w-0 items-center gap-2"><span className="[&_svg]:size-3.5">{icon}</span><span>{label}</span><span className="ml-auto truncate font-medium text-foreground">{value}</span></div>;
}

function LimitCard({ value, onSaved }: { value: number | null; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [limited, setLimited] = useState(value !== null), [count, setCount] = useState(String(value ?? 50)), [saving, setSaving] = useState(false);
  useEffect(() => { setLimited(value !== null); setCount(String(value ?? 50)); }, [value]);
  const dirty = limited !== (value !== null) || (limited && Number(count) !== value);
  async function save() {
    const n = Number(count);
    if (limited && (!Number.isInteger(n) || n < 0 || n > 100000)) return toast.error("次数不对", "请填写 0 到 100000 之间的整数。");
    setSaving(true);
    try {
      await api("/api/v1/admin/ai/limits", { method: "PATCH", body: JSON.stringify({ defaultDailyLimit: limited ? n : null }) });
      toast.success("每日额度已保存", limited ? (n === 0 ? "没有单独设置的用户将不能使用平台 AI。" : `每人每天最多 ${n} 次，北京时间 0 点重置。`) : "平台 AI 不再限制次数。");
      await onSaved();
    } catch (e) { toast.error("保存失败", (e as Error).message); } finally { setSaving(false); }
  }
  return <section className="rounded-2xl border border-border bg-background p-5 shadow-sm">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold">每人每日额度</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">限制每位用户每天使用平台渠道的次数。用户用自己配置的渠道不受影响；可在下方给个别用户单独放宽或收紧。</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm"><Switch checked={limited} onCheckedChange={setLimited} label="限制次数" />限制次数</label>
        {limited && <div className="flex items-center gap-2 text-sm"><span className="text-muted-foreground">每人每天</span><Input type="number" min={0} max={100000} value={count} onChange={e => setCount(e.target.value)} className="w-24" /><span className="text-muted-foreground">次</span></div>}
        <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>{saving ? <LoaderCircle className="animate-spin" /> : <Check />}保存</Button>
      </div>
    </div>
  </section>;
}

function UsageTableRow({ row: u, defaultLimit, onSaved }: { row: UsageRow; defaultLimit: number | null; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const initialMode = u.override === null ? "default" : u.override === -1 ? "unlimited" : "custom";
  const [mode, setMode] = useState(initialMode), [count, setCount] = useState(String(u.override !== null && u.override >= 0 ? u.override : defaultLimit ?? 50)), [saving, setSaving] = useState(false);
  useEffect(() => { setMode(u.override === null ? "default" : u.override === -1 ? "unlimited" : "custom"); setCount(String(u.override !== null && u.override >= 0 ? u.override : defaultLimit ?? 50)); }, [u.override, defaultLimit]);
  const dirty = mode !== initialMode || (mode === "custom" && Number(count) !== u.override);
  async function save() {
    const n = Number(count);
    if (mode === "custom" && (!Number.isInteger(n) || n < 0 || n > 100000)) return toast.error("次数不对", "请填写 0 到 100000 之间的整数。");
    setSaving(true);
    try {
      await api(`/api/v1/admin/users/${u.id}/ai-limit`, { method: "PATCH", body: JSON.stringify({ limit: mode === "default" ? null : mode === "unlimited" ? -1 : n }) });
      toast.success(`已更新 ${u.displayName} 的额度`);
      await onSaved();
    } catch (e) { toast.error("保存失败", (e as Error).message); } finally { setSaving(false); }
  }
  const over = u.effectiveLimit !== null && u.today >= u.effectiveLimit;
  return <tr className="border-b border-border last:border-0">
    <td className="px-5 py-3"><div className="flex items-center gap-2"><span className="font-medium">{u.displayName}</span>{u.admin && <Badge>管理员</Badge>}</div><p className="text-xs text-muted-foreground">@{u.handle} · {u.email}</p></td>
    <td className="px-3 py-3 tabular-nums"><span className={cn(over && "font-medium text-[var(--warning)]")}>{u.today}</span><span className="text-muted-foreground"> / {u.effectiveLimit === null ? "不限" : u.effectiveLimit}</span></td>
    <td className="px-3 py-3 tabular-nums">{u.last7d}</td>
    <td className="px-3 py-3 tabular-nums text-muted-foreground">{formatTokens(u.tokens7d)}</td>
    <td className="px-3 py-3 text-xs text-muted-foreground">{u.lastUsedAt ? new Date(u.lastUsedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
    <td className="px-5 py-3"><div className="flex items-center gap-2">
      <Select value={mode} onChange={e => setMode(e.target.value)} aria-label={`${u.displayName} 的每日额度`}>
        <option value="default">跟随全站（{limitText(defaultLimit)}）</option>
        <option value="unlimited">不限</option>
        <option value="custom">单独设置</option>
      </Select>
      {mode === "custom" && <Input type="number" min={0} max={100000} value={count} onChange={e => setCount(e.target.value)} className="w-20" aria-label="每天次数" />}
      {dirty && <Button size="sm" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle className="animate-spin" /> : "保存"}</Button>}
    </div></td>
  </tr>;
}

function formatTokens(n: number) {
  if (!n) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function ChannelDialog({ editor, onClose, onSaved }: { editor: Channel | "new" | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [catalog, setCatalog] = useState<string[]>([]), [search, setSearch] = useState(""), [manual, setManual] = useState("");
  const [discovering, setDiscovering] = useState(false), [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!editor) return;
    if (editor === "new") { setDraft(EMPTY_DRAFT); setCatalog([]); }
    else { setDraft({ name: editor.name, baseUrl: editor.baseUrl, apiKey: "", clearApiKey: false, models: editor.models, defaultModel: editor.defaultModel, platformDefault: editor.platformDefault }); setCatalog(editor.models); }
    setSearch(""); setManual("");
  }, [editor]);
  const shown = useMemo(() => uniq([...draft.models, ...catalog]).filter(m => m.toLowerCase().includes(search.toLowerCase())).slice(0, 150), [catalog, draft.models, search]);
  const current = editor && editor !== "new" ? editor : null;

  async function discover() {
    if (!draft.baseUrl.trim()) return toast.error("还不能获取模型", "请先填写接口地址。");
    setDiscovering(true);
    try {
      const body = { baseUrl: draft.baseUrl.trim(), ...(draft.apiKey ? { apiKey: draft.apiKey } : current ? { providerId: current.id } : { apiKey: "" }) };
      const r = await api<{ models: string[] }>("/api/v1/ai/providers/discover-models", { method: "POST", body: JSON.stringify(body) });
      setCatalog(c => uniq([...c, ...r.models]));
      toast.success("连接成功", r.models.length ? `发现 ${r.models.length} 个模型，勾选要开放给用户的模型。` : "这个渠道没有返回模型列表，可以手动添加模型名。");
    } catch (e) { toast.error("连接失败", (e as Error).message); } finally { setDiscovering(false); }
  }
  function toggle(id: string) { setDraft(d => { const models = d.models.includes(id) ? d.models.filter(m => m !== id) : [...d.models, id]; return { ...d, models, defaultModel: models.includes(d.defaultModel) ? d.defaultModel : models[0] ?? "" }; }); }
  function addManual() { const id = manual.trim(); if (!id) return; setCatalog(c => uniq([...c, id])); setDraft(d => ({ ...d, models: uniq([...d.models, id]), defaultModel: d.defaultModel || id })); setManual(""); }
  async function save() {
    if (!draft.name.trim()) return toast.error("还不能保存", "请给渠道起一个用户能看懂的名字，例如「站点 AI」。");
    if (!draft.baseUrl.trim()) return toast.error("还不能保存", "请填写接口地址。");
    if (!draft.models.length) return toast.error("还不能保存", "至少勾选一个模型，用户才有得选。");
    setSaving(true);
    try {
      const payload = {
        name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), models: draft.models, defaultModel: draft.defaultModel || draft.models[0],
        platformDefault: draft.platformDefault, ...(draft.apiKey ? { apiKey: draft.apiKey } : {}), ...(current && draft.clearApiKey ? { clearApiKey: true } : {}),
      };
      if (current) await api(`/api/v1/admin/ai/platform/channels/${current.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      else await api("/api/v1/admin/ai/platform/channels", { method: "POST", body: JSON.stringify(payload) });
      toast.success(current ? "渠道已保存" : "渠道已添加", current ? undefined : "全站用户现在都能选用它。");
      await onSaved();
    } catch (e) { toast.error("保存失败", (e as Error).message); } finally { setSaving(false); }
  }

  return <Dialog open={!!editor} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-w-2xl gap-0 p-0">
      <div className="border-b border-border p-6 pb-4">
        <DialogHeader><DialogTitle>{current ? `编辑「${current.name}」` : "添加平台渠道"}</DialogTitle>
          <DialogDescription>接口地址和密钥只有实例管理员能看到，其他用户只看到名称和你勾选的模型。</DialogDescription></DialogHeader>
      </div>
      <div className="max-h-[65vh] space-y-5 overflow-y-auto p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm"><span className="font-medium">名称</span><Input value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} placeholder="例如：站点 AI" /><span className="text-xs text-muted-foreground">用户在选择模型时看到的名字。</span></label>
          <label className="grid gap-1.5 text-sm"><span className="font-medium">接口地址</span><Input value={draft.baseUrl} onChange={e => setDraft(d => ({ ...d, baseUrl: e.target.value }))} placeholder="https://api.openai.com/v1" /><span className="text-xs text-muted-foreground">兼容 OpenAI 格式的服务地址，通常以 /v1 结尾。</span></label>
        </div>
        <label className="grid gap-1.5 text-sm"><span className="font-medium">密钥</span>
          <Input type="password" autoComplete="new-password" value={draft.apiKey} onChange={e => setDraft(d => ({ ...d, apiKey: e.target.value, clearApiKey: false }))} placeholder={current?.keySuffix ? `已保存 ••••${current.keySuffix}，留空则不修改` : "服务商提供的密钥"} />
          {current?.keySuffix && <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={draft.clearApiKey} onChange={e => setDraft(d => ({ ...d, clearApiKey: e.target.checked, apiKey: "" }))} />清除已保存的密钥（本地服务不需要密钥时使用）</label>}
        </label>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div><p className="text-sm font-medium">开放的模型</p><p className="text-xs text-muted-foreground">只有勾选的模型会出现在用户的选择里。</p></div>
            <Button variant="outline" size="sm" disabled={discovering} onClick={() => void discover()}>{discovering ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}获取模型列表</Button>
          </div>
          {(catalog.length > 8 || search) && <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="筛选模型" />}
          {shown.length ? <div className="grid max-h-60 gap-1 overflow-y-auto rounded-xl border border-border p-2 sm:grid-cols-2">
            {shown.map(m => { const on = draft.models.includes(m); return <button key={m} type="button" onClick={() => toggle(m)} className={cn("flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition", on ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted")}>
              <span className={cn("grid size-4 shrink-0 place-items-center rounded border", on ? "border-primary bg-primary text-primary-foreground" : "border-border")}>{on && <Check className="size-3" />}</span><span className="truncate">{m}</span>
            </button>; })}
          </div> : <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">填好接口地址和密钥后点「获取模型列表」，或在下面手动添加模型名。</p>}
          <div className="flex gap-2"><Input value={manual} onChange={e => setManual(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addManual(); } }} placeholder="手动添加模型名" /><Button variant="outline" onClick={addManual}><Plus />添加</Button></div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm"><span className="font-medium">默认模型</span>
            <Select value={draft.defaultModel} onChange={e => setDraft(d => ({ ...d, defaultModel: e.target.value }))} disabled={!draft.models.length}>
              {!draft.models.length && <option value="">先勾选模型</option>}
              {draft.models.map(m => <option key={m} value={m}>{m}</option>)}
            </Select>
            <span className="text-xs text-muted-foreground">工作区选「自动」时使用这个模型。</span></label>
          <label className="flex items-start gap-3 rounded-xl border border-border p-3 text-sm"><Switch checked={draft.platformDefault} onCheckedChange={v => setDraft(d => ({ ...d, platformDefault: v }))} label="设为默认渠道" />
            <span><span className="font-medium">设为默认渠道</span><span className="mt-0.5 block text-xs leading-5 text-muted-foreground">没有自己配置 AI 的工作区会自动使用它。同一时间只有一个默认渠道。</span></span></label>
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-border bg-muted/25 px-6 py-4">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button disabled={saving} onClick={() => void save()}>{saving ? <><LoaderCircle className="animate-spin" />保存中…</> : current ? "保存更改" : "添加渠道"}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
