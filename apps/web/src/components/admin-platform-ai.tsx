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
 * 管理员在这里准备全站可用的 AI 渠道、默认渠道、每人每日次数和用量，以及渠道每天的总额。
 */
type Channel = {
  id: string; name: string; baseUrl: string; keySuffix: string; models: string[]; defaultModel: string;
  enabled: boolean; platformDefault: boolean; workspaces: number; usageToday: number; usage7d: number;
  tokensToday?: number; tokens7d?: number; dailyRequestLimit: number | null; dailyTokenLimit: number | null; createdAt: string;
};
type PlatformData = { defaultDailyLimit: number | null; defaultDailyTokenLimit?: number | null; channels: Channel[] };
type UsageRow = {
  id: string; displayName: string; handle: string; email: string; admin: boolean;
  override: number | null; effectiveLimit: number | null; tokenOverride: number | null; effectiveTokenLimit: number | null;
  today: number; last7d: number; tokensToday: number; tokens7d: number; rangeRequests: number; rangeTokens: number; lastUsedAt: string | null;
};
type UsageChannel = { id: string | null; name: string; requests: number; tokens: number };
type UsageData = {
  defaultDailyLimit: number | null; defaultDailyTokenLimit: number | null;
  range: { preset: string; from: string; to: string };
  totals: { today: number; last7d: number; todayTokens: number; last7dTokens: number; rangeRequests: number; rangeTokens: number; users: number };
  users: UsageRow[]; channels: UsageChannel[];
};
type Draft = { name: string; baseUrl: string; apiKey: string; clearApiKey: boolean; models: string[]; defaultModel: string; platformDefault: boolean; requestLimit: string; tokenLimit: string };

const EMPTY_DRAFT: Draft = { name: "", baseUrl: "https://api.openai.com/v1", apiKey: "", clearApiKey: false, models: [], defaultModel: "", platformDefault: false, requestLimit: "", tokenLimit: "" };
const uniq = (values: string[]) => [...new Set(values.map(v => v.trim()).filter(Boolean))];
const limitText = (limit: number | null, unit = "次") => limit === null ? "不限" : limit === 0 ? "不开放" : `${limit} ${unit}/天`;

function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn("h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20", className)} {...props} />;
}

