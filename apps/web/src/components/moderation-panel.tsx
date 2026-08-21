import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Check, ShieldCheck, X } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { usePrompt } from "./ui/confirm";
import { FormError } from "./ui/form-error";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { useToast } from "./ui/toast";

/** key 要和后端 lib/moderation.ts 的 MODERATION_CATEGORIES 对上。 */
const CATEGORIES: Array<[string, string]> = [
  ["politics", "涉政敏感"], ["porn", "色情低俗"], ["violence", "暴力血腥"], ["abuse", "辱骂人身攻击"],
  ["illegal", "违法违禁"], ["privacy", "泄露他人隐私"], ["ad", "垃圾广告与引流"],
];
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
  moderationCategories: string[]; moderationThreshold: number; moderationOnError: string;
};

/** 实例管理员配审核：总开关、审哪些场景、用哪个模型、拦什么、多严、模型挂了怎么办。 */
export function ModerationConfig({ settings, onSaved }: { settings: Record<string, unknown>; onSaved: () => void | Promise<void> }) {
  const toast = useToast();
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
    moderationCategories: Array.isArray(settings.moderationCategories) ? settings.moderationCategories.map(String) : [],
    moderationThreshold: Number(settings.moderationThreshold ?? 60),
    moderationOnError: String(settings.moderationOnError ?? "review"),
  });
  const [f, setF] = useState<Config>(read);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { setF(read()); }, [settings]);

  const toggle = (key: string) => setF(v => ({ ...v, [key]: !v[key as keyof Config] }));
  const flipCategory = (key: string) => setF(v => ({ ...v, moderationCategories: v.moderationCategories.includes(key) ? v.moderationCategories.filter(k => k !== key) : [...v.moderationCategories, key] }));

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
    <div className="flex items-center gap-2 border-b px-5 py-3"><ShieldCheck className="size-4" /><h2 className="text-sm font-semibold">AI 审核</h2></div>
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
      <Field title="转人工的风险分阈值" hint="模型给的风险分到这个数就转人工。越小越严，默认 60。">
        <Input type="number" min={1} max={100} value={f.moderationThreshold} onChange={e => setF({ ...f, moderationThreshold: Math.min(100, Math.max(1, Number(e.target.value) || 60)) })} />
      </Field>
      <Field title="模型不可用时" hint="超时、报错、没配 Key 都算这种情况。">
        <select className="h-9 rounded-lg border border-input bg-background px-3 text-sm" value={f.moderationOnError} onChange={e => setF({ ...f, moderationOnError: e.target.value })}>
          <option value="review">转人工审核（稳妥）</option>
          <option value="pass">直接放行（不挡发布）</option>
        </select>
      </Field>
      <div className="md:col-span-2">
        <p className="text-xs font-medium text-muted-foreground">要拦的类别</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {CATEGORIES.map(([key, label]) => {
            const on = f.moderationCategories.includes(key);
            return <button key={key} type="button" onClick={() => flipCategory(key)}
              className={cn("rounded-full border px-3 py-1.5 text-xs transition-colors", on ? "border-transparent bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}>
              {label}
            </button>;
          })}
        </div>
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
  </section>;
}

type Item = {
  id: string; targetType: string; targetId: string; scope: string; scopeLabel: string;
  workspaceId: string | null; workspaceName: string | null; author: string | null; snapshot: string;
  aiVerdict: string; aiScore: number | null; aiCategories: string[]; aiReason: string | null; aiModel: string | null;
  status: string; reviewer: string | null; reviewNote: string | null; reviewedAt: string | null; createdAt: string;
};

const VERDICT_LABEL: Record<string, string> = { pass: "AI 放行", reject: "AI 判定不通过", error: "AI 没审成", skipped: "未审", queued: "审核中", running: "审核中", report: "用户举报" };
const STATUS_LABEL: Record<string, string> = { pending: "待人工审核", approved: "已通过", rejected: "已驳回" };
const catLabel = (key: string) => CATEGORIES.find(([k]) => k === key)?.[1] ?? key;

/** 人工审核队列。不带 workspaceId 是实例管理员看全站，带了就是工作区管理员看自己圈子。 */
export function ModerationQueue({ workspaceId }: { workspaceId?: string }) {
  const toast = useToast();
  const askPrompt = usePrompt();
  const [view, setView] = useState<"pending" | "handled">("pending");
  const [items, setItems] = useState<Item[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async (next: "pending" | "handled" = view) => {
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (workspaceId) q.set("workspaceId", workspaceId);
      if (next === "handled") q.set("status", "handled");
      const d = await api<{ items: Item[] }>(`/api/v1/moderation/queue?${q}`);
      setItems(d.items); setErr("");
    } catch (e) { setErr((e as Error).message); } finally { setLoading(false); }
  };
  useEffect(() => { void load(view); }, [view, workspaceId]);

  async function decide(item: Item, action: "approve" | "reject") {
    let note: string | null = "";
    if (action === "reject") {
      note = await askPrompt({ title: `驳回这条${item.scopeLabel}？`, description: "理由会发给作者。留空就用默认说明。", label: "驳回理由", placeholder: "比如：含有外部推广链接", allowEmpty: true, confirmText: "驳回", destructive: true });
      if (note === null) return;
    }
    setBusy(item.id);
    try {
      await api(`/api/v1/moderation/${item.id}`, { method: "PATCH", body: JSON.stringify({ action, note: note || undefined }) });
      toast.success(action === "approve" ? "已通过，内容正常展示了" : "已驳回，作者会收到通知");
      // 审完就把这一行撤下去。重拉整个队列会把列表整个换成骨架，处理一条闪一次，越审越难受。
      setItems(list => list.filter(i => i.id !== item.id));
    } catch (e) { toast.error("操作失败", (e as Error).message); } finally { setBusy(null); }
  }

  const tabCls = (on: boolean) => cn("rounded-md px-3 py-1.5 text-sm transition-colors", on ? "bg-background shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground");

  return <section className="rounded-xl border bg-background">
    <div className="flex flex-wrap items-center gap-3 border-b px-5 py-3">
      <h2 className="text-sm font-semibold">人工审核</h2>
      {view === "pending" && items.length > 0 && <Badge className="border-transparent bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)]">{items.length} 条待审</Badge>}
      <div className="ml-auto inline-flex rounded-lg bg-muted p-1">
        <button type="button" className={tabCls(view === "pending")} onClick={() => setView("pending")}>待审</button>
        <button type="button" className={tabCls(view === "handled")} onClick={() => setView("handled")}>已处理</button>
      </div>
    </div>
    {err && <p className="px-5 py-4 text-sm text-destructive">{err}</p>}
    {!err && loading && <div className="space-y-2 p-5">{[0, 1].map(i => <div key={i} className="h-24 animate-pulse rounded-lg bg-muted/60" />)}</div>}
    {!err && !loading && items.length === 0 && <div className="py-12 text-center">
      <span className="mx-auto grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground"><ShieldCheck className="size-5" /></span>
      <p className="mt-3 text-sm font-medium">{view === "pending" ? "没有待审内容" : "还没有处理记录"}</p>
      <p className="mt-1 text-xs text-muted-foreground">{view === "pending" ? "AI 拦下来的内容会出现在这里，等人拍板。" : "AI 自动放行的也记在这里，方便回看它都放过了什么。"}</p>
    </div>}
    {!err && !loading && items.length > 0 && <div className="divide-y">
      {items.map(item => <article key={item.id} className="px-5 py-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge>{item.scopeLabel}</Badge>
          {item.workspaceName && <Badge>{item.workspaceName}</Badge>}
          <span>{item.author ?? "已注销用户"}</span>
          <span>{new Date(item.createdAt).toLocaleString()}</span>
          {item.status !== "pending" && <Badge>{STATUS_LABEL[item.status] ?? item.status}{item.reviewer ? ` · ${item.reviewer}` : " · AI 自动"}</Badge>}
        </div>
        <p className="mt-2.5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-3 text-sm leading-6">{item.snapshot}</p>
        <p className="mt-2.5 flex flex-wrap items-center gap-2 text-xs">
          <span className={cn("inline-flex items-center gap-1.5", item.aiVerdict === "pass" ? "text-muted-foreground" : "text-[var(--warning)]")}>
            <AlertTriangle className="size-3.5" />{VERDICT_LABEL[item.aiVerdict] ?? item.aiVerdict}{item.aiScore !== null ? ` · 风险分 ${item.aiScore}` : ""}
          </span>
          {item.aiCategories.map(k => <Badge key={k}>{catLabel(k)}</Badge>)}
          {item.aiModel && <span className="text-muted-foreground">{item.aiModel}</span>}
        </p>
        {item.aiReason && <p className="mt-1.5 text-xs text-muted-foreground">AI 说明：{item.aiReason}</p>}
        {item.reviewNote && <p className="mt-1.5 text-xs text-muted-foreground">人工备注：{item.reviewNote}</p>}
        {item.status === "pending" && <div className="mt-3 flex gap-2">
          <Button size="sm" disabled={busy === item.id} onClick={() => void decide(item, "approve")}><Check />通过</Button>
          <Button size="sm" variant="outline" className="text-destructive" disabled={busy === item.id} onClick={() => void decide(item, "reject")}><X />驳回</Button>
        </div>}
      </article>)}
    </div>}
  </section>;
}
