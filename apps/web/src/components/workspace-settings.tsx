import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Archive, ArrowUpRight, Bot, CalendarDays, Check, CircleCheck, CloudUpload, Copy, Crown,
  Download, FileClock, FileText, Link2, LoaderCircle, LogOut, MoreHorizontal, Notebook, Paperclip, Pencil,
  Plus, Search, ShieldAlert, Snowflake, Sparkles, Trash2, TriangleAlert, UserPlus, Users, X,
} from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";
import { AuditPanel, BackupPanel, DangerPanel, SharesPanel, TransferPanel } from "./manage-panels";
import { ModerationQueue } from "./moderation-panel";
import { SettingsShell, cardCls } from "./settings-shell";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useConfirm } from "./ui/confirm";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { FormError } from "./ui/form-error";
import { Input } from "./ui/input";
import { useToast } from "./ui/toast";
import { UserAvatar } from "./user-avatar";

/* ---------------------------------- 类型 ---------------------------------- */

type Member = { userId: string; handle: string; displayName: string; avatarUrl?: string | null; email: string; status: string; role: string; joinedAt: string; noteCount: number };
type MembersData = { kind: string; ownerId: string; frozen: boolean; myRole: string; canManage: boolean; myUserId: string; members: Member[] };
type Invite = { id: string; tokenPrefix: string; role: string; expiresAt: string; maxUses: number | null; usedCount: number; status: string; createdAt: string; createdByName: string };
type Overview = {
  workspace: { id: string; name: string; slug: string; kind: string; frozen: boolean; deletionScheduledAt: string | null; createdAt: string; ownerName: string; ownerHandle: string };
  myRole: string; canManage: boolean;
  roles: Record<string, number>;
  stats: { members: number; notebooks: number; notes: number; notesActive7d: number; attachments: number; attachmentBytes: number; mcpActive: number; activeInvites: number; trashedNotes: number };
  shares: { active: number; expiringSoon: number; noPassword: number };
  siteRequests: number;
  backup: { targets: number; scheduled: number; lastRunAt: string | null; lastStatus: string | null } | null;
  recentAudit: Array<{ id: string; action: string; result: string; actorType: string; createdAt: string; actorName: string | null }>;
};

/** 这一页自己负责的分区。回收站、AI 与 MCP、外观也在同一个左栏里，但它们是独立路由，见 settings-shell。 */
type SectionId = "overview" | "members" | "shares" | "backup" | "transfer" | "audit" | "moderation" | "danger";

const SECTION_IDS: SectionId[] = ["overview", "members", "shares", "backup", "transfer", "audit", "moderation", "danger"];
const MANAGER_ONLY: SectionId[] = ["backup", "audit", "moderation", "danger"];

const ROLES = ["admin", "editor", "viewer"] as const;
const ROLE_ORDER = ["owner", "admin", "editor", "viewer"];
const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", editor: "Editor", viewer: "Viewer" };
const ROLE_HINT: Record<string, string> = {
  owner: "工作区主人，可转让、可注销，唯一且不可被移除",
  admin: "能管成员、分享、备份与冻结，不能注销工作区",
  editor: "能读写笔记与日程，管不了人和对外链接",
  viewer: "只读：能看能搜，不能改任何内容",
};
const AUDIT_LABEL: Record<string, string> = {
  "workspace.freeze": "冻结工作区", "workspace.unfreeze": "解冻工作区", "workspace.rename": "改工作区名字",
  "workspace.restore": "从导出文件恢复", "workspace.invite_revoke": "作废邀请链接", "workspace.member_leave": "成员主动退出",
  "backup.run": "执行备份", "backup.test": "测试备份连接", "backup.target_create": "新增备份目标",
};

const selectCls = "h-9 shrink-0 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20";

const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
const day = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }) : "—";
const relative = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 2592000000) return `${Math.floor(diff / 86400000)} 天前`;
  return day(iso);
};
const daysLeft = (iso: string) => Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);

/* --------------------------------- 页面外壳 -------------------------------- */

/**
 * 工作区设置：把原来分开的「成员管理」和「工作区管理」并成一页。
 * 分成两页的代价是每次都要先想「这事算管人还是管区」——邀请链接、退出工作区、
 * 冻结前先看看还有谁在，本来就是同一件事的两头。
 */
