import { useEffect, useState, type ReactNode, type SelectHTMLAttributes } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  BellRing, BookOpen, Bot, Check, ChevronRight, CloudUpload, Compass, Copy, Download, Database, ExternalLink, Image, Inbox, KeyRound, LayoutGrid,
  Plus, Search, Shield, ShieldCheck, Sparkles, Ticket, Trash2, Users, X,
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
import { AgentsPanel } from "./agents-panel";
import { ModerationConfig, ModerationQueue } from "./moderation-panel";
import { PushConfig } from "./push-admin-panel";
import { SmtpConfig } from "./smtp-panel";
import { NavAdmin } from "./nav-admin";
import { BackupPanel } from "./backup-panel";
import { AdminAiIndex } from "./admin-ai-index";
import { RequestRow, StorageBar, UserActions, UserDetailDialog, UserRow, type AdminRequest, type AdminUser } from "./admin-users";
import { STORAGE_PRESETS } from "../lib/bytes";

type Tab = "overview" | "registration" | "moderation" | "agents" | "index" | "notifications" | "codes" | "users" | "requests" | "nav" | "help" | "backup";
type AdminCode = { id: string; prefix: string; code?: string | null; usedCount: number; maxUses: number; status: string; note?: string | null; expiresAt?: string | null; createdAt?: string; skipEmailVerification?: boolean; bindRole?: string | null };
type Overview = {
  userCount: number; workspaceCount: number; adminCount: number; codeCount: number; activeCodeCount: number;
  recentUsers: AdminUser[]; settings: Record<string, boolean | number | string | null>;
  pendingModerationCount?: number; pendingServiceRequestCount?: number;
};
type PageResult<T> = T & { total: number; page: number; pageSize: number };

const TABS: { id: Tab; label: string; hint: string; icon: typeof LayoutGrid }[] = [
  { id: "overview", label: "概览", hint: "规模与关键开关", icon: LayoutGrid },
  { id: "registration", label: "注册策略", hint: "谁能进来、能做什么", icon: Shield },
  { id: "moderation", label: "内容审核", hint: "AI 先审，拿不准再转人工", icon: ShieldCheck },
  { id: "agents", label: "智能体", hint: "创建可被动态 @ 的 AI 助手", icon: Bot },
  { id: "index", label: "量化管理", hint: "全站笔记向量索引与批量重建", icon: Database },
  { id: "notifications", label: "通知与推送", hint: "SMTP、VAPID 密钥与推送总开关", icon: BellRing },
  { id: "nav", label: "导航", hint: "分组、站点与自动取图标", icon: Compass },
  { id: "help", label: "帮助文档", hint: "选择内置指南或连接自己的帮助站", icon: BookOpen },
  { id: "backup", label: "实例备份", hint: "打包用户与配置，上传到 WebDAV 或 S3", icon: CloudUpload },
  { id: "codes", label: "注册码", hint: "批量发放一次性准入", icon: Ticket },
  { id: "users", label: "用户", hint: "配额、角色与封禁", icon: Users },
  { id: "requests", label: "服务申请", hint: "审批扩容，直接看到用量", icon: Inbox },
];

const SETTING_GROUPS: { title: string; items: { key: string; title: string; description: string }[] }[] = [
  {
    title: "准入",
    items: [
      { key: "allowOpenRegistration", title: "开放注册", description: "任何人都能用邮箱自行创建账号。关闭后只能凭注册码进入。" },
      { key: "allowCodeRegistration", title: "允许注册码", description: "关闭后已发出的码立刻失效，适合临时封口。" },
      { key: "requireEmailVerification", title: "要求验证邮箱", description: "未验证的账号不能进入系统。SMTP 未配置时不要打开，否则新人会卡在验证页。" },
    ],
  },
  {
    title: "功能",
    items: [
      { key: "allowUserCreateWorkspace", title: "允许用户创建工作区", description: "关闭后只有实例管理员能新建协作区，个人工作区不受影响。" },
      { key: "squareEnabled", title: "开启广场", description: "首页时间线与公开动态。关闭后广场对所有人不可见。" },
      { key: "aiEnabled", title: "开启 AI", description: "全站总闸。关闭后各工作区的模型配置与问答入口一并停用。" },
    ],
  },
];

const STORAGE_OPTIONS = STORAGE_PRESETS.filter(o => o.value <= 10_737_418_240);
const MCP_IMAGE_OPTIONS = [1, 2, 3, 5, 8, 10, 15, 25].map(mb => ({ value: mb * 1048576, label: `${mb} MB` }));

const STATUS_LABEL: Record<string, string> = {
  active: "正常", banned: "已封禁", pending_deletion: "注销中", pending_verification: "待验证",
  revoked: "已作废", exhausted: "已用完", expired: "已过期", admin: "管理员", user: "成员",
};