export function AdminPlatformAi() {
  const toast = useToast(), askConfirm = useConfirm();
  const [data, setData] = useState<PlatformData | null>(null);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState(""), [searching, setSearching] = useState(false);
  const [preset, setPreset] = useState("7"), [from, setFrom] = useState(""), [to, setTo] = useState("");
  const [editor, setEditor] = useState<Channel | "new" | null>(null);

  const loadChannels = useCallback(async () => setData(await api<PlatformData>("/api/v1/admin/ai/platform")), []);
  const loadUsage = useCallback(async (q = "", range: { preset: string; from: string; to: string } = { preset: "7", from: "", to: "" }) => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    params.set("preset", range.preset);
    if (range.preset === "custom" && range.from) params.set("from", range.from);
    if (range.preset === "custom" && range.to) params.set("to", range.to);
    setUsage(await api<UsageData>(`/api/v1/admin/ai/usage?${params}`));
  }, []);
  useEffect(() => {
    Promise.all([loadChannels(), loadUsage("", { preset, from, to })])
      .catch(e => toast.error("平台 AI 暂时打不开", (e as Error).message))
      .finally(() => setLoading(false));
  }, [loadChannels, loadUsage, toast]);

  async function refreshAll() { try { await Promise.all([loadChannels(), loadUsage(query, { preset, from, to })]); } catch (e) { toast.error("刷新失败", (e as Error).message); } }
  async function search(q: string) {
    setSearching(true);
    try { await loadUsage(q, { preset, from, to }); } catch (e) { toast.error("搜索失败", (e as Error).message); } finally { setSearching(false); }
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

    <LimitCard requests={data?.defaultDailyLimit ?? null} tokens={data?.defaultDailyTokenLimit ?? null} onSaved={async () => { await Promise.all([loadChannels(), loadUsage(query, { preset, from, to })]); }} />

    <section className="rounded-2xl border border-border bg-background shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border p-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-base font-semibold">用户用量</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">记录会一直留着。下面可以按今天、近 7 天、近 30 天或自己选的日期查看；今天和近 7 天的数字始终都在。按北京时间 0 点算一天。</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {[["today","今天"],["7","近 7 天"],["30","近 30 天"],["custom","自定义"]].map(([id, label]) => <button key={id} type="button" onClick={() => { setPreset(id); if (id !== "custom") void loadUsage(query, { preset: id, from, to }); }} className={cn("rounded-lg px-3 py-1.5 text-xs", preset===id ? "bg-foreground text-background" : "bg-muted text-muted-foreground")}>{label}</button>)}
            {preset==="custom" && <>
              <Input type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label="开始日期" className="w-36" />
              <span className="text-xs text-muted-foreground">到</span>
              <Input type="date" value={to} onChange={e => setTo(e.target.value)} aria-label="结束日期" className="w-36" />
              <Button type="button" size="sm" variant="outline" onClick={() => { if (!from || !to) return toast.error("请选择日期", "开始和结束都要填。"); void loadUsage(query, { preset, from, to }); }}>查看</Button>
            </>}
          </div>
          {usage?.range && <p className="mt-2 text-[11px] text-muted-foreground">当前查看 {usage.range.from} 至 {usage.range.to}：{usage.totals.rangeRequests} 次，用量 {formatTokens(usage.totals.rangeTokens)}。今天 {usage.totals.today} 次 / 用量 {formatTokens(usage.totals.todayTokens)}，近 7 天 {usage.totals.last7d} 次 / 用量 {formatTokens(usage.totals.last7dTokens)}。</p>}
        </div>
        <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void search(query); }}>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="姓名、账号或邮箱" className="w-56 pl-8" />
          </div>
          <Button type="submit" variant="outline" size="sm" disabled={searching}>{searching ? <LoaderCircle className="animate-spin" /> : "搜索"}</Button>
          {query && <Button type="button" variant="ghost" size="sm" onClick={() => { setQuery(""); void loadUsage("", { preset, from, to }); }}><X />清除</Button>}
        </form>
      </div>
      {!usage?.users.length ? <p className="p-10 text-center text-sm text-muted-foreground">{query ? "没有找到匹配的用户。" : "这段时间还没有人使用平台 AI。"}</p> :
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-5 py-2.5 font-medium">用户</th>
              <th className="px-3 py-2.5 font-medium">今天</th>
              <th className="px-3 py-2.5 font-medium">近 7 天</th>
              <th className="px-3 py-2.5 font-medium">所选范围</th>
              <th className="px-3 py-2.5 font-medium">最近使用</th>
              <th className="px-5 py-2.5 font-medium">每天次数</th>
              <th className="px-5 py-2.5 font-medium">每天用量</th>
            </tr></thead>
            <tbody>{usage.users.map(u => <UsageTableRow key={u.id} row={u} defaultLimit={usage.defaultDailyLimit} defaultTokenLimit={usage.defaultDailyTokenLimit} onSaved={() => loadUsage(query, { preset, from, to })} />)}</tbody>
          </table>
        </div>}
    </section>

    {!!usage?.channels.length && <section className="rounded-2xl border border-border bg-background shadow-sm">
      <div className="border-b border-border p-5"><h2 className="text-base font-semibold">渠道用量</h2><p className="mt-1 text-xs text-muted-foreground">上面所选日期里，每条平台渠道的次数和用量（所有人合计）。</p></div>
      <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-border text-left text-xs text-muted-foreground"><th className="px-5 py-2.5 font-medium">渠道</th><th className="px-3 py-2.5 font-medium">次数</th><th className="px-5 py-2.5 font-medium">用量</th></tr></thead>
        <tbody>{usage.channels.map(c => <tr key={c.id ?? c.name} className="border-b border-border last:border-0"><td className="px-5 py-3 font-medium">{c.name}</td><td className="px-3 py-3 tabular-nums">{c.requests}</td><td className="px-5 py-3 tabular-nums">{formatTokens(c.tokens)}</td></tr>)}</tbody></table></div>
    </section>}
    <div className="rounded-xl border bg-muted/30 px-4 py-3 text-xs leading-6 text-muted-foreground">
      <p className="font-medium text-foreground">额度怎么算</p>
      <p>只有实际用到平台渠道的请求才计数：AI 写作、知识问答（含外部工具提问）、导图和画板的 AI 生成、日历任务提取、智能体回复都算。自己配置的渠道不受限制。</p>
      <p>每人每天有次数和用量两道上限，每条渠道也可以设当天的总次数和总用量。任何一道到顶都会停下来。按北京时间 0 点重置。请求失败不计；笔记的后台向量化不计。多个请求同时发出时，临界点可能多放行一两次。</p>
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
      <Row icon={<Gauge />} label="每天上限" value={`${c.dailyRequestLimit === null ? "次数不限" : c.dailyRequestLimit === 0 ? "次数不开放" : `次数 ${c.dailyRequestLimit}`} · ${c.dailyTokenLimit === null ? "用量不限" : c.dailyTokenLimit === 0 ? "用量不开放" : `用量 ${c.dailyTokenLimit}`}`} />
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