export function WorkspaceSettings() {
  const { wsId = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [membersData, setMembers] = useState<MembersData | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const canManage = overview?.canManage ?? false;
  const allowed = SECTION_IDS.filter(id => canManage || !MANAGER_ONLY.includes(id));
  const raw = params.get("tab");
  const tab = (allowed.includes(raw as SectionId) ? raw : "overview") as SectionId;

  const loadMembers = useCallback(async () => {
    const d = await api<MembersData>(`/api/v1/workspaces/${wsId}/members`);
    setMembers(d);
    setInvites(d.canManage && d.kind !== "personal" ? (await api<{ invites: Invite[] }>(`/api/v1/workspaces/${wsId}/invites`)).invites : []);
  }, [wsId]);
  const loadOverview = useCallback(async () => { setOverview(await api<Overview>(`/api/v1/workspaces/${wsId}/overview`)); }, [wsId]);
  const reload = useCallback(async () => { await Promise.all([loadOverview(), loadMembers()]); }, [loadOverview, loadMembers]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    reload().then(() => alive && setError("")).catch(e => alive && setError((e as Error).message)).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [reload]);

  const go = useCallback((id: SectionId) => {
    setParams(id === "overview" ? {} : { tab: id }, { replace: true });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [setParams]);

  const ws = overview?.workspace;
  const personal = ws?.kind === "personal";
  const counts = {
    members: overview?.stats.members ?? 0,
    shares: overview?.shares.active ?? 0,
    backup: overview?.backup?.targets ?? 0,
    trash: overview?.stats.trashedNotes ?? 0,
  };

  return <SettingsShell
    wsId={wsId} current={tab} counts={counts}
    workspace={overview && ws ? { id: ws.id, name: ws.name, kind: ws.kind, role: overview.myRole, frozen: ws.frozen } : null}
    loading={loading} error={error}
    onRetry={() => { setLoading(true); reload().then(() => setError("")).catch(e => setError((e as Error).message)).finally(() => setLoading(false)); }}
  >
    {overview && ws && <>
      {tab === "overview" && <OverviewSection overview={overview} onGo={go} onRenamed={loadOverview} nav={nav} />}
      {tab === "members" && <MembersSection wsId={wsId} data={membersData} invites={invites} personal={personal} onReload={reload} />}
      {tab === "shares" && <SharesPanel workspaceId={wsId} />}
      {tab === "backup" && <BackupPanel workspaceId={wsId} />}
      {tab === "transfer" && <TransferPanel workspaceId={wsId} workspaceName={ws.name} canManage={canManage} />}
      {tab === "audit" && <AuditPanel workspaceId={wsId} />}
      {tab === "moderation" && <ModerationQueue workspaceId={wsId} />}
      {tab === "danger" && <DangerPanel workspaceId={wsId} workspaceName={ws.name} kind={ws.kind} role={overview.myRole} frozen={ws.frozen} deletionScheduledAt={ws.deletionScheduledAt} onChanged={() => { void reload(); }} />}
    </>}
  </SettingsShell>;
}

/* ---------------------------------- 概览 ---------------------------------- */

function OverviewSection({ overview, onGo, onRenamed, nav }: { overview: Overview; onGo: (id: SectionId) => void; onRenamed: () => Promise<void>; nav: (to: string) => void }) {
  const { workspace: ws, stats, shares, backup, roles, recentAudit } = overview;
  const todo = useMemo(() => buildHealth(overview, onGo, nav), [overview, onGo, nav]);

  return <div className="space-y-4">
    <IdentityCard overview={overview} onRenamed={onRenamed} onGo={onGo} nav={nav} />

    {/* 六个数字挤在一张卡里用细线分栏：宽屏一眼扫完，也不用六张卡各撑一片留白 */}
    <div className={cn(cardCls, "grid grid-cols-2 divide-x divide-y divide-border overflow-hidden sm:grid-cols-3 xl:grid-cols-6 xl:divide-y-0")}>
      <Stat icon={<Users className="size-4" />} label="成员" value={stats.members} onClick={() => onGo("members")}
        hint={ws.kind === "personal" ? "只有你" : `${roles.admin ?? 0} 管理 · ${roles.viewer ?? 0} 只读`} />
      <Stat icon={<FileText className="size-4" />} label="笔记" value={stats.notes} onClick={() => nav(`/w/${ws.id}`)}
        hint={stats.trashedNotes ? `本周 ${stats.notesActive7d} · 回收站 ${stats.trashedNotes}` : `本周更新 ${stats.notesActive7d} 篇`} />
      <Stat icon={<Notebook className="size-4" />} label="笔记本" value={stats.notebooks} hint="不含已删除的" onClick={() => nav(`/w/${ws.id}`)} />
      <Stat icon={<Paperclip className="size-4" />} label="附件" value={stats.attachments} hint={`占用 ${bytes(stats.attachmentBytes)}`} />
      <Stat icon={<Link2 className="size-4" />} label="生效分享" value={shares.active} onClick={() => onGo("shares")}
        hint={shares.active === 0 ? "没有对外链接" : shares.noPassword ? `${shares.noPassword} 条无密码` : "都设了密码"} />
      <Stat icon={<CloudUpload className="size-4" />} label="备份目标" value={backup?.targets ?? 0} onClick={backup ? () => onGo("backup") : undefined}
        hint={!backup ? "只有管理员能看" : backup.lastRunAt ? `上次 ${relative(backup.lastRunAt)}${backup.lastStatus === "failed" ? " 失败" : ""}` : "还没跑过"} />
    </div>

    <section className={cardCls}>
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">该处理的事</h2>
        <Badge>{todo.length ? `${todo.length} 项` : "已清空"}</Badge>
      </header>
      {todo.length === 0
        ? <div className="flex items-center gap-3 px-4 py-6">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground"><CircleCheck className="size-5" /></span>
            <div><p className="text-sm font-medium">没有待办</p><p className="text-xs text-muted-foreground">备份、分享、邀请和回收站都处于正常状态。</p></div>
          </div>
        : <ul className="divide-y divide-border">{todo.map(h => <li key={h.title} className="flex flex-wrap items-center gap-3 px-4 py-3.5">
            <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", h.tone === "danger" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
              {h.tone === "danger" ? <TriangleAlert className="size-4" /> : <h.icon className="size-4" />}
            </span>
            <div className="min-w-0 flex-1"><p className="text-sm font-medium">{h.title}</p><p className="text-xs leading-5 text-muted-foreground">{h.text}</p></div>
            {h.action && <Button variant="outline" size="sm" onClick={h.action.run}>{h.action.label}</Button>}
          </li>)}</ul>}
    </section>

    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <section className={cardCls}>
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">角色分布</h2>
          <button className="text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => onGo("members")}>管理成员</button>
        </header>
        <div className="space-y-3 p-4">
          {ROLE_ORDER.map(r => {
            const n = roles[r] ?? 0;
            const pct = stats.members ? Math.round(n / stats.members * 100) : 0;
            return <div key={r}>
              <div className="mb-1 flex items-baseline justify-between text-xs"><span className="font-medium">{ROLE_LABEL[r]}</span><span className="tabular-nums text-muted-foreground">{n} 人</span></div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${pct}%` }} /></div>
              <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{ROLE_HINT[r]}</p>
            </div>;
          })}
        </div>
      </section>

      <section className={cardCls}>
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">最近动态</h2>
          {overview.canManage && <button className="text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => onGo("audit")}>全部日志</button>}
        </header>
        {recentAudit.length === 0
          ? <p className="px-4 py-10 text-center text-xs text-muted-foreground">{overview.canManage ? "还没有记录。成员变更、备份和 MCP 写入都会出现在这里。" : "只有工作区管理员能看审计记录。"}</p>
          : <ul className="divide-y divide-border">{recentAudit.map(l => <li key={l.id} className="flex items-center gap-3 px-4 py-2.5">
              <Badge className="shrink-0">{l.actorType === "mcp" ? "MCP" : l.actorType === "system" ? "系统" : "用户"}</Badge>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{AUDIT_LABEL[l.action] ?? l.action}</p>
                <p className="truncate text-[11px] text-muted-foreground">{l.actorName ?? "系统"} · {relative(l.createdAt)}</p>
              </div>
              {l.result !== "ok" && <Badge className="border-destructive/40 text-destructive">{l.result}</Badge>}
            </li>)}</ul>}
      </section>
    </div>
  </div>;
}

type Health = { tone: "warn" | "danger"; icon: typeof Users; title: string; text: string; action?: { label: string; run: () => void } };

/** 概览上的体检清单：每条都要能一句话说清「为什么该管」，并给出下一步落点，否则就是装饰。 */
function buildHealth(o: Overview, onGo: (id: SectionId) => void, nav: (to: string) => void): Health[] {
  const list: Health[] = [];
  if (o.workspace.deletionScheduledAt) list.push({ tone: "danger", icon: Trash2, title: "工作区正在注销倒计时", text: `将于 ${new Date(o.workspace.deletionScheduledAt).toLocaleString()} 永久销毁，此前随时可以撤销。`, action: o.canManage ? { label: "去撤销", run: () => onGo("danger") } : undefined });
  else if (o.workspace.frozen) list.push({ tone: "danger", icon: Snowflake, title: "工作区已冻结", text: "所有人只能读：写入、AI 写作与 MCP 写档都会被拒绝。", action: o.canManage ? { label: "去解冻", run: () => onGo("danger") } : undefined });
  if (o.canManage && o.backup?.lastStatus === "failed") list.push({ tone: "danger", icon: CloudUpload, title: "最近一次备份失败了", text: `失败于 ${relative(o.backup.lastRunAt ?? new Date().toISOString())}，之后没有成功的记录。`, action: { label: "查看运行记录", run: () => onGo("backup") } });
  if (o.canManage && o.backup && o.backup.targets === 0) list.push({ tone: "warn", icon: CloudUpload, title: "还没有配置备份", text: "笔记只存在这台服务器上。加一个 WebDAV 或 S3 目标，才有一份能拿回来的副本。", action: { label: "配置备份", run: () => onGo("backup") } });
  else if (o.canManage && o.backup && o.backup.scheduled === 0) list.push({ tone: "warn", icon: CloudUpload, title: "备份只能手动跑", text: "已有目标但频率都是「手动」，忘了点就没有新副本。改成每天或每周更稳。", action: { label: "去改频率", run: () => onGo("backup") } });
  if (o.shares.noPassword > 0) list.push({ tone: "warn", icon: Link2, title: `${o.shares.noPassword} 条分享链接没有密码`, text: "拿到链接的任何人都能打开。确认这些内容可以公开，或给它们补上访问密码。", action: { label: "去检查", run: () => onGo("shares") } });
  if (o.shares.expiringSoon > 0) list.push({ tone: "warn", icon: CalendarDays, title: `${o.shares.expiringSoon} 条分享 7 天内到期`, text: "到期后对方会打不开。需要继续用就先续期。", action: { label: "去续期", run: () => onGo("shares") } });
  if (o.canManage && (o.siteRequests ?? 0) > 0) list.push({ tone: "warn", icon: Notebook, title: `${o.siteRequests} 个文档站等你审核`, text: "有编辑权的成员申请把笔记本发布出去。通过后 /s/ 才会对外。", action: { label: "去审核", run: () => onGo("shares") } });
  if (o.canManage && o.stats.activeInvites > 0) list.push({ tone: "warn", icon: UserPlus, title: `${o.stats.activeInvites} 条邀请链接还生效`, text: "邀请链接谁拿到谁能进。人到齐了就把它作废掉。", action: { label: "管理邀请", run: () => onGo("members") } });
  if (o.stats.trashedNotes > 0) list.push({ tone: "warn", icon: Archive, title: `回收站里有 ${o.stats.trashedNotes} 篇笔记`, text: "保留 30 天后自动销毁。要留的现在恢复，不要的可以立刻清掉。", action: { label: "打开回收站", run: () => nav(`/w/${o.workspace.id}/trash`) } });
  return list;
}

function IdentityCard({ overview, onRenamed, onGo, nav }: { overview: Overview; onRenamed: () => Promise<void>; onGo: (id: SectionId) => void; nav: (to: string) => void }) {
  const toast = useToast();
  const { workspace: ws } = overview;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(ws.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setName(ws.name); }, [ws.name]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  function cancel() { setEditing(false); setName(ws.name); setErr(""); }
  async function save() {
    const next = name.trim();
    if (!next || next === ws.name) return cancel();
    setBusy(true); setErr("");
    try { await api(`/api/v1/workspaces/${ws.id}`, { method: "PATCH", body: JSON.stringify({ name: next }) }); await onRenamed(); setEditing(false); toast.success("已改名", `这个工作区现在叫《${next}》。`); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  const meta: Array<[string, ReactNode]> = [
    ["创建于", day(ws.createdAt)],
    ["Owner", ws.ownerName ? `${ws.ownerName} @${ws.ownerHandle}` : "—"],
    ["你的角色", ROLE_LABEL[overview.myRole] ?? overview.myRole],
    ["标识", <span key="slug" className="font-mono">{ws.slug}</span>],
  ];

  return <section className={cn(cardCls, "overflow-hidden")}>
    <div className="flex flex-wrap items-start gap-4 p-5">
      <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-primary text-2xl font-semibold text-primary-foreground">{ws.name.slice(0, 1)}</span>
      <div className="min-w-0 flex-1">
        {editing
          ? <div className="flex flex-wrap items-center gap-2">
              <Input ref={inputRef} value={name} maxLength={40} className="h-9 max-w-xs text-base font-semibold" aria-label="工作区名字"
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") void save(); if (e.key === "Escape") cancel(); }} />
              <Button size="sm" disabled={busy} onClick={() => void save()}>{busy ? <LoaderCircle className="animate-spin" /> : <Check />}保存</Button>
              <Button size="sm" variant="ghost" onClick={cancel}><X />取消</Button>
            </div>
          : <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-semibold tracking-[-0.03em]">{ws.name}</h2>
              <Badge>{ws.kind === "personal" ? "个人" : "协作"}</Badge>
              {ws.frozen && <Badge className="gap-1 border-destructive/40 text-destructive"><Snowflake className="size-3" />只读</Badge>}
              {ws.deletionScheduledAt && <Badge className="border-destructive/40 text-destructive">注销中</Badge>}
              {overview.canManage && !ws.deletionScheduledAt && <Button variant="ghost" size="icon" className="size-7" aria-label="改工作区名字" onClick={() => setEditing(true)}><Pencil className="size-3.5" /></Button>}
            </div>}
        <FormError className="mt-2">{err}</FormError>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-xs">
          {meta.map(([k, v]) => <div key={k} className="flex items-baseline gap-1.5">
            <dt className="text-muted-foreground">{k}</dt><dd className="font-medium">{v}</dd>
          </div>)}
        </dl>
      </div>
      <div className="flex flex-wrap gap-2">
        {overview.canManage && ws.kind !== "personal" && <Button size="sm" onClick={() => onGo("members")}><UserPlus />邀请成员</Button>}
        <Button size="sm" variant="outline" onClick={() => nav(`/w/${ws.id}`)}>进入工作区<ArrowUpRight /></Button>
      </div>
    </div>
    {overview.stats.mcpActive > 0 && <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/40 px-5 py-2.5 text-xs text-muted-foreground">
      <Bot className="size-3.5" /><span>{overview.stats.mcpActive} 把 MCP 钥匙正在这个工作区里生效。</span>
      <button className="underline underline-offset-4" onClick={() => nav(`/w/${ws.id}/settings/integrations`)}>去看看</button>
    </div>}
  </section>;
}

function Stat({ icon, label, value, hint, onClick }: { icon: ReactNode; label: string; value: number | string; hint: string; onClick?: () => void }) {
  const inner = <>
    <div className="flex items-center gap-2 text-muted-foreground">
      {icon}<span className="text-xs font-medium">{label}</span>
      {onClick && <ArrowUpRight className="ml-auto size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />}
    </div>
    <p className="mt-1.5 text-[26px] font-semibold leading-none tabular-nums tracking-[-0.04em]">{value}</p>
    <p className="mt-1.5 truncate text-[11px] text-muted-foreground">{hint}</p>
  </>;
  return onClick
    ? <button type="button" onClick={onClick} className="group p-4 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset">{inner}</button>
    : <div className="group p-4">{inner}</div>;
}

/* -------------------------------- 成员与邀请 ------------------------------- */

function MembersSection({ wsId, data, invites, personal, onReload }: { wsId: string; data: MembersData | null; invites: Invite[]; personal: boolean; onReload: () => Promise<void> }) {
  const askConfirm = useConfirm();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [inviting, setInviting] = useState(false);
  const [pending, setPending] = useState("");

  const members = useMemo(() => data?.members ?? [], [data]);
  const canManage = data?.canManage ?? false;
  const shown = useMemo(() => {
    const key = q.trim().toLowerCase();
    return members
      .filter(m => !roleFilter || m.role === roleFilter)
      .filter(m => !key || [m.displayName, m.handle, m.email].some(v => v.toLowerCase().includes(key)))
      .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.displayName.localeCompare(b.displayName, "zh-CN"));
  }, [members, q, roleFilter]);

  if (personal) return <div className={cn(cardCls, "px-6 py-14 text-center")}>
    <span className="mx-auto grid size-12 place-items-center rounded-xl bg-muted text-muted-foreground"><Users className="size-5" /></span>
    <p className="mt-4 text-sm font-medium">个人工作区只有你自己</p>
    <p className="mx-auto mt-1.5 max-w-md text-xs leading-5 text-muted-foreground">它是你的私人库：不能加人、不能转让，也不会出现在别人的列表里。要和别人一起写，新建一个协作工作区再把人请进来。</p>
    <NewWorkspaceButton />
  </div>;

  async function changeRole(m: Member, role: string) {
    if (m.role === role) return;
    setPending(m.userId);
    try { await api(`/api/v1/workspaces/${wsId}/members/${m.userId}`, { method: "PATCH", body: JSON.stringify({ role }) }); await onReload(); toast.success(`${m.displayName} 现在是 ${ROLE_LABEL[role]}`, ROLE_HINT[role]); }
    catch (e) { toast.error("改角色失败", (e as Error).message); }
    finally { setPending(""); }
  }
  async function remove(m: Member) {
    if (!await askConfirm({ title: `把 ${m.displayName} 移出工作区？`, description: "对方立刻失去访问权，他建的 MCP 钥匙和邀请会一起作废。他自己创建的私密笔记本会迁回他的个人库，其它内容留在这里。", confirmText: "移出工作区", destructive: true })) return;
    try {
      const d = await api<{ migratedNotebooks: string[] }>(`/api/v1/workspaces/${wsId}/members/${m.userId}`, { method: "DELETE" });
      await onReload();
      toast.success(`已把 ${m.displayName} 移出工作区`, d.migratedNotebooks.length ? `${d.migratedNotebooks.length} 个私密笔记本已迁回他的个人库。` : undefined);
    } catch (e) { toast.error("移出失败", (e as Error).message); }
  }
  async function transfer(m: Member) {
    if (!await askConfirm({ title: `把 Owner 转让给 ${m.displayName}？`, description: "转让后对方成为唯一 Owner，你降级为 Admin，不能再注销或转让这个工作区。想拿回来只能请对方再转回给你。", confirmText: "转让 Owner", destructive: true, requireText: m.displayName, requireTextLabel: "对方的显示名" })) return;
    try { await api(`/api/v1/workspaces/${wsId}/transfer`, { method: "POST", body: JSON.stringify({ newOwnerUserId: m.userId }) }); await onReload(); toast.success(`已把 Owner 转让给 ${m.displayName}`, "你现在是 Admin。"); }
    catch (e) { toast.error("转让失败", (e as Error).message); }
  }

  return <div className="space-y-4">
    {canManage && inviting && <InvitePanel wsId={wsId} onClose={() => setInviting(false)} onDone={onReload} />}

    <section className={cardCls}>
      <header className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder="搜名字、用户名或邮箱…" className="pl-9" aria-label="搜索成员" />
        </div>
        <div className="flex items-center gap-1 overflow-x-auto">
          {["", ...ROLE_ORDER].map(value => {
            const n = value ? members.filter(m => m.role === value).length : members.length;
            const active = roleFilter === value;
            return <button key={value || "all"} type="button" onClick={() => setRoleFilter(value)} disabled={!n}
              className={cn("shrink-0 rounded-full px-2.5 py-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40",
                active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}>
              {value ? ROLE_LABEL[value] : "全部"} <span className="tabular-nums opacity-70">{n}</span>
            </button>;
          })}
        </div>
        {canManage && <Button size="sm" className="ml-auto" onClick={() => setInviting(v => !v)}><UserPlus />邀请成员</Button>}
      </header>

      {shown.length === 0
        ? <p className="px-4 py-12 text-center text-xs text-muted-foreground">没有匹配的成员。换个关键词，或把筛选切回「全部」。</p>
        : <ul className="divide-y divide-border">{shown.map(m => {
          const isMe = m.userId === data?.myUserId;
          const isOwner = m.role === "owner";
          return <li key={m.userId} className="flex flex-wrap items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/30">
            <UserAvatar name={m.displayName} url={m.avatarUrl} className="size-10 rounded-xl text-sm" />
            <div className="min-w-0 flex-[2] basis-48">
              <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                {m.displayName}
                {isOwner && <Crown className="size-3.5 text-muted-foreground" aria-label="Owner" />}
                {isMe && <Badge>你</Badge>}
                {m.status !== "active" && <Badge className="border-destructive/40 text-destructive">{m.status === "banned" ? "已封禁" : "注销中"}</Badge>}
              </p>
              <p className="truncate text-xs text-muted-foreground">@{m.handle} · {m.email}</p>
            </div>
            <div className="hidden min-w-0 flex-1 basis-32 text-xs text-muted-foreground sm:block">
              <p className="tabular-nums">写了 {m.noteCount} 篇</p>
              <p>{day(m.joinedAt)} 加入</p>
            </div>
            {canManage && !isOwner
              ? <select className={cn(selectCls, "h-8 text-xs")} value={m.role} disabled={pending === m.userId} aria-label={`${m.displayName} 的角色`} onChange={e => void changeRole(m, e.target.value)}>
                  {ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
              : <Badge className="h-7 px-2.5">{ROLE_LABEL[m.role] ?? m.role}</Badge>}
            {canManage && !isOwner && !isMe
              ? <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-8" aria-label={`${m.displayName} 的更多操作`}><MoreHorizontal /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {data?.myRole === "owner" && <><DropdownMenuItem onSelect={() => void transfer(m)}><Crown />转让 Owner 给他</DropdownMenuItem><DropdownMenuSeparator /></>}
                    <DropdownMenuItem className="text-destructive" onSelect={() => void remove(m)}><Trash2 />移出工作区</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              : <span className="size-8" aria-hidden />}
          </li>;
        })}</ul>}
      <p className="border-t border-border px-4 py-2.5 text-[11px] leading-5 text-muted-foreground">
        Admin：{ROLE_HINT.admin}；Editor：{ROLE_HINT.editor}；Viewer：{ROLE_HINT.viewer}。
      </p>
    </section>

    {canManage && <InviteList wsId={wsId} invites={invites} onDone={onReload} />}
    {data && data.myRole !== "owner" && <LeaveCard wsId={wsId} />}
  </div>;
}

/** 加人有两条路：知道用户名就直接加，不知道就发链接。放同一张卡里，省得先想「该点哪个入口」。 */
function InvitePanel({ wsId, onClose, onDone }: { wsId: string; onClose: () => void; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [handle, setHandle] = useState("");
  const [role, setRole] = useState("editor");
  const [expires, setExpires] = useState(7);
  const [maxUses, setMaxUses] = useState("1");
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<"add" | "link" | "">("");

  function copy(url: string) {
    void navigator.clipboard.writeText(url).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); }).catch(() => { /* 没剪贴板权限就让用户自己选中 */ });
  }
  async function add() {
    if (!handle.trim()) return;
    setBusy("add"); setErr("");
    try {
      await api(`/api/v1/workspaces/${wsId}/members`, { method: "POST", body: JSON.stringify({ handle: handle.trim().replace(/^@/, ""), role }) });
      setHandle(""); await onDone();
      toast.success("已加入工作区", `对方以 ${ROLE_LABEL[role]} 身份进来了，现在就能看到内容。`);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  }
  async function makeLink() {
    setBusy("link"); setErr("");
    try {
      const d = await api<{ url: string }>(`/api/v1/workspaces/${wsId}/invites`, { method: "POST", body: JSON.stringify({ role, expiresInDays: expires, maxUses: maxUses === "0" ? null : Number(maxUses) }) });
      const url = location.origin + d.url;
      setLink(url); copy(url); await onDone();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  }

  return <section className={cn(cardCls, "overflow-hidden")}>
    <header className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-3">
      <UserPlus className="size-4 text-muted-foreground" />
      <h2 className="text-sm font-semibold">邀请成员</h2>
      <Button variant="ghost" size="icon" className="ml-auto size-7" aria-label="收起邀请面板" onClick={onClose}><X className="size-3.5" /></Button>
    </header>
    <div className="grid gap-5 p-4 md:grid-cols-2 md:gap-6">
      <div className="space-y-2.5">
        <div>
          <p className="text-sm font-medium">知道用户名，直接加</p>
          <p className="mt-0.5 text-xs text-muted-foreground">对方立刻进来，不用点确认，也不会收到链接。</p>
        </div>
        <div className="flex gap-2">
          <Input value={handle} onChange={e => setHandle(e.target.value)} placeholder="对方的用户名，如 lixiaoming" aria-label="用户名" onKeyDown={e => { if (e.key === "Enter") void add(); }} />
          <Button disabled={busy === "add" || !handle.trim()} onClick={() => void add()}>{busy === "add" ? <LoaderCircle className="animate-spin" /> : <Plus />}加入</Button>
        </div>
      </div>
      <div className="space-y-2.5 md:border-l md:border-border md:pl-6">
        <div>
          <p className="text-sm font-medium">不知道用户名，发链接</p>
          <p className="mt-0.5 text-xs text-muted-foreground">谁拿到链接谁能进，所以要限次数和有效期。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select className={selectCls} value={expires} onChange={e => setExpires(Number(e.target.value))} aria-label="邀请有效期">
            {[1, 7, 30, 90].map(d => <option key={d} value={d}>{d} 天内有效</option>)}
          </select>
          <select className={selectCls} value={maxUses} onChange={e => setMaxUses(e.target.value)} aria-label="可用次数">
            <option value="1">只能用 1 次</option><option value="5">可用 5 次</option><option value="20">可用 20 次</option><option value="0">不限次数</option>
          </select>
          <Button variant="outline" disabled={busy === "link"} onClick={() => void makeLink()}>{busy === "link" ? <LoaderCircle className="animate-spin" /> : <Link2 />}生成链接</Button>
        </div>
      </div>
      <div className="md:col-span-2">
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/60 px-3 py-2.5">
          <span className="text-xs text-muted-foreground">进来后的角色</span>
          <div className="flex gap-1">
            {ROLES.map(r => <button key={r} type="button" onClick={() => setRole(r)}
              className={cn("rounded-full px-2.5 py-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50", role === r ? "bg-primary text-primary-foreground" : "hover:bg-background")}>{ROLE_LABEL[r]}</button>)}
          </div>
          <span className="text-xs text-muted-foreground">{ROLE_HINT[role]}</span>
        </div>
        {link && <>
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
            <Link2 className="size-4 shrink-0 text-muted-foreground" />
            <code className="min-w-0 flex-1 truncate font-mono text-xs">{link}</code>
            <Button size="sm" variant="ghost" onClick={() => copy(link)}>{copied ? <><Check />已复制</> : <><Copy />复制</>}</Button>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">链接原文只显示这一次；关掉后只剩前缀，需要重发就在下面作废再生成。</p>
        </>}
        <FormError className="mt-2">{err}</FormError>
      </div>
    </div>
  </section>;
}

function InviteList({ wsId, invites, onDone }: { wsId: string; invites: Invite[]; onDone: () => Promise<void> }) {
  const askConfirm = useConfirm();
  const toast = useToast();
  if (!invites.length) return null;
  const label: Record<string, string> = { active: "生效中", revoked: "已作废", expired: "已过期", exhausted: "已用完" };
  return <section className={cardCls}>
    <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
      <h2 className="text-sm font-semibold">邀请链接</h2>
      <Badge>{invites.filter(i => i.status === "active").length} 条生效中</Badge>
      <span className="ml-auto text-xs text-muted-foreground">链接原文只在生成时显示一次，这里按前缀对应</span>
    </header>
    <ul className="divide-y divide-border">{invites.map(i => {
      const live = i.status === "active";
      const left = daysLeft(i.expiresAt);
      return <li key={i.id} className={cn("flex flex-wrap items-center gap-3 px-4 py-3", !live && "opacity-60")}>
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><Link2 className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <code className="font-mono text-xs">{i.tokenPrefix}…</code>
            <Badge>{ROLE_LABEL[i.role] ?? i.role}</Badge>
            <Badge className={cn(!live && "border-destructive/30 text-destructive")}>{label[i.status] ?? i.status}</Badge>
          </p>
          <p className="truncate text-xs text-muted-foreground">
            已用 {i.usedCount}/{i.maxUses ?? "不限"} · {live ? (left <= 0 ? "今天到期" : `${left} 天后到期`) : `到期 ${day(i.expiresAt)}`} · {i.createdByName} 建于 {day(i.createdAt)}
          </p>
        </div>
        {live && <Button variant="ghost" size="sm" className="text-destructive" onClick={async () => {
          if (!await askConfirm({ title: "作废这条邀请链接？", description: "链接立刻打不开，已经用它进来的人不受影响。需要再邀请就重新生成一条。", confirmText: "作废链接", destructive: true })) return;
          try { await api(`/api/v1/invites/${i.id}`, { method: "DELETE" }); await onDone(); toast.success("已作废这条邀请"); }
          catch (e) { toast.error("作废失败", (e as Error).message); }
        }}><Trash2 />作废</Button>}
      </li>;
    })}</ul>
  </section>;
}

/** 被加进来的人得有出口：管理员在成员列表里移不掉自己，但本人可以自己走。 */
function LeaveCard({ wsId }: { wsId: string }) {
  const nav = useNavigate();
  const askConfirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return <section className={cn(cardCls, "flex flex-wrap items-center gap-4 p-4")}>
    <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><LogOut className="size-4" /></span>
    <div className="min-w-0 flex-1">
      <p className="text-sm font-medium">退出这个工作区</p>
      <p className="text-xs leading-5 text-muted-foreground">退出后看不到这里的内容，你建的 MCP 钥匙和邀请会作废；你自己创建的私密笔记本会迁回个人库，公共内容留下。要回来需要别人重新邀请。</p>
    </div>
    <Button variant="outline" disabled={busy} onClick={async () => {
      if (!await askConfirm({ title: "退出这个工作区？", description: "退出后立刻失去访问权。你写在公共笔记本里的内容会留在这里，不会跟着你走。", confirmText: "退出工作区", destructive: true })) return;
      setBusy(true);
      try {
        const d = await api<{ migratedNotebooks: string[] }>(`/api/v1/workspaces/${wsId}/leave`, { method: "POST" });
        toast.success("已退出工作区", d.migratedNotebooks.length ? `${d.migratedNotebooks.length} 个私密笔记本已迁回你的个人库。` : undefined);
        nav("/app");
      } catch (e) { toast.error("退出失败", (e as Error).message); setBusy(false); }
    }}><LogOut />退出</Button>
  </section>;
}

function NewWorkspaceButton() {
  const nav = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return <Button className="mt-5" disabled={busy} onClick={async () => {
    setBusy(true);
    try {
      const d = await api<{ workspace: { id: string } }>("/api/v1/workspaces", { method: "POST", body: JSON.stringify({ name: "新的协作工作区" }) });
      nav(`/w/${d.workspace.id}/settings?tab=members`);
    } catch (e) { toast.error("建不了工作区", (e as Error).message); setBusy(false); }
  }}><Plus />新建协作工作区</Button>;
}
