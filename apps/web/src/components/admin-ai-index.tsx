import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity, AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, CircleSlash2,
  Database, FileText, Filter, LoaderCircle, Play, RefreshCw, Search, X,
} from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useConfirm } from "./ui/confirm";
import { FormError } from "./ui/form-error";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { useToast } from "./ui/toast";

type IndexStatus = "indexed" | "pending" | "running" | "stale" | "missing" | "failed";
type FilterStatus = "" | IndexStatus | "processing";
type Filters = {
  q: string;
  status: FilterStatus;
  workspaceId: string;
  userId: string;
  notebookId: string;
  workspaceKind: "" | "personal" | "team";
  aiIndex: "" | "on" | "off";
  workspaceAi: "" | "on" | "off";
  providerState: "" | "configured" | "unconfigured";
  updatedFrom: string;
  updatedTo: string;
  sort: "updated_desc" | "updated_asc" | "title_asc" | "title_desc";
};
type Options = {
  workspaces: Array<{ id: string; name: string; kind: string; noteCount: number }>;
  users: Array<{ id: string; displayName: string; handle: string; email: string; noteCount: number }>;
  notebooks: Array<{ id: string; title: string; workspaceId: string; noteCount: number }>;
  providers: Array<{ id: string; name: string; models: string[] }>;
  preferred: { providerId: string; model: string } | null;
};
type IndexNote = {
  id: string; title: string; workspaceId: string; workspaceName: string; workspaceKind: string; workspaceAiEnabled: boolean;
  notebookId: string; notebookTitle: string; creatorId: string; creatorName: string; creatorHandle: string; creatorEmail: string;
  aiIndex: boolean; updatedAt: string; indexedAt: string | null; chunks: number; status: IndexStatus; runAfter: string | null; lastError: string | null;
  providerConfigured: boolean; providerName: string | null; embeddingModel: string | null;
};
type IndexData = {
  summary: { total: number; indexed: number; pending: number; running: number; stale: number; missing: number; failed: number; unconfigured: number };
  notes: IndexNote[]; total: number; page: number; pageSize: number;
};

const EMPTY_FILTERS: Filters = {
  q: "", status: "", workspaceId: "", userId: "", notebookId: "", workspaceKind: "",
  aiIndex: "", workspaceAi: "", providerState: "", updatedFrom: "", updatedTo: "", sort: "updated_desc",
};
const PAGE_SIZES = [20, 50, 100];
const STATUS_META: Record<IndexStatus, { label: string; className: string }> = {
  indexed: { label: "已完成", className: "border-[color-mix(in_srgb,var(--good)_35%,transparent)] text-[var(--good)]" },
  pending: { label: "排队中", className: "border-primary/30 text-primary" },
  running: { label: "处理中", className: "border-primary/30 text-primary" },
  stale: { label: "待更新", className: "border-[color-mix(in_srgb,var(--warning)_35%,transparent)] text-[var(--warning)]" },
  missing: { label: "未量化", className: "" },
  failed: { label: "失败", className: "border-destructive/35 text-destructive" },
};

function compactFilters(filters: Filters) {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) as Partial<Filters> & { sort?: Filters["sort"] };
}

function Select({ label, value, onChange, children, className }: {
  label: string; value: string; onChange: (value: string) => void; children: ReactNode; className?: string;
}) {
  return <label className={cn("grid gap-1.5", className)}>
    <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
    <select value={value} onChange={e => onChange(e.target.value)}
      className="h-9 min-w-0 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20">
      {children}
    </select>
  </label>;
}

function keepInList<T extends { id: string }>(items: T[], selectedId: string, all: T[]) {
  if (!selectedId || items.some(item => item.id === selectedId)) return items;
  const selected = all.find(item => item.id === selectedId);
  return selected ? [selected, ...items] : items;
}

