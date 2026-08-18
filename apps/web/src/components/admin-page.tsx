import { useEffect, useState, type ReactNode, type SelectHTMLAttributes } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import * as Avatar from "@radix-ui/react-avatar";
import {
  Ban, Check, ChevronRight, Copy, Download, HardDrive, KeyRound, LayoutGrid, MoreHorizontal,
  Plus, Search, Shield, Sparkles, Ticket, Trash2, UserCog, Users, X,
} from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useConfirm } from "./ui/confirm";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { FormError } from "./ui/form-error";
import { Input } from "./ui/input";
import { useToast } from "./ui/toast";

type Tab = "overview" | "registration" | "codes" | "users";
type AdminUser = { id: string; displayName: string; email: string; handle: string; roleInstance: string; status: string; createdAt?: string };
type AdminCode = { id: string; prefix: string; usedCount: number; maxUses: number; status: string; note?: string | null; expiresAt?: string | null; createdAt?: string; skipEmailVerification?: boolean; bindRole?: string | null };
type Overview = {
  userCount: number; workspaceCount: number; adminCount: number; codeCount: number; activeCodeCount: number;
  recentUsers: AdminUser[]; settings: Record<string, boolean | number | string | null>;
};
type PageResult<T> = T & { total: number; page: number; pageSize: number };