const USER_ROLES = [{ value: "", label: "全部角色" }, { value: "admin", label: "管理员" }, { value: "user", label: "成员" }];
const USER_STATUSES = [
  { value: "", label: "全部状态" }, { value: "active", label: "正常" }, { value: "banned", label: "已封禁" },
  { value: "pending_verification", label: "待验证" }, { value: "pending_deletion", label: "注销中" },
];
const CODE_STATUSES = [
  { value: "", label: "全部状态" }, { value: "active", label: "有效" }, { value: "revoked", label: "已作废" },
  { value: "exhausted", label: "已用完" }, { value: "expired", label: "已过期" },
];
const CODE_SKIP = [{ value: "", label: "验证要求不限" }, { value: "true", label: "免邮箱验证" }, { value: "false", label: "需验证邮箱" }];
const CODE_ROLES = [{ value: "", label: "绑定角色不限" }, { value: "admin", label: "Admin" }, { value: "editor", label: "Editor" }, { value: "viewer", label: "Viewer" }];
const PAGE_SIZES = [20, 50];
const CODE_CACHE_KEY = "kb:registration-codes";
const LAST_CODES_KEY = "kb:last-registration-codes";

function isFullRegistrationCode(value: string) {
  return /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){4}$/.test(value);
}

function readCodeCache(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(CODE_CACHE_KEY) ?? "{}") as Record<string, string>;
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => isFullRegistrationCode(v)));
  } catch {
    return {};
  }
}

function readLastCodes(): string[] {
  try {
    return (JSON.parse(sessionStorage.getItem(LAST_CODES_KEY) ?? "[]") as unknown[])
      .filter((v): v is string => typeof v === "string" && isFullRegistrationCode(v));
  } catch {
    return [];
  }
}

function resolveCode(c: AdminCode, cache: Record<string, string>) {
  if (c.code && isFullRegistrationCode(c.code)) return c.code;
  if (isFullRegistrationCode(c.prefix)) return c.prefix;
  return cache[c.prefix] ?? "";
}

function isTab(value: string | null): value is Tab {
  return TABS.some(t => t.id === value);
}

function statusTone(status: string) {
  if (status === "active" || status === "admin") return "border-transparent bg-[color-mix(in_srgb,var(--good)_12%,transparent)] text-[var(--good)]";
  if (status === "banned" || status === "revoked") return "border-transparent bg-destructive/10 text-destructive";
  if (status === "pending_deletion" || status === "exhausted" || status === "expired") return "border-transparent bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)]";
  return undefined;
}

function StatusBadge({ status }: { status: string }) {
  return <Badge className={statusTone(status)}>{STATUS_LABEL[status] ?? status}</Badge>;
}

function Field({ title, children }: { title: string; children: ReactNode }) {
  return <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">{title}</span>{children}</label>;
}

function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn("h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20", className)} {...props} />;
}