function LimitCard({ requests, tokens, onSaved }: { requests: number | null; tokens: number | null; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [limitCount, setLimitCount] = useState(requests !== null);
  const [count, setCount] = useState(String(requests ?? 50));
  const [limitTokens, setLimitTokens] = useState(tokens !== null);
  const [tokenCount, setTokenCount] = useState(String(tokens ?? 100000));
  const [saving, setSaving] = useState(false);
  useEffect(() => { setLimitCount(requests !== null); setCount(String(requests ?? 50)); setLimitTokens(tokens !== null); setTokenCount(String(tokens ?? 100000)); }, [requests, tokens]);
  const nextRequests = limitCount ? Number(count) : null;
  const nextTokens = limitTokens ? Number(tokenCount) : null;
  const dirty = nextRequests !== requests || nextTokens !== tokens;
  async function save() {
    if (limitCount && (!Number.isInteger(nextRequests) || (nextRequests ?? 0) < 0 || (nextRequests ?? 0) > 100000)) return toast.error("次数不对", "请填写 0 到 100000 之间的整数。");
    if (limitTokens && (!Number.isInteger(nextTokens) || (nextTokens ?? 0) < 0 || (nextTokens ?? 0) > 100000000)) return toast.error("用量不对", "请填写 0 到 1 亿之间的整数。");
    setSaving(true);
    try {
      await api("/api/v1/admin/ai/limits", { method: "PATCH", body: JSON.stringify({ defaultDailyLimit: nextRequests, defaultDailyTokenLimit: nextTokens }) });
      toast.success("每日额度已保存", "按北京时间 0 点重置。没有单独设置的用户使用这里的默认。");
      await onSaved();
    } catch (e) { toast.error("保存失败", (e as Error).message); } finally { setSaving(false); }
  }
  return <section className="rounded-2xl border border-border bg-background p-5 shadow-sm">
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold">每人每日额度</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">限制每位用户每天使用平台渠道的次数和用量。自己配置的渠道不受影响；可在下方给个别用户单独放宽或收紧。空着表示不限，填 0 表示不开放。</p>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm"><Switch checked={limitCount} onCheckedChange={setLimitCount} label="限制次数" />限制次数</label>
        {limitCount && <div className="flex items-center gap-2 text-sm"><span className="text-muted-foreground">每人每天</span><Input type="number" min={0} max={100000} value={count} onChange={e => setCount(e.target.value)} className="w-28" /><span className="text-muted-foreground">次</span></div>}
        <label className="flex items-center gap-2 text-sm"><Switch checked={limitTokens} onCheckedChange={setLimitTokens} label="限制用量" />限制用量</label>
        {limitTokens && <div className="flex items-center gap-2 text-sm"><span className="text-muted-foreground">每人每天</span><Input type="number" min={0} max={100000000} value={tokenCount} onChange={e => setTokenCount(e.target.value)} className="w-32" /><span className="text-muted-foreground">用量</span></div>}
        <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>{saving ? <LoaderCircle className="animate-spin" /> : <Check />}保存</Button>
      </div>
    </div>
  </section>;
}

function LimitPicker({ label, value, fallback, max, unit = "次", onSave }: { label: string; value: number | null; fallback: number | null; max: number; unit?: string; onSave: (limit: number | null) => Promise<void> }) {
  const toast = useToast();
  const initial = value === null ? "default" : value === -1 ? "unlimited" : "custom";
  const [mode, setMode] = useState(initial);
  const [count, setCount] = useState(String(value !== null && value >= 0 ? value : fallback ?? 50));
  const [saving, setSaving] = useState(false);
  useEffect(() => { setMode(value === null ? "default" : value === -1 ? "unlimited" : "custom"); setCount(String(value !== null && value >= 0 ? value : fallback ?? 50)); }, [value, fallback]);
  const dirty = mode !== initial || (mode === "custom" && Number(count) !== value);
  async function save() {
    const n = Number(count);
    if (mode === "custom" && (!Number.isInteger(n) || n < 0 || n > max)) return toast.error("数字不对", `请填写 0 到 ${max} 之间的整数。`);
    setSaving(true);
    try { await onSave(mode === "default" ? null : mode === "unlimited" ? -1 : n); }
    catch (e) { toast.error("保存失败", (e as Error).message); } finally { setSaving(false); }
  }
  return <div className="flex items-center gap-2">
    <span className="w-8 shrink-0 text-[11px] text-muted-foreground">{label}</span>
    <Select value={mode} onChange={e => setMode(e.target.value)} aria-label={label}>
      <option value="default">跟随全站（{limitText(fallback, unit)}）</option>
      <option value="unlimited">不限</option>
      <option value="custom">单独设置</option>
    </Select>
    {mode === "custom" && <Input type="number" min={0} max={max} value={count} onChange={e => setCount(e.target.value)} className="w-24" />}
    {dirty && <Button size="sm" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle className="animate-spin" /> : "保存"}</Button>}
  </div>;
}

