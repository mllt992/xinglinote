import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronLeft, Flag, Pencil, Plus, Scale, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useConfirm, usePrompt } from "./ui/confirm";
import { FormError } from "./ui/form-error";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { useToast } from "./ui/toast";

type Cat = { key: string; label: string };
const DEFAULT_CATS: Cat[] = [
  { key: "politics", label: "涉政敏感" }, { key: "porn", label: "色情低俗" },
  { key: "violence", label: "暴力血腥" }, { key: "abuse", label: "辱骂人身攻击" },
  { key: "illegal", label: "违法违禁" }, { key: "privacy", label: "泄露他人隐私" },
  { key: "ad", label: "垃圾广告与引流" },
];
function readCategories(raw: unknown): Cat[] {
  if (!Array.isArray(raw)) return DEFAULT_CATS.map(c => ({ ...c }));
  const out: Cat[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item === "string") {
      const hit = DEFAULT_CATS.find(c => c.key === item);
      if (hit && !seen.has(hit.key)) { seen.add(hit.key); out.push({ ...hit }); }
    } else if (item && typeof item === "object" && "key" in item && "label" in item) {
      const key = String((item as Cat).key);
      const label = String((item as Cat).label).trim();
      if (key && label && !seen.has(key)) { seen.add(key); out.push({ key, label }); }
    }
  }
  return out;
}
function slugKey(label: string, used: string[]) {
  let base = label.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "cat";
  if (!/^[a-z]/.test(base)) base = `c${base}`;
  let k = base, i = 2;
  while (used.includes(k)) k = `${base}${i++}`;
  return k;
}
const SCENES: Array<[string, string, string]> = [
  ["moderationSquare", "广场动态", "发到首页时间线的公开帖。"],
  ["moderationCircle", "圈子动态", "工作区内部的帖子，只有成员看得到，通常可以不审。"],
  ["moderationArticle", "公开文章", "笔记发布到文档站。发布当场成功，审核中对外不可见；已公开的文章改了正文也会重审，同一篇 60 秒内只审一次。"],
];