function qs(params: Record<string, string | number | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

function downloadCsv(codes: string[]) {
  const blob = new Blob([`code\n${codes.join("\n")}\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `registration-codes-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function AdminPage() {
  const nav = useNavigate();
  const toast = useToast();
  const askConfirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const tab: Tab = isTab(params.get("tab")) ? params.get("tab") as Tab : "overview";
  const q = params.get("q") ?? "";
  const role = params.get("role") ?? "";
  const status = params.get("status") ?? "";
  const bindRole = params.get("bindRole") ?? "";
  const skip = params.get("skip") ?? "";
  const pendingOnly = params.get("pending") ?? "";
  const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
  const pageSize = PAGE_SIZES.includes(Number(params.get("size"))) ? Number(params.get("size")) : 20;

  const go = (next: Tab) => setParams(next === "overview" ? {} : { tab: next }, { replace: true });
  const patch = (next: Record<string, string | undefined>) => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (!v) merged.delete(k);
      else merged.set(k, v);
    }
    if (merged.get("page") === "1") merged.delete("page");
    if (merged.get("size") === "20") merged.delete("size");
    setParams(merged, { replace: true });
  };

  const [overview, setOverview] = useState<Overview | null>(null);
  const [usersList, setUsers] = useState<AdminUser[]>([]);
  const [requests, setRequests] = useState<AdminRequest[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [codes, setCodes] = useState<AdminCode[]>([]);
  const [total, setTotal] = useState(0);
  const [newCodes, setNewCodes] = useState<string[]>(readLastCodes);
  const [knownCodes, setKnownCodes] = useState<Record<string, string>>(readCodeCache);
  const [qInput, setQInput] = useState(q);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [form, setForm] = useState({ quantity: 5, maxUses: 1, expiresInDays: 30, note: "" });
  const [formErr, setFormErr] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [listTick, setListTick] = useState(0);

  const loadOverview = async () => {
    const o = await api<Overview>("/api/v1/admin/overview");
    setOverview(o);
  };

  useEffect(() => {
    setLoading(true);
    loadOverview().then(() => setError("")).catch(e => setError((e as Error).message)).finally(() => setLoading(false));
  }, []);

  useEffect(() => { setQInput(q); }, [q, tab]);

  useEffect(() => {
    cacheCodes(codes.flatMap(c => c.code ? [c.code] : []));
  }, [codes]);

  useEffect(() => {
    if (qInput === q) return;
    const t = window.setTimeout(() => patch({ q: qInput.trim() || undefined, page: undefined }), 300);
    return () => window.clearTimeout(t);
  }, [qInput]);

  useEffect(() => {
    if (tab !== "users" && tab !== "codes" && tab !== "requests") return;
    let cancelled = false;
    setListLoading(true);
    setListError("");
    const path = tab === "users"
      ? `/api/v1/admin/users${qs({ q, role, status, hasPending: pendingOnly || undefined, page, pageSize })}`
      : tab === "requests"
        ? `/api/v1/admin/service-requests${qs({ q, status: ["pending", "approved", "rejected", "cancelled"].includes(status) ? status : "pending", page, pageSize })}`
        : `/api/v1/admin/registration-codes${qs({ q, status, bindRole, skipEmailVerification: skip || undefined, page, pageSize })}`;
    api<PageResult<{ users?: AdminUser[]; codes?: AdminCode[]; requests?: AdminRequest[] }>>(path)
      .then(d => {
        if (cancelled) return;
        if (d.total > 0 && d.page > 1 && (d.users?.length ?? d.codes?.length ?? d.requests?.length ?? 0) === 0) {
          patch({ page: String(Math.max(1, Math.ceil(d.total / d.pageSize))) });
          return;
        }
        setUsers(d.users ?? []);
        setCodes(d.codes ?? []);
        setRequests(d.requests ?? []);
        setTotal(d.total);
      })
      .catch(e => { if (!cancelled) setListError((e as Error).message); })
      .finally(() => { if (!cancelled) setListLoading(false); });
    return () => { cancelled = true; };
  }, [tab, q, role, status, bindRole, skip, pendingOnly, page, pageSize, listTick]);

  const current = TABS.find(t => t.id === tab)!;
  const filtering = !!(q || role || status || bindRole || skip || pendingOnly);
  const pages = Math.max(1, Math.ceil(total / pageSize));

  async function patchSetting(body: Record<string, boolean | number>, key: string, okText?: string) {
    setPending(key);
    try {
      await api("/api/v1/admin/settings", { method: "PATCH", body: JSON.stringify(body) });
      await loadOverview();
      if (okText) toast.success(okText);
    } catch (e) {
      toast.error("更新失败", (e as Error).message);
    } finally {
      setPending(null);
    }
  }

  async function copyText(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied(cur => cur === id ? null : cur), 1500);
    } catch (e) {
      toast.error("复制失败", (e as Error).message);
    }
  }

  function cacheCodes(codesToKeep: string[]) {
    const full = codesToKeep.filter(isFullRegistrationCode);
    if (!full.length) return full;
    setKnownCodes(prev => {
      const next = { ...prev };
      for (const code of full) next[code.slice(0, 9)] = code;
      localStorage.setItem(CODE_CACHE_KEY, JSON.stringify(next));
      return next;
    });
    return full;
  }

  function rememberCodes(codesToKeep: string[]) {
    const full = cacheCodes(codesToKeep);
    if (!full.length) return;
    setNewCodes(full);
    sessionStorage.setItem(LAST_CODES_KEY, JSON.stringify(full));
  }

  async function generate() {
    setFormErr("");
    setPending("codes");
    try {
      const d = await api<{ codes: string[] }>("/api/v1/admin/registration-codes", {
        method: "POST",
        body: JSON.stringify({
          quantity: form.quantity,
          maxUses: form.maxUses,
          expiresInDays: form.expiresInDays || null,
          note: form.note.trim() || "后台生成",
        }),
      });
      rememberCodes(d.codes);
      toast.success(`已生成 ${d.codes.length} 个注册码`, "可立即复制。刷新后仍可在本浏览器复制。");
      patch({ page: undefined, q: undefined, status: undefined, bindRole: undefined, skip: undefined });
      setListTick(n => n + 1);
      await loadOverview();
    } catch (e) {
      setFormErr((e as Error).message);
    } finally {
      setPending(null);
    }
  }

  async function replaceCodes(targets: AdminCode[]) {
    const rows = targets.filter(c => c.status === "active" && !resolveCode(c, knownCodes));
    if (!rows.length) return;
    if (!await askConfirm({
      title: rows.length === 1 ? `作废 ${rows[0]!.prefix}… 并换一张新码？` : `把 ${rows.length} 条旧码换成可复制的新码？`,
      description: "旧码立刻失效，已经用过的账号不受影响。新码会显示完整明文，可直接复制。",
      confirmText: "换新码",
    })) return;
    setPending("replace");
    try {
      const fresh: string[] = [];
      for (const row of rows) {
        const days = row.expiresAt ? Math.max(1, Math.ceil((new Date(row.expiresAt).getTime() - Date.now()) / 86400000)) : form.expiresInDays;
        const d = await api<{ codes: string[] }>("/api/v1/admin/registration-codes", {
          method: "POST",
          body: JSON.stringify({
            quantity: 1,
            maxUses: row.maxUses,
            expiresInDays: days || null,
            note: row.note || "后台生成",
            bindRole: row.bindRole || undefined,
            skipEmailVerification: !!row.skipEmailVerification,
          }),
        });
        fresh.push(...d.codes);
        await api(`/api/v1/admin/registration-codes/${row.id}`, { method: "DELETE" });
      }
      rememberCodes(fresh);
      toast.success(fresh.length === 1 ? `新码 ${fresh[0]}` : `已换出 ${fresh.length} 个新码`, "可以复制了。");
      setListTick(n => n + 1);
      await loadOverview();
    } catch (e) {
      toast.error("换新失败", (e as Error).message);
    } finally {
      setPending(null);
    }
  }

  async function revoke(code: AdminCode) {
    if (!await askConfirm({ title: `作废 ${code.code ?? `${code.prefix}…`}？`, description: "作废后不能再用这组码注册。已经用过的账号不受影响。", confirmText: "作废", destructive: true })) return;
    try {
      await api(`/api/v1/admin/registration-codes/${code.id}`, { method: "DELETE" });
      toast.success("注册码已作废");
      setListTick(n => n + 1);
      await loadOverview();
    } catch (e) {
      toast.error("作废失败", (e as Error).message);
    }
  }

  return <div className="min-h-full bg-muted/25">
    <header className="sticky top-0 z-20 flex h-14 items-center border-b border-border bg-background/90 px-4 backdrop-blur">
      <Button variant="ghost" onClick={() => nav("/app")}><ChevronRight className="rotate-180" />返回工作区</Button>
      <div className="ml-auto flex items-center gap-2.5 font-semibold tracking-[-0.03em]">
        <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground"><Sparkles className="size-3.5" /></span>
        <span>Knowledge</span>
      </div>
    </header>

    <div className={cn("mx-auto flex flex-col gap-6 px-5 py-8 lg:flex-row lg:gap-10", tab === "index" ? "max-w-[88rem]" : "max-w-6xl")}>
      <aside className="shrink-0 lg:w-52">
        <div className="mb-4 hidden lg:block">
          <p className="text-lg font-semibold tracking-[-0.03em]">实例后台</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">管理本站的准入、用户与功能开关。</p>
        </div>
        <nav className="-mx-1 flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0" aria-label="实例后台">
          {TABS.map(item => {
            const Icon = item.icon;
            const active = item.id === tab;
            return <button key={item.id} type="button" onClick={() => go(item.id)}
              className={cn("flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50", active ? "bg-background font-medium shadow-sm ring-1 ring-border" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
              <Icon className="size-4" />
              {item.label}
            </button>;
          })}
        </nav>
      </aside>

      <main className="min-w-0 flex-1">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-[-0.035em]">{current.label}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">{current.hint}</p>
        </div>

        {error && <div className="rounded-xl border bg-background p-8 text-center">
          <p className="text-sm font-medium">无法打开实例后台</p>
          <p className="mt-1 text-xs text-muted-foreground">{error}</p>
          <Button className="mt-4" variant="outline" onClick={() => { setLoading(true); loadOverview().then(() => setError("")).catch(e => setError((e as Error).message)).finally(() => setLoading(false)); }}>重试</Button>
        </div>}

        {!error && loading && <div className="grid gap-3 sm:grid-cols-2">{[0, 1, 2, 3].map(i => <div key={i} className="h-28 animate-pulse rounded-xl border bg-muted/60" />)}</div>}

        {!error && !loading && tab === "overview" && <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat icon={<Users className="size-4" />} label="用户" value={overview?.userCount ?? 0} hint={`${overview?.adminCount ?? 0} 名管理员`} />
            <Stat icon={<LayoutGrid className="size-4" />} label="工作区" value={overview?.workspaceCount ?? 0} hint="含个人工作区" />
            <Stat icon={<Ticket className="size-4" />} label="有效注册码" value={overview?.activeCodeCount ?? 0} hint={`共发出 ${overview?.codeCount ?? 0} 组`} />
            <button type="button" className="text-left" onClick={() => go("requests")}>
              <Stat icon={<Inbox className="size-4" />} label="待审批申请" value={overview?.pendingServiceRequestCount ?? 0} hint="点进去审批" />
            </button>
          </div>
          <section className="rounded-xl border bg-background">
            <div className="flex items-center justify-between border-b px-5 py-3">
              <h2 className="text-sm font-semibold">当前策略</h2>
              <Button variant="ghost" size="sm" onClick={() => go("registration")}>去调整</Button>
            </div>
            <div className="grid gap-px bg-border sm:grid-cols-3">
              {[
                ["开放注册", !!overview?.settings?.allowOpenRegistration],
                ["注册码", !!overview?.settings?.allowCodeRegistration],
                ["邮箱验证", !!overview?.settings?.requireEmailVerification],
                ["自建工作区", !!overview?.settings?.allowUserCreateWorkspace],
                ["广场", !!overview?.settings?.squareEnabled],
                ["AI", !!overview?.settings?.aiEnabled],
                ["内容审核", !!overview?.settings?.moderationEnabled],
                ["导航", overview?.settings?.navEnabled !== false],
                ["导航公开", overview?.settings?.navPublic !== false],
                ["申请扩容", overview?.settings?.allowStorageRequests !== false],
              ].map(([label, on]) => <div key={String(label)} className="flex items-center justify-between bg-background px-5 py-3.5">
                <span className="text-sm">{label}</span>
                <Badge className={on ? statusTone("active") : undefined}>{on ? "开" : "关"}</Badge>
              </div>)}
            </div>
          </section>
          <section className="overflow-hidden rounded-xl border bg-background">
            <div className="flex items-center justify-between border-b px-5 py-3">
              <h2 className="text-sm font-semibold">最近注册</h2>
              <Button variant="ghost" size="sm" onClick={() => go("users")}>全部用户</Button>
            </div>
            {!overview?.recentUsers.length
              ? <p className="px-5 py-10 text-center text-sm text-muted-foreground">还没有用户。</p>
              : overview.recentUsers.map((u, i) => <div key={u.id} className={cn("px-5 py-3.5", i && "border-t")}><UserRow user={u} /></div>)}
          </section>
        </div>}

        {!error && !loading && tab === "notifications" && <div className="space-y-6">
          <SmtpConfig key={String(overview?.settings?.smtpHost ?? "")} settings={overview?.settings ?? {}} onSaved={loadOverview} />
          <PushConfig settings={overview?.settings ?? {}} onSaved={loadOverview} />
        </div>}

        {!error && !loading && tab === "moderation" && <div className="space-y-6">
          <ModerationConfig settings={overview?.settings ?? {}} onSaved={loadOverview} />
          <ModerationQueue />
        </div>}

        {!error && !loading && tab === "agents" && <AgentsPanel />}

        {!error && !loading && tab === "index" && <AdminAiIndex />}

        {!error && !loading && tab === "nav" && <NavAdmin settings={overview?.settings ?? {}} onSaved={loadOverview} />}

        {!error && !loading && tab === "help" && <HelpConfig settings={overview?.settings ?? {}} onSaved={loadOverview} />}

        {!error && !loading && tab === "backup" && <BackupPanel />}

        {!error && !loading && tab === "registration" && <div className="space-y-5">
          {SETTING_GROUPS.map(group => <section key={group.title} className="overflow-hidden rounded-xl border bg-background">
            <h2 className="border-b bg-muted/40 px-5 py-3 text-sm font-semibold">{group.title}</h2>
            {group.items.map((item, i) => <div key={item.key} className={cn("flex items-start gap-4 px-5 py-4", i && "border-t")}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{item.title}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.description}</p>
              </div>
              <Switch checked={!!overview?.settings?.[item.key]} disabled={pending === item.key} label={item.title}
                onCheckedChange={v => void patchSetting({ [item.key]: v }, item.key)} />
            </div>)}
          </section>)}
          <section className="overflow-hidden rounded-xl border bg-background">
            <h2 className="border-b bg-muted/40 px-5 py-3 text-sm font-semibold">存储</h2>
            <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">默认用户存储容量</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">新用户和未单独覆盖的账号使用此限制。已有覆盖不受影响。</p>
              </div>
              <Select className="w-full sm:w-36" disabled={pending === "storage"} value={Number(overview?.settings?.defaultUserStorageBytes ?? 1073741824)}
                onChange={e => void patchSetting({ defaultUserStorageBytes: Number(e.target.value) }, "storage", "默认容量已更新")}>
                {STORAGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </div>
            <div className="flex items-start gap-4 border-t px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">允许用户申请扩容</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">关闭后用户看不到申请入口。已经提交的申请你仍可以批。</p>
              </div>
              <Switch checked={overview?.settings?.allowStorageRequests !== false} disabled={pending === "allowStorageRequests"} label="允许用户申请扩容"
                onCheckedChange={v => void patchSetting({ allowStorageRequests: v }, "allowStorageRequests")} />
            </div>
          </section>
          <section className="flex flex-col gap-4 rounded-xl border bg-background p-5 sm:flex-row sm:items-center">
            <span className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground"><Image className="size-4"/></span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">MCP 单张图片上限</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">Agent 用 upload_image 传图时的体积顶。默认 5 MB；不要开太大，MCP 走 JSON base64，体积大约会再涨三分之一。</p>
            </div>
            <Select className="w-full sm:w-36" disabled={pending === "mcpImage"} value={Number(overview?.settings?.mcpImageMaxBytes ?? 5242880)}
              onChange={e => void patchSetting({ mcpImageMaxBytes: Number(e.target.value) }, "mcpImage", "MCP 图片上限已更新")}>
              {MCP_IMAGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </section>
        </div>}

        {!error && !loading && tab === "codes" && <div className="space-y-5">
          <section className="rounded-xl border bg-background p-5">
            <div className="mb-4 flex items-start gap-3">
              <span className="grid size-9 place-items-center rounded-lg bg-muted"><KeyRound className="size-4" /></span>
              <div>
                <h2 className="text-sm font-semibold">生成注册码</h2>
                <p className="mt-1 text-xs text-muted-foreground">生成后可在列表里随时复制。发给要加入的人即可，不要发到公开场合。</p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field title="数量"><Input type="number" min={1} max={200} value={form.quantity} onChange={e => setForm({ ...form, quantity: Number(e.target.value) })} /></Field>
              <Field title="每码可用次数"><Input type="number" min={1} max={1000} value={form.maxUses} onChange={e => setForm({ ...form, maxUses: Number(e.target.value) })} /></Field>
              <Field title="有效天数"><Input type="number" min={1} max={3650} value={form.expiresInDays} onChange={e => setForm({ ...form, expiresInDays: Number(e.target.value) })} /></Field>
              <Field title="备注"><Input value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder="家庭邀请、内测…" /></Field>
            </div>
            <FormError className="mt-3">{formErr}</FormError>
            <Button className="mt-4" disabled={pending === "codes"} onClick={() => void generate()}><Plus />{pending === "codes" ? "生成中…" : `生成 ${form.quantity} 个注册码`}</Button>
          </section>

          {newCodes.length > 0 && <section className="rounded-xl border border-primary/20 bg-primary/5 p-5">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <p className="flex-1 text-sm font-medium">刚生成的注册码</p>
              <Button variant="outline" size="sm" onClick={() => void copyText(newCodes.join("\n"), "all")}>{copied === "all" ? <Check /> : <Copy />}{copied === "all" ? "已复制" : "复制全部"}</Button>
              <Button variant="outline" size="sm" onClick={() => downloadCsv(newCodes)}><Download />下载 CSV</Button>
            </div>
            <ul className="space-y-1.5">{newCodes.map(code => <li key={code} className="flex items-center gap-2 rounded-lg bg-background/80 px-3 py-2">
              <code className="min-w-0 flex-1 break-all font-mono text-sm">{code}</code>
              <Button variant="ghost" size="icon" aria-label={`复制 ${code}`} onClick={() => void copyText(code, code)}>{copied === code ? <Check /> : <Copy />}</Button>
            </li>)}</ul>
          </section>}

          <FilterBar
            placeholder="搜索前缀或备注"
            value={qInput}
            onChange={setQInput}
            filters={[
              { label: "状态", value: status, options: CODE_STATUSES, onChange: v => patch({ status: v, page: undefined }) },
              { label: "验证", value: skip, options: CODE_SKIP, onChange: v => patch({ skip: v, page: undefined }) },
              { label: "绑定角色", value: bindRole, options: CODE_ROLES, onChange: v => patch({ bindRole: v, page: undefined }) },
            ]}
            filtering={filtering}
            onClear={() => { setQInput(""); patch({ q: undefined, status: undefined, skip: undefined, bindRole: undefined, page: undefined }); }}
          />
          <FormError>{listError}</FormError>
          {codes.length === 0 && !listLoading ? <Empty icon={<Ticket />} title={filtering ? "没有匹配的注册码" : "还没有注册码"} text={filtering ? "换个关键词或筛选项再试。" : "关掉开放注册后，用注册码把家人或同事请进来。"} />
            : <section className={cn("overflow-hidden rounded-xl border bg-background", listLoading && "opacity-60")}>
              {(() => {
                const rows = codes.map(c => ({ c, full: resolveCode(c, knownCodes) }));
                const stale = rows.filter(x => x.c.status === "active" && !x.full).map(x => x.c);
                const copyable = rows.flatMap(x => x.full ? [x.full] : []);
                return <>
              {(copyable.length > 0 || stale.length > 0) && <div className="flex flex-wrap items-center justify-end gap-2 border-b px-5 py-2">
                {stale.length > 0 && <Button variant="outline" size="sm" disabled={pending === "replace"} onClick={() => void replaceCodes(stale)}>{pending === "replace" ? "更换中…" : `把 ${stale.length} 条旧码换成可复制的新码`}</Button>}
                {copyable.length > 0 && <Button variant="ghost" size="sm" onClick={() => void copyText(copyable.join("\n"), "page")}>{copied === "page" ? <Check /> : <Copy />}{copied === "page" ? "已复制本页" : "复制本页"}</Button>}
              </div>}
              {stale.length > 0 && <p className="border-b px-5 py-2 text-xs text-muted-foreground">这几条是升级前发的，库里只剩前缀，完整明文补不回来。换新后即可复制。</p>}
              <div className="hidden grid-cols-[minmax(0,1.6fr)_72px_80px_1fr_40px] gap-3 border-b bg-muted/40 px-5 py-2.5 text-xs font-medium text-muted-foreground sm:grid">
                <span>注册码</span><span>用量</span><span>状态</span><span>备注</span><span />
              </div>
              {rows.map(({ c, full }, i) => <div key={c.id} className={cn("grid items-center gap-2 px-5 py-3.5 sm:grid-cols-[minmax(0,1.6fr)_72px_80px_1fr_40px] sm:gap-3", i && "border-t")}>
                <div className="min-w-0">
                  <div className="flex items-center gap-1">
                    <code className="min-w-0 flex-1 break-all font-mono text-sm">{full || `${c.prefix}…`}</code>
                    {full
                      ? <Button variant="ghost" size="icon" className="size-8" aria-label={`复制 ${full}`} onClick={() => void copyText(full, c.id)}>{copied === c.id ? <Check /> : <Copy />}</Button>
                      : c.status === "active"
                        ? <Button variant="outline" size="sm" disabled={pending === "replace"} onClick={() => void replaceCodes([c])}>换新码</Button>
                        : null}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground sm:hidden">{c.usedCount}/{c.maxUses} · {STATUS_LABEL[c.status] ?? c.status}</p>
                </div>
                <span className="hidden text-sm tabular-nums text-muted-foreground sm:block">{c.usedCount}/{c.maxUses}</span>
                <span className="hidden sm:block"><StatusBadge status={c.status} /></span>
                <p className="truncate text-xs text-muted-foreground">
                  {c.note || "无备注"}
                  {c.bindRole ? ` · 绑定 ${c.bindRole}` : ""}
                  {c.skipEmailVerification ? " · 免验证" : ""}
                  {c.expiresAt ? ` · ${new Date(c.expiresAt).toLocaleDateString()} 到期` : ""}
                </p>
                {c.status === "active"
                  ? <Button variant="ghost" size="icon" className="text-destructive" aria-label={`作废 ${full || c.prefix}`} onClick={() => void revoke(c)}><Trash2 /></Button>
                  : <span />}
              </div>)}
                </>;
              })()}
            </section>}
          <Pager page={page} pages={pages} pageSize={pageSize} total={total} loading={listLoading} onPage={p => patch({ page: String(p) })} onSize={s => patch({ size: String(s), page: undefined })} />
        </div>}

        {!error && !loading && tab === "users" && <div className="space-y-4">
          <FilterBar
            placeholder="搜索显示名、用户名或邮箱"
            value={qInput}
            onChange={setQInput}
            filters={[
              { label: "角色", value: role, options: USER_ROLES, onChange: v => patch({ role: v, page: undefined }) },
              { label: "状态", value: status, options: USER_STATUSES, onChange: v => patch({ status: v, page: undefined }) },
              { label: "申请", value: pendingOnly, options: [{ value: "", label: "全部用户" }, { value: "true", label: "有待审批" }], onChange: v => patch({ pending: v, page: undefined }) },
            ]}
            filtering={filtering}
            onClear={() => { setQInput(""); patch({ q: undefined, role: undefined, status: undefined, pending: undefined, page: undefined }); }}
          />
          <FormError>{listError}</FormError>
          {usersList.length === 0 && !listLoading ? <Empty icon={<Users />} title={filtering ? "没有匹配的用户" : "还没有用户"} text={filtering ? "换个关键词或筛选项再试。" : "第一个注册的人会成为实例管理员。"} />
            : <section className={cn("overflow-hidden rounded-xl border bg-background", listLoading && "opacity-60")}>
              {usersList.map((u, i) => <div key={u.id} className={cn("flex items-center gap-3 px-4 py-3.5", i && "border-t")}>
                <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setDetailId(u.id)}>
                  <UserRow user={u} extra={u.storage ? <StorageBar used={u.storage.usedBytes} quota={u.storage.quotaBytes} compact /> : undefined} />
                </button>
                <UserActions user={u} onChanged={() => { setListTick(n => n + 1); void loadOverview(); }} onOpen={() => setDetailId(u.id)} />
              </div>)}
            </section>}
          <Pager page={page} pages={pages} pageSize={pageSize} total={total} loading={listLoading} onPage={p => patch({ page: String(p) })} onSize={s => patch({ size: String(s), page: undefined })} />
          <UserDetailDialog userId={detailId} open={!!detailId} onOpenChange={v => { if (!v) setDetailId(null); }} onChanged={() => { setListTick(n => n + 1); void loadOverview(); }} />
        </div>}

        {!error && !loading && tab === "requests" && <div className="space-y-4">
          <FilterBar
            placeholder="搜索申请人显示名、用户名或邮箱"
            value={qInput}
            onChange={setQInput}
            filters={[
              { label: "状态", value: ["pending", "approved", "rejected", "cancelled"].includes(status) ? status : "pending", options: [
                { value: "pending", label: "待审批" }, { value: "approved", label: "已通过" },
                { value: "rejected", label: "未通过" }, { value: "cancelled", label: "已取消" },
              ], onChange: v => patch({ status: v === "pending" ? undefined : v, page: undefined }) },
            ]}
            filtering={!!(q || (status && status !== "pending"))}
            onClear={() => { setQInput(""); patch({ q: undefined, status: undefined, page: undefined }); }}
          />
          <FormError>{listError}</FormError>
          {requests.length === 0 && !listLoading ? <Empty icon={<Inbox />} title={q || status ? "没有匹配的申请" : "没有待审批的申请"} text={q || status ? "换个关键词或状态再试。" : "用户在「存储与服务」里提交的扩容会出现在这里。"} />
            : <section className={cn("overflow-hidden rounded-xl border bg-background", listLoading && "opacity-60")}>
              {requests.map((r, i) => <div key={r.id} className={i ? "border-t" : undefined}>
                <RequestRow request={r} onChanged={() => { setListTick(n => n + 1); void loadOverview(); }} />
              </div>)}
            </section>}
          <Pager page={page} pages={pages} pageSize={pageSize} total={total} loading={listLoading} onPage={p => patch({ page: String(p) })} onSize={s => patch({ size: String(s), page: undefined })} />
        </div>}
      </main>
    </div>
  </div>;
}

function HelpConfig({ settings, onSaved }: { settings: Record<string, boolean | number | string | null>; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [source, setSource] = useState<"builtin" | "external">(settings.helpSource === "external" ? "external" : "builtin");
  const [url, setUrl] = useState(typeof settings.helpUrl === "string" ? settings.helpUrl : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    const helpUrl = url.trim();
    if (source === "external") {
      try {
        const parsed = new URL(helpUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
      } catch {
        setError("请输入以 http:// 或 https:// 开头的完整地址");
        return;
      }
    }
    setError("");
    setSaving(true);
    try {
      await api("/api/v1/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({ helpSource: source, helpUrl: helpUrl || null }),
      });
      await onSaved();
      toast.success("帮助文档配置已保存", source === "external" ? "用户将从新标签页打开外部帮助站。" : "用户将打开站内内置帮助。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return <section className="overflow-hidden rounded-xl border bg-background">
    <div className="border-b bg-muted/40 px-5 py-3">
      <h2 className="text-sm font-semibold">帮助入口</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">用户从头像菜单点“帮助文档”时，按这里的选择打开。</p>
    </div>
    <div className="space-y-5 p-5">
      <Field title="文档来源">
        <Select value={source} onChange={e => { setSource(e.target.value as "builtin" | "external"); setError(""); }}>
          <option value="builtin">内置帮助</option>
          <option value="external">外部帮助站</option>
        </Select>
      </Field>
      {source === "builtin"
        ? <div className="rounded-lg border bg-muted/30 px-4 py-3">
            <p className="text-sm font-medium">使用站内帮助</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">无需额外部署，升级应用时内容会一起更新。地址为 <code>/help</code>。</p>
          </div>
        : <Field title="外部帮助文档地址">
            <Input value={url} onChange={e => { setUrl(e.target.value); setError(""); }} placeholder="https://docs.example.com" inputMode="url" />
          </Field>}
      {source === "external" && url.trim() && <a className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline" href={url.trim()} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-3.5" />预览外部帮助站</a>}
      <FormError>{error}</FormError>
      <Button disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存配置"}</Button>
    </div>
  </section>;
}

function FilterBar({ placeholder, value, onChange, filters, filtering, onClear }: {
  placeholder: string; value: string; onChange: (v: string) => void;
  filters: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }[];
  filtering: boolean; onClear: () => void;
}) {
  return <div className="flex flex-col gap-3">
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input className="pl-9" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
    </div>
    <div className="flex flex-wrap items-center gap-2">
      {filters.map(f => <Select key={f.label} className="w-auto min-w-28" aria-label={f.label} value={f.value} onChange={e => f.onChange(e.target.value)}>
        {f.options.map(o => <option key={o.value || "all"} value={o.value}>{o.label}</option>)}
      </Select>)}
      {filtering && <Button variant="ghost" size="sm" onClick={onClear}><X />清除筛选</Button>}
    </div>
  </div>;
}

function Pager({ page, pages, pageSize, total, loading, onPage, onSize }: {
  page: number; pages: number; pageSize: number; total: number; loading: boolean;
  onPage: (page: number) => void; onSize: (size: number) => void;
}) {
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return <div className="flex flex-wrap items-center justify-between gap-3">
    <p className="text-xs text-muted-foreground">第 {from}–{to} 条，共 {total} 条</p>
    <div className="flex flex-wrap items-center gap-2">
      <Select className="w-auto" aria-label="每页条数" value={pageSize} onChange={e => onSize(Number(e.target.value))}>
        {PAGE_SIZES.map(n => <option key={n} value={n}>{n} 条/页</option>)}
      </Select>
      <Button variant="outline" size="sm" disabled={loading || page <= 1} onClick={() => onPage(page - 1)}>上一页</Button>
      <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">{page} / {pages}</span>
      <Button variant="outline" size="sm" disabled={loading || page >= pages} onClick={() => onPage(page + 1)}>下一页</Button>
    </div>
  </div>;
}

function Stat({ icon, label, value, hint }: { icon: ReactNode; label: string; value: ReactNode; hint: string }) {
  return <div className="rounded-xl border bg-background p-5">
    <div className="flex items-center gap-2 text-muted-foreground">
      <span className="grid size-8 place-items-center rounded-lg bg-muted">{icon}</span>
      <span className="text-sm">{label}</span>
    </div>
    <p className="mt-4 text-3xl font-semibold tracking-[-0.04em]">{value}</p>
    <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
  </div>;
}

function Empty({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return <div className="rounded-xl border bg-background py-16 text-center">
    <span className="mx-auto grid size-12 place-items-center rounded-xl bg-muted text-muted-foreground">{icon}</span>
    <p className="mt-4 text-sm font-medium">{title}</p>
    <p className="mt-1 text-xs text-muted-foreground">{text}</p>
  </div>;
}