export function AdminAiIndex() {
  const toast = useToast();
  const askConfirm = useConfirm();
  const [options, setOptions] = useState<Options | null>(null);
  const [data, setData] = useState<IndexData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [queryInput, setQueryInput] = useState("");
  const [optionQuery, setOptionQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [autoEmbed, setAutoEmbed] = useState(true);

  useEffect(() => {
    api<Options>("/api/v1/admin/ai/index/options").then(result => {
      setOptions(result);
      const preferred = result.preferred;
      const provider = result.providers.find(item => item.id === preferred?.providerId) ?? result.providers[0];
      setProviderId(provider?.id ?? "");
      setModel(preferred?.model ?? provider?.models[0] ?? "");
    }).catch(e => setError((e as Error).message));
  }, []);

  useEffect(() => {
    const next = queryInput.trim();
    if (next === filters.q) return;
    const id = window.setTimeout(() => {
      setFilters(current => ({ ...current, q: next }));
      setPage(1);
      setSelected(new Set());
    }, 300);
    return () => window.clearTimeout(id);
  }, [queryInput, filters.q]);

  const params = useMemo(() => {
    const search = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    for (const [key, value] of Object.entries(compactFilters(filters))) search.set(key, String(value));
    return search.toString();
  }, [filters, page, pageSize]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setData(await api<IndexData>(`/api/v1/admin/ai/index?${params}`));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [params]);

  useEffect(() => { void load(); }, [load, tick]);
  useEffect(() => {
    if (!data || (data.summary.pending + data.summary.running) === 0) return;
    const id = window.setInterval(() => void load(true), 4000);
    return () => window.clearInterval(id);
  }, [data, load]);

  useEffect(() => {
    if (!data?.total || page <= 1 || data.notes.length) return;
    setPage(Math.max(1, Math.ceil(data.total / pageSize)));
  }, [data, page, pageSize]);

  const provider = options?.providers.find(item => item.id === providerId);
  const optionNeedle = optionQuery.trim().toLocaleLowerCase();
  const workspaces = useMemo(() => {
    const all = options?.workspaces ?? [];
    const filtered = optionNeedle ? all.filter(item => item.name.toLocaleLowerCase().includes(optionNeedle)) : all;
    return keepInList(filtered, filters.workspaceId, all);
  }, [filters.workspaceId, optionNeedle, options]);
  const users = useMemo(() => {
    const all = options?.users ?? [];
    const filtered = optionNeedle ? all.filter(item => `${item.displayName} ${item.handle} ${item.email}`.toLocaleLowerCase().includes(optionNeedle)) : all;
    return keepInList(filtered, filters.userId, all);
  }, [filters.userId, optionNeedle, options]);
  const notebooks = useMemo(() => {
    const all = (options?.notebooks ?? []).filter(item => !filters.workspaceId || item.workspaceId === filters.workspaceId);
    const filtered = optionNeedle ? all.filter(item => item.title.toLocaleLowerCase().includes(optionNeedle)) : all;
    return keepInList(filtered, filters.notebookId, all);
  }, [filters.notebookId, filters.workspaceId, optionNeedle, options]);
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));
  const filterCount = Object.entries(filters).filter(([key, value]) => value && key !== "sort").length;
  const pageIds = data?.notes.map(note => note.id) ?? [];
  const allPageSelected = !!pageIds.length && pageIds.every(id => selected.has(id));
  const somePageSelected = pageIds.some(id => selected.has(id));

  function changeFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters(current => ({ ...current, [key]: value, ...(key === "workspaceId" ? { notebookId: "" } : {}) }));
    setPage(1);
    setSelected(new Set());
  }
  function changeProvider(id: string) {
    setProviderId(id);
    setModel(options?.providers.find(item => item.id === id)?.models[0] ?? "");
  }
  function togglePage() {
    setSelected(current => {
      const next = new Set(current);
      if (allPageSelected) for (const id of pageIds) next.delete(id);
      else for (const id of pageIds) next.add(id);
      return next;
    });
  }

  async function applyGlobal() {
    if (!providerId || !model.trim()) return toast.error("还不能应用", "请选择共享渠道和 Embedding 模型。");
    if (!await askConfirm({
      title: "把这套 Embedding 配置应用到全站？",
      description: "所有工作区都会使用这套量化模型，全部未删除笔记都会重新排队，包括关闭了“AI 可读”或工作区 AI 的内容。只有渠道或模型发生变化的工作区会让旧向量失效，避免新旧模型混用；笔记正文、对话模型和实际检索权限不会改变。",
      confirmText: "应用并量化全部",
    })) return;
    setBusy(true);
    try {
      const result = await api<{ workspaces: number; queued: number; invalidatedWorkspaces: number }>("/api/v1/admin/ai/index/config", {
        method: "POST",
        body: JSON.stringify({ providerId, embeddingModel: model.trim(), autoEmbed }),
      });
      toast.success("全站量化已开始", `${result.queued} 篇笔记已排队，覆盖 ${result.workspaces} 个工作区。`);
      setSelected(new Set());
      setTick(value => value + 1);
    } catch (e) {
      toast.error("无法应用全站模型", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function rebuild(scope: "all" | "incomplete", noteIds?: string[]) {
    const amount = noteIds?.length ?? data?.total ?? 0;
    if (!amount) return;
    if (noteIds && noteIds.length > 500) return toast.error("一次最多量化 500 篇", "请缩小勾选范围，或改用“量化筛选待办 / 重建筛选结果”。");
    if (!await askConfirm({
      title: noteIds?.length ? `量化选中的 ${amount} 篇笔记？` : scope === "all" ? `重建当前筛选的 ${amount} 篇笔记？` : `量化当前筛选中的待办？`,
      description: "操作在后台执行，不修改正文。关闭 AI 可读的笔记也可以预先建立向量，但仍不会被搜索或问答读取。",
      confirmText: scope === "all" ? "加入重建队列" : "开始量化",
    })) return;
    setBusy(true);
    try {
      const result = await api<{ queued: number; skippedUnconfigured: number }>("/api/v1/admin/ai/index/rebuild", {
        method: "POST",
        body: JSON.stringify({ filters: compactFilters(filters), scope, noteIds }),
      });
      toast.success("已加入量化队列", `${result.queued} 篇会处理${result.skippedUnconfigured ? `，${result.skippedUnconfigured} 篇因工作区未配置模型而跳过` : ""}。`);
      setSelected(new Set());
      setTick(value => value + 1);
    } catch (e) {
      toast.error("无法开始量化", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const summary = data?.summary;
  const processing = (summary?.pending ?? 0) + (summary?.running ?? 0);
  const percent = summary?.total ? Math.round((summary.indexed / summary.total) * 100) : 0;
  const statusFilters: Array<{ id: FilterStatus; label: string; count: number }> = [
    { id: "", label: "全部", count: summary?.total ?? 0 },
    { id: "processing", label: "处理中", count: processing },
    { id: "missing", label: "未量化", count: summary?.missing ?? 0 },
    { id: "stale", label: "待更新", count: summary?.stale ?? 0 },
    { id: "failed", label: "失败", count: summary?.failed ?? 0 },
    { id: "indexed", label: "已完成", count: summary?.indexed ?? 0 },
    { id: "pending", label: "排队中", count: summary?.pending ?? 0 },
    { id: "running", label: "正在跑", count: summary?.running ?? 0 },
  ];

  return <div className="space-y-5">
    <section className="overflow-hidden rounded-xl border bg-background shadow-sm">
      <div className="grid gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_minmax(380px,.9fr)] xl:items-start">
        <div>
          <div className="flex items-center gap-2">
            <span className="grid size-9 place-items-center rounded-xl bg-primary/10 text-primary"><Database className="size-4" /></span>
            <div>
              <h2 className="text-base font-semibold">全站量化模型</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">一次配置，覆盖所有工作区、成员和未删除笔记。</p>
            </div>
          </div>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground">量化与读取权限分开：管理员可以预先处理关闭 AI 的内容，但搜索、问答和 MCP 仍严格遵守工作区权限与“AI 可读”开关。</p>
          <div className="mt-5 h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${percent}%` }} />
          </div>
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>{summary?.indexed ?? 0} / {summary?.total ?? 0} 篇已完成</span>
            <span>{percent}%</span>
          </div>
          <div className="mt-4 rounded-lg border border-[color-mix(in_srgb,var(--warning)_25%,transparent)] bg-[color-mix(in_srgb,var(--warning)_6%,transparent)] px-3.5 py-3 text-xs leading-5 text-muted-foreground">
            <p className="font-medium text-foreground">为什么换模型时要让旧向量失效？</p>
            <p className="mt-1">不同 Embedding 模型的维度和语义空间可能不同，混在一起会导致距离不可比较，甚至直接计算失败。只有换渠道或模型时才会清理受影响空间的旧向量；同一模型的普通重建会在新向量生成成功后再替换。重建期间混合搜索仍可使用关键词结果。</p>
          </div>
        </div>
        <div className="grid gap-3 rounded-xl border bg-muted/25 p-4 sm:grid-cols-2">
          <Select label="共享渠道" value={providerId} onChange={changeProvider}>
            <option value="">选择渠道</option>
            {options?.providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>
          <label className="grid gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">Embedding 模型</span>
            <Input list="admin-embedding-models" value={model} onChange={e => setModel(e.target.value)} disabled={!providerId} placeholder={providerId ? "选择或输入模型 ID" : "请先选择渠道"} />
            <datalist id="admin-embedding-models">{provider?.models.map(item => <option key={item} value={item} />)}</datalist>
          </label>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Switch checked={autoEmbed} onCheckedChange={setAutoEmbed} label="自动更新索引" />
            <span className="mr-auto text-xs text-muted-foreground">笔记稳定五分钟后自动更新</span>
            <Button disabled={busy || !providerId || !model.trim()} onClick={() => void applyGlobal()}>
              {busy ? <LoaderCircle className="animate-spin" /> : <Play />}应用到全站并量化
            </Button>
          </div>
        </div>
      </div>
      {!options?.providers.length && <div className="border-t bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] px-5 py-3 text-xs text-muted-foreground">
        <AlertTriangle className="mr-1.5 inline size-3.5 text-[var(--warning)]" />还没有启用的共享模型渠道。请先在任一工作区的“AI 与 MCP”中添加渠道。
      </div>}
    </section>

    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Metric icon={<Database />} label="全部笔记" value={summary?.total ?? 0} hint={`${options?.workspaces.length ?? 0} 个工作区 · ${options?.users.length ?? 0} 名作者`} />
      <Metric icon={<CheckCircle2 />} label="已完成" value={summary?.indexed ?? 0} hint={summary?.total ? `${percent}%` : "0%"} />
      <Metric icon={<Activity />} label="处理中" value={processing} hint={`${summary?.stale ?? 0} 篇待更新 · ${summary?.failed ?? 0} 篇失败`} />
      <Metric icon={<CircleSlash2 />} label="未配置模型" value={summary?.unconfigured ?? 0} hint={`${summary?.missing ?? 0} 篇未量化`} />
    </div>

    <section className="rounded-xl border bg-background shadow-sm">
      <div className="border-b p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-9" value={queryInput} onChange={e => setQueryInput(e.target.value)} placeholder="搜索笔记、工作区、笔记本、成员或邮箱" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void load()}><RefreshCw />刷新</Button>
            {selected.size > 0 && <Button disabled={busy} onClick={() => void rebuild("all", [...selected])}><Play />量化选中 {selected.size} 篇</Button>}
            <Button variant="outline" disabled={busy || !(data?.total)} onClick={() => void rebuild("incomplete")}><Play />量化筛选待办</Button>
            <Button variant="ghost" disabled={busy || !(data?.total)} onClick={() => void rebuild("all")}><RefreshCw />重建筛选结果</Button>
          </div>
        </div>
        <div className="mt-3 flex max-w-full gap-1 overflow-x-auto">
          {statusFilters.map(item => <button key={item.id || "all"} type="button" onClick={() => changeFilter("status", item.id)}
            className={cn("shrink-0 rounded-lg px-3 py-1.5 text-xs transition", filters.status === item.id ? "bg-foreground font-medium text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
            {item.label}<span className="ml-1.5 opacity-70">{item.count}</span>
          </button>)}
        </div>
      </div>

      <div className="grid gap-3 border-b bg-muted/20 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="grid gap-1.5 sm:col-span-2 lg:col-span-4">
          <span className="text-[11px] font-medium text-muted-foreground">缩小工作区 / 成员 / 笔记本选项</span>
          <div className="relative">
            <Filter className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-9" value={optionQuery} onChange={e => setOptionQuery(e.target.value)} placeholder="输入名称、用户名或邮箱，过滤下面三个下拉框" />
          </div>
        </label>
        <Select label="工作区" value={filters.workspaceId} onChange={value => changeFilter("workspaceId", value)}>
          <option value="">全部工作区</option>
          {workspaces.map(item => <option key={item.id} value={item.id}>{item.name} · {item.kind === "personal" ? "个人" : "协作"}（{item.noteCount}）</option>)}
        </Select>
        <Select label="成员 / 作者" value={filters.userId} onChange={value => changeFilter("userId", value)}>
          <option value="">全部成员</option>
          {users.map(item => <option key={item.id} value={item.id}>{item.displayName} @{item.handle}（{item.noteCount}）</option>)}
        </Select>
        <Select label="笔记本" value={filters.notebookId} onChange={value => changeFilter("notebookId", value)}>
          <option value="">全部笔记本</option>
          {notebooks.map(item => <option key={item.id} value={item.id}>{item.title}（{item.noteCount}）</option>)}
        </Select>
        <Select label="模型配置" value={filters.providerState} onChange={value => changeFilter("providerState", value as Filters["providerState"])}>
          <option value="">配置不限</option>
          <option value="configured">已配置</option>
          <option value="unconfigured">未配置</option>
        </Select>
        <Select label="空间类型" value={filters.workspaceKind} onChange={value => changeFilter("workspaceKind", value as Filters["workspaceKind"])}>
          <option value="">类型不限</option>
          <option value="personal">个人空间</option>
          <option value="team">协作空间</option>
        </Select>
        <Select label="笔记 AI 可读" value={filters.aiIndex} onChange={value => changeFilter("aiIndex", value as Filters["aiIndex"])}>
          <option value="">开关不限</option>
          <option value="on">已开启</option>
          <option value="off">已关闭</option>
        </Select>
        <Select label="工作区 AI" value={filters.workspaceAi} onChange={value => changeFilter("workspaceAi", value as Filters["workspaceAi"])}>
          <option value="">开关不限</option>
          <option value="on">已开启</option>
          <option value="off">已关闭</option>
        </Select>
        <Select label="排序" value={filters.sort} onChange={value => changeFilter("sort", value as Filters["sort"])}>
          <option value="updated_desc">最近更新</option>
          <option value="updated_asc">最早更新</option>
          <option value="title_asc">标题 A–Z</option>
          <option value="title_desc">标题 Z–A</option>
        </Select>
        <label className="grid gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">更新开始</span>
          <Input type="date" value={filters.updatedFrom} onChange={e => changeFilter("updatedFrom", e.target.value)} />
        </label>
        <label className="grid gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">更新结束</span>
          <Input type="date" value={filters.updatedTo} onChange={e => changeFilter("updatedTo", e.target.value)} />
        </label>
        <div className="flex items-end gap-2 lg:col-span-2">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Filter className="size-3.5" />
            {filterCount ? `已启用 ${filterCount} 项筛选` : "当前显示全站笔记"}
            {selected.size > 0 ? ` · 已选 ${selected.size} 篇` : ""}
          </span>
          {(filterCount > 0 || selected.size > 0) && <Button className="ml-auto" variant="ghost" size="sm" onClick={() => {
            setFilters(EMPTY_FILTERS); setQueryInput(""); setOptionQuery(""); setPage(1); setSelected(new Set());
          }}><X />清除全部</Button>}
        </div>
      </div>

      <FormError className="m-4">{error}</FormError>
      <div className={cn("min-h-48", loading && "opacity-55")}>
        {loading && !data
          ? <div className="grid min-h-56 place-items-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>
          : !data?.notes.length
            ? <div className="py-16 text-center">
                <FileText className="mx-auto size-8 text-muted-foreground" />
                <p className="mt-3 text-sm font-medium">没有符合条件的笔记</p>
                <p className="mt-1 text-xs text-muted-foreground">调整筛选条件后再试。</p>
              </div>
            : <>
                <div className="hidden grid-cols-[32px_minmax(220px,1.5fr)_minmax(180px,1fr)_minmax(150px,.8fr)_130px_110px] gap-3 border-b bg-muted/30 px-4 py-2.5 text-[11px] font-medium text-muted-foreground xl:grid">
                  <HeaderCheck checked={allPageSelected} indeterminate={somePageSelected && !allPageSelected} onChange={togglePage} />
                  <span>笔记</span><span>位置</span><span>作者 / 权限</span><span>量化状态</span><span className="text-right">操作</span>
                </div>
                {data.notes.map((note, index) => <IndexRow key={note.id} note={note} selected={selected.has(note.id)} first={index === 0} busy={busy}
                  onSelect={() => setSelected(current => { const next = new Set(current); if (next.has(note.id)) next.delete(note.id); else next.add(note.id); return next; })}
                  onRun={() => void rebuild("all", [note.id])} />)}
              </>}
      </div>
      <div className="flex flex-col gap-3 border-t p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">{data?.total ? `第 ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, data.total)} 条，共 ${data.total} 条` : "共 0 条"}</p>
        <div className="flex flex-wrap items-center gap-2">
          <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); setSelected(new Set()); }}
            className="h-9 rounded-lg border border-input bg-background px-3 text-xs">
            {PAGE_SIZES.map(size => <option key={size} value={size}>{size} 条/页</option>)}
          </select>
          <Button variant="outline" size="sm" disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft />上一页</Button>
          <span className="min-w-16 text-center text-xs tabular-nums text-muted-foreground">{page} / {pages}</span>
          <Button variant="outline" size="sm" disabled={loading || page >= pages} onClick={() => setPage(value => value + 1)}>下一页<ChevronRight /></Button>
        </div>
      </div>
    </section>
  </div>;
}

function HeaderCheck({ checked, indeterminate, onChange }: { checked: boolean; indeterminate: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} onChange={onChange} aria-label="选择本页" />;
}

function Metric({ icon, label, value, hint }: { icon: ReactNode; label: string; value: number; hint: string }) {
  return <div className="rounded-xl border bg-background p-4 shadow-sm">
    <div className="flex items-center gap-2 text-muted-foreground">
      <span className="grid size-8 place-items-center rounded-lg bg-muted [&_svg]:size-4">{icon}</span>
      <span className="text-xs">{label}</span>
    </div>
    <p className="mt-3 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
    <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
  </div>;
}

function IndexRow({ note, selected, first, busy, onSelect, onRun }: {
  note: IndexNote; selected: boolean; first: boolean; busy: boolean; onSelect: () => void; onRun: () => void;
}) {
  const meta = STATUS_META[note.status];
  return <div className={cn("grid gap-3 px-4 py-3 xl:grid-cols-[32px_minmax(220px,1.5fr)_minmax(180px,1fr)_minmax(150px,.8fr)_130px_110px] xl:items-center", !first && "border-t")}>
    <input type="checkbox" checked={selected} onChange={onSelect} aria-label={`选择 ${note.title || "无标题"}`} />
    <div className="min-w-0">
      <p className="truncate text-sm font-medium">{note.title || "无标题"}</p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">
        更新于 {formatTime(note.updatedAt)}{note.indexedAt ? ` · 上次量化 ${formatTime(note.indexedAt)}` : ""}{note.chunks ? ` · ${note.chunks} 个向量分块` : ""}
      </p>
      {note.lastError && note.status === "failed" && <p className="mt-1 line-clamp-2 text-xs text-destructive">{note.lastError}</p>}
    </div>
    <div className="min-w-0 text-xs">
      <p className="truncate font-medium">{note.workspaceName}</p>
      <p className="mt-0.5 truncate text-muted-foreground">{note.notebookTitle} · {note.workspaceKind === "personal" ? "个人" : "协作"}</p>
    </div>
    <div className="min-w-0">
      <p className="truncate text-xs font-medium">{note.creatorName} <span className="font-normal text-muted-foreground">@{note.creatorHandle}</span></p>
      <div className="mt-1 flex flex-wrap gap-1">
        <Badge className={note.aiIndex ? "border-[color-mix(in_srgb,var(--good)_30%,transparent)] text-[var(--good)]" : ""}>笔记 AI {note.aiIndex ? "开" : "关"}</Badge>
        <Badge>空间 AI {note.workspaceAiEnabled ? "开" : "关"}</Badge>
      </div>
    </div>
    <div>
      <Badge className={meta.className}>{note.status === "running" && <LoaderCircle className="mr-1 size-3 animate-spin" />}{meta.label}</Badge>
      <p className="mt-1 truncate text-[10px] text-muted-foreground">{note.providerConfigured ? `${note.providerName} · ${note.embeddingModel}` : "未配置模型"}</p>
    </div>
    <div className="text-right">
      <Button variant="ghost" size="sm" disabled={busy || !note.providerConfigured || note.status === "running"} onClick={onRun}>
        <Play />{note.status === "indexed" ? "重建" : "量化"}
      </Button>
    </div>
  </div>;
}

function formatTime(value: string) {
  const date = new Date(value);
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" });
}