function Row({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <div className="flex items-start justify-between gap-4 px-5 py-4">
    <div className="min-w-0"><p className="text-sm font-medium">{title}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></div>
    {children}
  </div>;
}

function Field({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <label className="grid gap-1.5">
    <span className="text-xs font-medium text-muted-foreground">{title}</span>
    {children}
    {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
  </label>;
}

type Config = {
  moderationEnabled: boolean; moderationSquare: boolean; moderationCircle: boolean; moderationArticle: boolean;
  moderationBaseUrl: string; moderationModel: string; moderationApiKey: string; moderationRules: string;
  moderationCategories: Cat[]; moderationThreshold: number; moderationOnError: string;
};

/** 实例管理员配审核：总开关、审哪些场景、用哪个模型、拦什么、多严、模型挂了怎么办。 */
export function ModerationConfig({ settings, onSaved }: { settings: Record<string, unknown>; onSaved: () => void | Promise<void> }) {
  const toast = useToast();
  const ask = usePrompt();
  const askConfirm = useConfirm();
  const keySet = typeof settings.moderationApiKey === "string" && settings.moderationApiKey.length > 0;
  const read = (): Config => ({
    moderationEnabled: !!settings.moderationEnabled,
    moderationSquare: settings.moderationSquare !== false,
    moderationCircle: !!settings.moderationCircle,
    moderationArticle: settings.moderationArticle !== false,
    moderationBaseUrl: String(settings.moderationBaseUrl ?? ""),
    moderationModel: String(settings.moderationModel ?? ""),
    moderationApiKey: "",
    moderationRules: String(settings.moderationRules ?? ""),
    moderationCategories: readCategories(settings.moderationCategories),
    moderationThreshold: Number(settings.moderationThreshold ?? 60),
    moderationOnError: String(settings.moderationOnError ?? "review"),
  });
  const [f, setF] = useState<Config>(read);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { setF(read()); }, [settings]);
  const scenesOn = [f.moderationSquare && "广场", f.moderationCircle && "圈子", f.moderationArticle && "文章"].filter(Boolean).join("、") || "未选手场景";
  const summary = f.moderationEnabled
    ? `已开启 · ${scenesOn}${f.moderationModel ? ` · ${f.moderationModel}` : " · 还没配模型"}`
    : "已关闭，发布不过 AI";

  const toggle = (key: string) => setF(v => ({ ...v, [key]: !v[key as keyof Config] }));
  async function addCategory() {
    const label = await ask({ title: "添加拦截类别", description: "名称会出现在提示词和审核队列里。", label: "类别名称", placeholder: "比如：诈骗引流", confirmText: "添加" });
    if (!label?.trim()) return;
    const name = label.trim().slice(0, 40);
    setF(v => {
      if (v.moderationCategories.some(c => c.label === name)) return v;
      return { ...v, moderationCategories: [...v.moderationCategories, { key: slugKey(name, v.moderationCategories.map(c => c.key)), label: name }] };
    });
  }
  async function editCategory(key: string) {
    const cur = f.moderationCategories.find(c => c.key === key);
    if (!cur) return;
    const label = await ask({ title: "修改类别名称", label: "类别名称", defaultValue: cur.label, confirmText: "保存" });
    if (!label?.trim()) return;
    setF(v => ({ ...v, moderationCategories: v.moderationCategories.map(c => c.key === key ? { ...c, label: label.trim().slice(0, 40) } : c) }));
  }
  async function removeCategory(key: string) {
    const cur = f.moderationCategories.find(c => c.key === key);
    if (!cur) return;
    if (!await askConfirm({ title: `删除「${cur.label}」？`, description: "保存配置后，之后的审核不再拦这一类。已经审过的记录不受影响。", confirmText: "删除", destructive: true })) return;
    setF(v => ({ ...v, moderationCategories: v.moderationCategories.filter(c => c.key !== key) }));
  }

  async function save() {
    setBusy(true); setErr("");
    try {
      const { moderationApiKey, moderationBaseUrl, moderationModel, moderationRules, ...rest } = f;
      await api("/api/v1/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({
          ...rest,
          moderationBaseUrl: moderationBaseUrl.trim() || null,
          moderationModel: moderationModel.trim() || null,
          moderationRules: moderationRules.trim() || null,
          ...(moderationApiKey.trim() ? { moderationApiKey: moderationApiKey.trim() } : {}),
        }),
      });
      await onSaved();
      toast.success("审核配置已保存", f.moderationEnabled ? "新发的内容会先提交成功，再后台过一遍 AI。" : "审核已关闭，之后发布的内容直接公开。");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return <section className="rounded-xl border bg-background">
    <button type="button" className="flex w-full items-center gap-2 px-5 py-3 text-left" onClick={() => setOpen(v => !v)} aria-expanded={open}>
      <ShieldCheck className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">AI 审核配置</span>
        {!open && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{summary}</span>}
      </span>
      <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
    </button>
    {open && <>
    <div className="border-t" />
    <div className="divide-y">
      <Row title="开启内容审核" description="总闸。关掉之后所有发布都不过 AI，已经待审的仍留在下面的队列里等人处理。">
        <Switch label="开启内容审核" checked={f.moderationEnabled} onCheckedChange={() => toggle("moderationEnabled")} />
      </Row>
      {SCENES.map(([key, title, description]) => <Row key={key} title={title} description={description}>
        <Switch label={title} disabled={!f.moderationEnabled} checked={f[key as keyof Config] as boolean} onCheckedChange={() => toggle(key)} />
      </Row>)}
    </div>
    <div className="grid gap-4 border-t px-5 py-5 md:grid-cols-2">
      <Field title="审核模型 Base URL" hint="OpenAI 兼容接口，填到 /v1 为止。审核走实例级配置，和各工作区自己的 AI Key 无关。">
        <Input value={f.moderationBaseUrl} onChange={e => setF({ ...f, moderationBaseUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
      </Field>
      <Field title="模型"><Input value={f.moderationModel} onChange={e => setF({ ...f, moderationModel: e.target.value })} placeholder="gpt-4o-mini" /></Field>
      <Field title="API Key" hint={keySet ? "已配置。留空表示不改。" : "还没配。不配就等于模型不可用，按下面那条处理。"}>
        <Input type="password" autoComplete="new-password" value={f.moderationApiKey} onChange={e => setF({ ...f, moderationApiKey: e.target.value })} placeholder={keySet ? "••••••••" : "sk-…"} />
      </Field>
      <Field title="自动下架的风险分阈值" hint="判定不通过且分数到这个数，就直接以 AI 结果为准，不再转人工。越小越严，默认 60。">
        <Input type="number" min={1} max={100} value={f.moderationThreshold} onChange={e => setF({ ...f, moderationThreshold: Math.min(100, Math.max(1, Number(e.target.value) || 60)) })} />
      </Field>
      <Field title="模型不可用时" hint="超时、报错、没配 Key 都算这种情况。">
        <select className="h-9 rounded-lg border border-input bg-background px-3 text-sm" value={f.moderationOnError} onChange={e => setF({ ...f, moderationOnError: e.target.value })}>
          <option value="review">转人工审核（稳妥）</option>
          <option value="pass">直接放行（不挡发布）</option>
        </select>
      </Field>
      <div className="md:col-span-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">要拦的类别</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void addCategory()}><Plus />添加</Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">这些名称会写进审核提示词。改完记得保存。</p>
        <ul className="mt-2 divide-y rounded-lg border">
          {f.moderationCategories.length === 0 && <li className="px-3 py-3 text-xs text-muted-foreground">还没有类别，审核只按下面的细则判断。</li>}
          {f.moderationCategories.map(c => <li key={c.key} className="flex items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm">{c.label}</span>
            <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={`修改${c.label}`} onClick={() => void editCategory(c.key)}><Pencil /></Button>
            <Button type="button" variant="ghost" size="icon" className="size-8 text-destructive" aria-label={`删除${c.label}`} onClick={() => void removeCategory(c.key)}><Trash2 /></Button>
          </li>)}
        </ul>
      </div>
      <div className="md:col-span-2">
        <Field title="补充审核细则" hint="原样进提示词，优先级高于模型的默认判断。比如「允许讨论公司内部流程」「禁止贴外部群二维码」。">
          <Textarea className="min-h-24" maxLength={4000} value={f.moderationRules} onChange={e => setF({ ...f, moderationRules: e.target.value })} placeholder="每行一条，写清楚放行什么、拦下什么。" />
        </Field>
      </div>
      <div className="md:col-span-2">
        <FormError className="mb-3">{err}</FormError>
        <Button disabled={busy} onClick={save}>{busy ? "保存中…" : "保存审核配置"}</Button>
      </div>
    </div>
    </>}
  </section>;
}

type Item = {
  id: string; targetType: string; targetId: string; scope: string; scopeLabel: string; kind: string;
  workspaceId: string | null; workspaceName: string | null; author: string | null; snapshot: string;
  aiVerdict: string; aiScore: number | null; aiCategories: string[]; aiReason: string | null; aiModel: string | null;
  status: string; reviewer: string | null; reviewNote: string | null; reviewedAt: string | null; createdAt: string;
  reports?: Array<{ reason: string; note: string | null; status: string; createdAt: string }>;
};

const VERDICT_LABEL: Record<string, string> = { pass: "AI 放行", reject: "AI 判定不通过", unsure: "AI 拿不准", error: "AI 没审成", skipped: "未审", queued: "审核中", running: "审核中", report: "用户举报", appeal: "作者申诉" };
const STATUS_LABEL: Record<string, string> = { pending: "待人工审核", approved: "已通过", rejected: "已驳回" };
const KIND_LABEL: Record<string, string> = { publish: "发布预审", report: "用户举报", appeal: "作者申诉" };
const REPORT_LABEL: Record<string, string> = { spam: "垃圾广告", abuse: "辱骂", illegal: "违法", porn: "色情", other: "其他" };
const catLabel = (key: string, catalog: Cat[]) => catalog.find(c => c.key === key)?.label ?? DEFAULT_CATS.find(c => c.key === key)?.label ?? key;
type KindFilter = "all" | "publish" | "report" | "appeal";

function actionsFor(kind: string) {
  if (kind === "report") return { approve: "维持公开", reject: "下架" };
  if (kind === "appeal") return { approve: "恢复公开", reject: "维持下架" };
  return { approve: "通过公开", reject: "驳回" };
}

function KindIcon({ kind, className }: { kind: string; className?: string }) {
  const Icon = kind === "report" ? Flag : kind === "appeal" ? Scale : Sparkles;
  return <Icon className={className} />;
}

function kindTone(kind: string) {
  if (kind === "report") return "border-transparent bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)]";
  if (kind === "appeal") return "border-transparent bg-primary/10 text-primary";
  return "";
}

/** 人工审核队列。不带 workspaceId 是实例管理员看全站，带了就是工作区管理员看自己圈子。 */
export function ModerationQueue({ workspaceId }: { workspaceId?: string }) {
  const toast = useToast();
  const askPrompt = usePrompt();
  const [view, setView] = useState<"pending" | "handled">("pending");
  const [kind, setKind] = useState<KindFilter>("all");
  const [items, setItems] = useState<Item[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pane, setPane] = useState<"list" | "detail">("list");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<Cat[]>(DEFAULT_CATS);

  const selected = items.find(i => i.id === selectedId) ?? items[0] ?? null;

  const load = async (next: "pending" | "handled" = view, nextKind: KindFilter = kind) => {
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (workspaceId) q.set("workspaceId", workspaceId);
      if (next === "handled") q.set("status", "handled");
      if (nextKind !== "all") q.set("kind", nextKind);
      const d = await api<{ items: Item[]; categories?: Cat[] }>(`/api/v1/moderation/queue?${q}`);
      setItems(d.items); if (d.categories) setCatalog(d.categories); setErr("");
      setSelectedId(cur => d.items.some(i => i.id === cur) ? cur : d.items[0]?.id ?? null);
    } catch (e) { setErr((e as Error).message); } finally { setLoading(false); }
  };
  useEffect(() => { void load(view, kind); setPane("list"); }, [view, kind, workspaceId]);

  function pick(id: string) {
    setSelectedId(id);
    setPane("detail");
  }
  function move(delta: number) {
    if (!items.length) return;
    const i = Math.max(0, items.findIndex(x => x.id === selected?.id));
    const next = items[Math.min(items.length - 1, Math.max(0, i + delta))];
    if (next) pick(next.id);
  }

  async function decide(item: Item, action: "approve" | "reject") {
    const labels = actionsFor(item.kind);
    let note: string | null = "";
    if (action === "reject") {
      note = await askPrompt({ title: `${labels.reject}这条${item.scopeLabel}？`, description: "理由会发给作者。留空就用默认说明。", label: "给作者的说明", placeholder: "比如：含有外部推广链接", allowEmpty: true, confirmText: labels.reject, destructive: true });
      if (note === null) return;
    }
    setBusy(item.id);
    try {
      await api(`/api/v1/moderation/${item.id}`, { method: "PATCH", body: JSON.stringify({ action, note: note || undefined }) });
      toast.success(action === "approve" ? `${labels.approve}了，内容按这个结果走` : `${labels.reject}了，作者会收到通知`);
      if (view === "pending") {
        const idx = items.findIndex(i => i.id === item.id);
        const nxt = items[idx + 1] ?? items[idx - 1] ?? null;
        setItems(list => list.filter(i => i.id !== item.id));
        setSelectedId(nxt?.id ?? null);
        if (!nxt) setPane("list");
      } else {
        setItems(list => list.map(i => i.id === item.id ? { ...i, status: action === "approve" ? "approved" : "rejected", reviewer: i.reviewer ?? "管理员", reviewNote: note || i.reviewNote, reviewedAt: new Date().toISOString() } : i));
      }
    } catch (e) { toast.error("操作失败", (e as Error).message); } finally { setBusy(null); }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if ((e.key === "y" || e.key === "Y") && selected && selected.status !== "approved") { e.preventDefault(); void decide(selected, "approve"); }
      else if ((e.key === "n" || e.key === "N") && selected && selected.status !== "rejected") { e.preventDefault(); void decide(selected, "reject"); }
      else if (e.key === "Escape") setPane("list");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const tabCls = (on: boolean) => cn("rounded-md px-3 py-1.5 text-sm transition-colors", on ? "bg-background shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground");
  const emptyHint = view === "pending"
    ? (kind === "report" ? "没有待复核的举报。AI 拿不准的才会出现在这里。" : kind === "appeal" ? "没有待处理的申诉。" : "AI 拿不准或拦下来的内容会出现在这里。")
    : "处理过的记录可以在这里改判，立刻作用到内容上。";
  const labels = selected ? actionsFor(selected.kind) : actionsFor("publish");

  return <section className="overflow-hidden rounded-xl border bg-background">
    <div className="flex flex-wrap items-center gap-3 border-b px-5 py-3">
      <h2 className="text-sm font-semibold">人工审核</h2>
      {view === "pending" && items.length > 0 && <Badge className="border-transparent bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)]">{items.length} 条待审</Badge>}
      <div className="ml-auto inline-flex rounded-lg bg-muted p-1">
        <button type="button" className={tabCls(view === "pending")} onClick={() => setView("pending")}>待审</button>
        <button type="button" className={tabCls(view === "handled")} onClick={() => setView("handled")}>已处理</button>
      </div>
    </div>
    <div className="flex flex-wrap gap-1.5 border-b px-5 py-2.5">
      {([["all", "全部"], ["publish", "发布预审"], ["report", "举报"], ["appeal", "申诉"]] as const).map(([k, label]) => (
        <button key={k} type="button" onClick={() => setKind(k)}
          className={cn("rounded-full px-2.5 py-1 text-xs transition-colors", kind === k ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted")}>
          {label}
        </button>
      ))}
    </div>
    {err && <p className="px-5 py-4 text-sm text-destructive">{err}</p>}
    {!err && loading && <div className="grid gap-3 p-5 lg:grid-cols-[280px_1fr]">{[0, 1].map(i => <div key={i} className="h-40 animate-pulse rounded-lg bg-muted/60" />)}</div>}
    {!err && !loading && items.length === 0 && <div className="py-16 text-center">
      <span className="mx-auto grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground"><ShieldCheck className="size-5" /></span>
      <p className="mt-3 text-sm font-medium">{view === "pending" ? "没有待审内容" : "还没有处理记录"}</p>
      <p className="mt-1 text-xs text-muted-foreground">{emptyHint}</p>
    </div>}
    {!err && !loading && items.length > 0 && selected && <div className="grid min-h-[28rem] lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]">
      <aside className={cn("max-h-[min(70vh,720px)] overflow-y-auto border-b lg:border-b-0 lg:border-r", pane === "detail" && "hidden lg:block")}>
        {items.map(item => {
          const on = item.id === selected.id;
          return <button key={item.id} type="button" onClick={() => pick(item.id)}
            className={cn("block w-full border-l-2 px-4 py-3 text-left transition-colors", on ? "border-primary bg-muted/60" : "border-transparent hover:bg-muted/40")}>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Badge className={cn("gap-1 px-1.5 py-0 text-[10px]", kindTone(item.kind))}><KindIcon kind={item.kind} className="size-2.5" />{KIND_LABEL[item.kind] ?? item.kind}</Badge>
              {item.aiScore !== null && <span className={item.aiScore >= 60 ? "text-[var(--warning)]" : ""}>{item.aiScore}</span>}
              <span className="ml-auto tabular-nums">{new Date(item.createdAt).toLocaleDateString()}</span>
            </div>
            <p className="mt-1 truncate text-sm font-medium">{item.author ?? "已注销用户"}</p>
            <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{item.snapshot}</p>
          </button>;
        })}
      </aside>
      <div className={cn("flex min-h-0 flex-col", pane === "list" && "hidden lg:flex")}>
        <div className="flex items-center gap-2 border-b px-4 py-2.5 lg:hidden">
          <Button variant="ghost" size="sm" onClick={() => setPane("list")}><ChevronLeft />返回列表</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge className={cn("gap-1", kindTone(selected.kind))}><KindIcon kind={selected.kind} className="size-3" />{KIND_LABEL[selected.kind] ?? selected.kind}</Badge>
            <Badge>{selected.scopeLabel}</Badge>
            {selected.workspaceName && <Badge>{selected.workspaceName}</Badge>}
            <span>{selected.author ?? "已注销用户"}</span>
            <span className="ml-auto">{new Date(selected.createdAt).toLocaleString()}</span>
            {selected.status !== "pending" && <Badge>{STATUS_LABEL[selected.status] ?? selected.status}{selected.reviewer ? ` · ${selected.reviewer}` : " · AI 自动"}</Badge>}
          </div>
          {!!selected.reports?.length && <ul className="mt-3 flex flex-wrap gap-1.5">
            {selected.reports.map((r, i) => <li key={i}><Badge>{REPORT_LABEL[r.reason] ?? r.reason}{r.note ? ` · ${r.note}` : ""}</Badge></li>)}
          </ul>}
          <div className="mt-4 rounded-xl bg-muted/45 px-4 py-3">
            <p className="whitespace-pre-wrap text-sm leading-7">{selected.snapshot}</p>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
            <span className={cn("inline-flex items-center gap-1.5", selected.aiVerdict === "pass" ? "text-muted-foreground" : "text-[var(--warning)]")}>
              <AlertTriangle className="size-3.5" />{VERDICT_LABEL[selected.aiVerdict] ?? selected.aiVerdict}{selected.aiScore !== null ? ` · 风险分 ${selected.aiScore}` : ""}
            </span>
            {selected.aiCategories.map(k => <Badge key={k}>{catLabel(k, catalog)}</Badge>)}
            {selected.aiModel && <span className="text-muted-foreground">{selected.aiModel}</span>}
          </div>
          {selected.aiReason && <p className="mt-2 text-sm leading-6 text-muted-foreground">{selected.kind === "appeal" ? "申诉说明" : "AI 说明"}：{selected.aiReason}</p>}
          {selected.reviewNote && <p className="mt-1.5 text-xs text-muted-foreground">人工备注：{selected.reviewNote}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t bg-background/95 px-5 py-3 backdrop-blur">
          <Button size="sm" variant={selected.status === "approved" ? "secondary" : "default"} disabled={busy === selected.id || selected.status === "approved"} onClick={() => void decide(selected, "approve")}><Check />{selected.status === "approved" ? "当前：已公开" : labels.approve}</Button>
          <Button size="sm" variant="outline" className="text-destructive" disabled={busy === selected.id || selected.status === "rejected"} onClick={() => void decide(selected, "reject")}><X />{selected.status === "rejected" ? "当前：已下架" : labels.reject}</Button>
          <span className="ml-auto hidden text-[11px] text-muted-foreground sm:inline">J / K 换条 · Y 通过 · N 驳回</span>
        </div>
      </div>
    </div>}
  </section>;
}