const TABS: { id: Tab; label: string; hint: string; icon: typeof LayoutGrid }[] = [
  { id: "overview", label: "概览", hint: "规模与关键开关", icon: LayoutGrid },
  { id: "registration", label: "注册策略", hint: "谁能进来、能做什么", icon: Shield },
  { id: "codes", label: "注册码", hint: "批量发放一次性准入", icon: Ticket },
  { id: "users", label: "用户", hint: "封禁、角色与状态", icon: Users },
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

const STORAGE_OPTIONS = [
  { value: 536870912, label: "512 MB" },
  { value: 1073741824, label: "1 GB" },
  { value: 2147483648, label: "2 GB" },
  { value: 5368709120, label: "5 GB" },
  { value: 10737418240, label: "10 GB" },
];

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

function Switch({ checked, onCheckedChange, disabled, label }: { checked: boolean; onCheckedChange: (next: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onCheckedChange(!checked)}
    className={cn("relative h-6 w-10 shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50", checked ? "bg-primary" : "bg-muted ring-1 ring-inset ring-border")}>
    <span className={cn("pointer-events-none absolute top-0.5 left-0.5 block size-5 rounded-full bg-background shadow-sm transition-transform", checked && "translate-x-4")} />
  </button>;
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
  const [codes, setCodes] = useState<AdminCode[]>([]);
  const [total, setTotal] = useState(0);
  const [newCodes, setNewCodes] = useState<string[]>([]);
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
    if (qInput === q) return;
    const t = window.setTimeout(() => patch({ q: qInput.trim() || undefined, page: undefined }), 300);
    return () => window.clearTimeout(t);
  }, [qInput]);

  useEffect(() => {
    if (tab !== "users" && tab !== "codes") return;
    let cancelled = false;
    setListLoading(true);
    setListError("");
    const path = tab === "users"
      ? `/api/v1/admin/users${qs({ q, role, status, page, pageSize })}`
      : `/api/v1/admin/registration-codes${qs({ q, status, bindRole, skipEmailVerification: skip || undefined, page, pageSize })}`;
    api<PageResult<{ users?: AdminUser[]; codes?: AdminCode[] }>>(path)
      .then(d => {
        if (cancelled) return;
        if (d.total > 0 && d.page > 1 && (d.users?.length ?? d.codes?.length ?? 0) === 0) {
          patch({ page: String(Math.max(1, Math.ceil(d.total / d.pageSize))) });
          return;
        }
        setUsers(d.users ?? []);
        setCodes(d.codes ?? []);
        setTotal(d.total);
      })
      .catch(e => { if (!cancelled) setListError((e as Error).message); })
      .finally(() => { if (!cancelled) setListLoading(false); });
    return () => { cancelled = true; };
  }, [tab, q, role, status, bindRole, skip, page, pageSize, listTick]);

  const current = TABS.find(t => t.id === tab)!;
  const filtering = !!(q || role || status || bindRole || skip);
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
    await navigator.clipboard.writeText(text);
    setCopied(id);
    window.setTimeout(() => setCopied(cur => cur === id ? null : cur), 1500);
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
      setNewCodes(d.codes);
      toast.success(`已生成 ${d.codes.length} 个注册码`, "明文只显示这一次，离开或刷新后无法再看。");
      patch({ page: undefined, q: undefined, status: undefined, bindRole: undefined, skip: undefined });
      setListTick(n => n + 1);
      await loadOverview();
    } catch (e) {
      setFormErr((e as Error).message);
    } finally {
      setPending(null);
    }
  }

  async function revoke(code: AdminCode) {
    if (!await askConfirm({ title: `作废 ${code.prefix}…？`, description: "作废后不能再用这组码注册。已经用过的账号不受影响。", confirmText: "作废", destructive: true })) return;
    try {
      await api(`/api/v1/admin/registration-codes/${code.id}`, { method: "DELETE" });
      toast.success("注册码已作废");
      setListTick(n => n + 1);
      await loadOverview();
    } catch (e) {
      toast.error("作废失败", (e as Error).message);
    }
  }

  async function patchUser(user: AdminUser, body: Record<string, string>, okText: string) {
    try {
      await api(`/api/v1/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify(body) });
      toast.success(okText);
      setListTick(n => n + 1);
      await loadOverview();
    } catch (e) {
      toast.error("操作失败", (e as Error).message);
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

    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-8 lg:flex-row lg:gap-10">
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
            <Stat icon={<HardDrive className="size-4" />} label="默认容量" value={STORAGE_OPTIONS.find(o => o.value === Number(overview?.settings?.defaultUserStorageBytes ?? 1073741824))?.label ?? "1 GB"} hint="未单独覆盖的用户" />
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
          <section className="flex flex-col gap-4 rounded-xl border bg-background p-5 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">默认用户存储容量</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">新用户和未单独覆盖的账号使用此限制。已有覆盖不受影响。</p>
            </div>
            <Select className="w-full sm:w-36" disabled={pending === "storage"} value={Number(overview?.settings?.defaultUserStorageBytes ?? 1073741824)}
              onChange={e => void patchSetting({ defaultUserStorageBytes: Number(e.target.value) }, "storage", "默认容量已更新")}>
              {STORAGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </section>
        </div>}

        {!error && !loading && tab === "codes" && <div className="space-y-5">
          <section className="rounded-xl border bg-background p-5">
            <div className="mb-4 flex items-start gap-3">
              <span className="grid size-9 place-items-center rounded-lg bg-muted"><KeyRound className="size-4" /></span>
              <div>
                <h2 className="text-sm font-semibold">生成注册码</h2>
                <p className="mt-1 text-xs text-muted-foreground">明文只在当次返回。请立刻复制或下载，刷新后只剩前缀。</p>
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
              <p className="flex-1 text-sm font-medium">仅本次显示，请立即保存</p>
              <Button variant="outline" size="sm" onClick={() => void copyText(newCodes.join("\n"), "all")}>{copied === "all" ? <Check /> : <Copy />}{copied === "all" ? "已复制" : "复制全部"}</Button>
              <Button variant="outline" size="sm" onClick={() => downloadCsv(newCodes)}><Download />下载 CSV</Button>
            </div>
            <ul className="space-y-1.5">{newCodes.map(code => <li key={code} className="flex items-center gap-2 rounded-lg bg-background/80 px-3 py-2">
              <code className="min-w-0 flex-1 truncate font-mono text-sm">{code}</code>
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
              <div className="hidden grid-cols-[1fr_88px_88px_1fr_40px] gap-3 border-b bg-muted/40 px-5 py-2.5 text-xs font-medium text-muted-foreground sm:grid">
                <span>前缀</span><span>用量</span><span>状态</span><span>备注</span><span />
              </div>
              {codes.map((c, i) => <div key={c.id} className={cn("grid items-center gap-2 px-5 py-3.5 sm:grid-cols-[1fr_88px_88px_1fr_40px] sm:gap-3", i && "border-t")}>
                <div className="min-w-0">
                  <code className="text-sm">{c.prefix}…</code>
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
                  ? <Button variant="ghost" size="icon" className="text-destructive" aria-label={`作废 ${c.prefix}`} onClick={() => void revoke(c)}><Trash2 /></Button>
                  : <span />}
              </div>)}
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
            ]}
            filtering={filtering}
            onClear={() => { setQInput(""); patch({ q: undefined, role: undefined, status: undefined, page: undefined }); }}
          />
          <FormError>{listError}</FormError>
          {usersList.length === 0 && !listLoading ? <Empty icon={<Users />} title={filtering ? "没有匹配的用户" : "还没有用户"} text={filtering ? "换个关键词或筛选项再试。" : "第一个注册的人会成为实例管理员。"} />
            : <section className={cn("overflow-hidden rounded-xl border bg-background", listLoading && "opacity-60")}>
              {usersList.map((u, i) => <div key={u.id} className={cn("flex items-center gap-3 px-4 py-3.5", i && "border-t")}>
                <UserRow user={u} />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`${u.displayName} 的操作`}><MoreHorizontal /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => {
                      void (async () => {
                        const promote = u.roleInstance !== "admin";
                        if (!await askConfirm({
                          title: promote ? `将 ${u.displayName} 提升为管理员？` : `将 ${u.displayName} 降为普通用户？`,
                          description: promote ? "对方将能进入实例后台，管理注册策略、注册码和所有用户。" : "对方将失去实例后台权限。实例必须至少保留一名有效管理员。",
                          confirmText: promote ? "提升" : "降级",
                          destructive: !promote,
                        })) return;
                        await patchUser(u, { roleInstance: promote ? "admin" : "user" }, promote ? "已提升为管理员" : "已降为普通用户");
                      })();
                    }}><UserCog />{u.roleInstance === "admin" ? "降为普通用户" : "提升为管理员"}</DropdownMenuItem>
                    <DropdownMenuItem className="text-destructive" onSelect={() => {
                      void (async () => {
                        const ban = u.status !== "banned";
                        if (!await askConfirm({
                          title: ban ? `封禁 ${u.displayName}？` : `解除 ${u.displayName} 的封禁？`,
                          description: ban ? "对方会立刻被踢下线，无法再登录。其写过的共享笔记会留下。" : "对方可以重新登录，会话需要重新建立。",
                          confirmText: ban ? "封禁" : "解封",
                          destructive: ban,
                        })) return;
                        await patchUser(u, { status: ban ? "banned" : "active" }, ban ? "已封禁并踢出会话" : "已解除封禁");
                      })();
                    }}><Ban />{u.status === "banned" ? "解除封禁" : "封禁并踢出会话"}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>)}
            </section>}
          <Pager page={page} pages={pages} pageSize={pageSize} total={total} loading={listLoading} onPage={p => patch({ page: String(p) })} onSize={s => patch({ size: String(s), page: undefined })} />
        </div>}
      </main>
    </div>
  </div>;
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

function UserRow({ user }: { user: AdminUser }) {
  return <div className="flex min-w-0 flex-1 items-center gap-3">
    <Avatar.Root className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-xs font-semibold text-background">
      <Avatar.Fallback>{user.displayName.slice(0, 1)}</Avatar.Fallback>
    </Avatar.Root>
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-medium">{user.displayName} <span className="font-normal text-muted-foreground">@{user.handle}</span></p>
      <p className="truncate text-xs text-muted-foreground">{user.email}</p>
    </div>
    <StatusBadge status={user.roleInstance} />
    <StatusBadge status={user.status} />
  </div>;
}

function Empty({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return <div className="rounded-xl border bg-background py-16 text-center">
    <span className="mx-auto grid size-12 place-items-center rounded-xl bg-muted text-muted-foreground">{icon}</span>
    <p className="mt-4 text-sm font-medium">{title}</p>
    <p className="mt-1 text-xs text-muted-foreground">{text}</p>
  </div>;
}