function UsageTableRow({ row: u, defaultLimit, defaultTokenLimit, onSaved }: { row: UsageRow; defaultLimit: number | null; defaultTokenLimit: number | null; onSaved: () => Promise<void> }) {
  const toast = useToast();
  async function save(body: { limit?: number | null; tokenLimit?: number | null }) {
    await api(`/api/v1/admin/users/${u.id}/ai-limit`, { method: "PATCH", body: JSON.stringify(body) });
    toast.success(`已更新 ${u.displayName} 的额度`);
    await onSaved();
  }
  const over = u.effectiveLimit !== null && u.today >= u.effectiveLimit;
  const overTokens = u.effectiveTokenLimit !== null && u.tokensToday >= u.effectiveTokenLimit;
  return <tr className="border-b border-border last:border-0">
    <td className="px-5 py-3"><div className="flex items-center gap-2"><span className="font-medium">{u.displayName}</span>{u.admin && <Badge>管理员</Badge>}</div><p className="text-xs text-muted-foreground">@{u.handle} · {u.email}</p></td>
    <td className="px-3 py-3 tabular-nums"><span className={cn(over && "font-medium text-[var(--warning)]")}>{u.today}</span><span className="text-muted-foreground"> / {u.effectiveLimit === null ? "不限" : u.effectiveLimit}</span><div className={cn("text-[11px]", overTokens && "text-[var(--warning)]")}>{formatTokens(u.tokensToday)} / {u.effectiveTokenLimit === null ? "不限" : formatTokens(u.effectiveTokenLimit)}</div></td>
    <td className="px-3 py-3 tabular-nums">{u.last7d}<div className="text-[11px] text-muted-foreground">{formatTokens(u.tokens7d)}</div></td>
    <td className="px-3 py-3 tabular-nums">{u.rangeRequests}<div className="text-[11px] text-muted-foreground">{formatTokens(u.rangeTokens)}</div></td>
    <td className="px-3 py-3 text-xs text-muted-foreground">{u.lastUsedAt ? new Date(u.lastUsedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
    <td className="px-5 py-3"><LimitPicker label="次数" value={u.override} fallback={defaultLimit} max={100000} onSave={limit => save({ limit })} /></td>
    <td className="px-5 py-3"><LimitPicker label="用量" value={u.tokenOverride} fallback={defaultTokenLimit} max={100000000} unit="用量" onSave={tokenLimit => save({ tokenLimit })} /></td>
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
    else { setDraft({ name: editor.name, baseUrl: editor.baseUrl, apiKey: "", clearApiKey: false, models: editor.models, defaultModel: editor.defaultModel, platformDefault: editor.platformDefault, requestLimit: editor.dailyRequestLimit === null || editor.dailyRequestLimit === undefined ? "" : String(editor.dailyRequestLimit), tokenLimit: editor.dailyTokenLimit === null || editor.dailyTokenLimit === undefined ? "" : String(editor.dailyTokenLimit) }); setCatalog(editor.models); }
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
    const requestN = draft.requestLimit.trim() === "" ? null : Number(draft.requestLimit);
    const tokenN = draft.tokenLimit.trim() === "" ? null : Number(draft.tokenLimit);
    if (requestN !== null && (!Number.isInteger(requestN) || requestN < 0)) return toast.error("次数不对", "每天次数留空表示不限，或填一个非负整数。");
    if (tokenN !== null && (!Number.isInteger(tokenN) || tokenN < 0)) return toast.error("用量不对", "每天用量留空表示不限，或填一个非负整数。");
    setSaving(true);
    try {
      const payload = {
        name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), models: draft.models, defaultModel: draft.defaultModel || draft.models[0],
        platformDefault: draft.platformDefault, dailyRequestLimit: requestN, dailyTokenLimit: tokenN,
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}), ...(current && draft.clearApiKey ? { clearApiKey: true } : {}),
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
          <label className="grid gap-1.5 text-sm"><span className="font-medium">每天次数上限</span><Input value={draft.requestLimit} onChange={e => setDraft(d => ({ ...d, requestLimit: e.target.value }))} placeholder="不限" inputMode="numeric" /><span className="text-xs text-muted-foreground">这条渠道所有人合计，留空不限。按北京时间 0 点重置。</span></label>
          <label className="grid gap-1.5 text-sm"><span className="font-medium">每天用量上限</span><Input value={draft.tokenLimit} onChange={e => setDraft(d => ({ ...d, tokenLimit: e.target.value }))} placeholder="不限" inputMode="numeric" /><span className="text-xs text-muted-foreground">输入和输出加在一起。留空不限。</span></label>
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
