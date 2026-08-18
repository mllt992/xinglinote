import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import * as Avatar from "@radix-ui/react-avatar";
import * as Tabs from "@radix-ui/react-tabs";
import {
  AlertCircle, Archive, Bot, CalendarDays, Check, ChevronDown, ChevronRight, Circle, FilePlus2, Folder,
  FolderPlus, Globe2, List, MessageSquare, Link2, Lock, LogOut, MoreHorizontal, Notebook, Paintbrush, PanelRight,
  Pencil, Plus, RotateCcw, Search, Star, Settings, Share2, Sparkles, Sun, Trash2, Users, X, Copy, ExternalLink, Upload, Paperclip, Download,
  Maximize2, Minimize2, PanelLeft, PenLine, Terminal, Type, Workflow,
} from "lucide-react";
import { api, type Me } from "./api";
import { MarkdownView } from "./MarkdownView";
import { MarkdownEditor, type MarkdownEditorHandle } from "./editor/markdown-editor";
import { EditorStatusBar, type CursorInfo } from "./components/editor-status-bar";
import { CommandPalette, type Command as PaletteCommand } from "./components/command-palette";
import { NOTEBOOKS_MAX, NOTEBOOKS_MIN, TREE_MAX, TREE_MIN, clamp, loadLayout, saveLayout, type LayoutPrefs } from "./lib/layout-prefs";
import { useThemeRefresh } from "./theme";
import { cn } from "./lib/utils";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { Badge } from "./components/ui/badge";
import { ScrollArea } from "./components/ui/scroll-area";
import { Separator } from "./components/ui/separator";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { AskDialog } from "./components/ai-dialogs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from "./components/ui/context-menu";
import { Tooltip, TooltipProvider } from "./components/ui/tooltip";
import { useConfirm, usePrompt } from "./components/ui/confirm";
import { FormError } from "./components/ui/form-error";
import { useToast } from "./components/ui/toast";
import { NotificationBell } from "./components/notifications";
import { McpPanel } from "./components/mcp-panel";
import { OauthConsent } from "./components/oauth-consent";
import { ShareDialog, type ShareTarget } from "./components/share-dialog";
import { FeedView, type FeedPost } from "./components/feed";
import { PublicInteractions } from "./components/public-interactions";
import { ImportDialog } from "./components/import-dialog";
import { NoteList, NoteSortMenu } from "./components/note-list";
import { NoteRail, loadRailTab, saveRailTab, type Attachment, type RailTab } from "./components/note-rail";
import { CalendarPage, TodayPage } from "./components/calendar";
import { sortNotes } from "@kb/shared";
import { diagramBlockAt } from "@kb/shared/markdown";
import { loadNotebookNoteSort, saveNotebookNoteSort, type NoteSortMode } from "./lib/note-sort-pref";
import { AuditPanel, BackupPanel, DangerPanel, SharesPanel, TransferPanel } from "./components/manage-panels";
import { AdminPage } from "./components/admin-page";
import { readMarkdownZip } from "./lib/zip";
import { QuickOpen, useQuickOpenHotkey } from "./components/quick-open";
import { AppNav, loadLastWorkspace, saveLastWorkspace, useSquareEnabled, type NavPlace } from "./components/app-nav";
import { CircleRail, SquareRail } from "./components/feed-rail";

/** 导出接口回的是二进制，不能走 api() 的 JSON 解析。 */
async function downloadZip(path: string) {
  const res = await fetch(path, { credentials: "include", headers: { "X-Requested-With": "fetch" } });
  if (!res.ok) { const j = await res.json().catch(() => null); throw new Error(j?.error?.message ?? "导出失败"); }
  const name = decodeURIComponent(res.headers.get("Content-Disposition")?.match(/filename*=UTF-8''(.+)$/)?.[1] ?? "export.zip");
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}
function useMe() {
  const [me, setMe] = useState<Me | null | undefined>();
  useEffect(() => { api<Me>("/api/v1/me").then(setMe).catch(() => setMe(null)); }, []);
  return me;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="flex items-center gap-2.5 font-semibold tracking-[-0.03em]"><span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground"><Sparkles className="size-3.5" /></span>{!compact && <span>Knowledge</span>}</div>;
}

function AuthShell({ children, title, subtitle }: { children: ReactNode; title: string; subtitle: string }) {
  return <main className="grid min-h-full grid-cols-1 bg-background lg:grid-cols-[1.1fr_.9fr]">
    <section className="relative hidden overflow-hidden border-r border-border bg-foreground p-12 text-background lg:flex lg:flex-col">
      <Brand />
      <div className="my-auto max-w-lg"><Badge className="mb-6 border-white/15 bg-white/10 text-white/70">Markdown-first · Self-hosted</Badge><h2 className="text-5xl font-semibold leading-[1.05] tracking-[-.06em]">让知识可写、可连、<br />也可被 AI 使用。</h2><p className="mt-6 max-w-md text-base leading-7 text-white/55">私人笔记、协作工作区、公开文档与 MCP 大脑，在同一个可控的数据底座上。</p></div>
      <p className="text-xs text-white/40">数据属于你。Markdown 永远可迁移。</p>
      <div className="absolute -right-24 top-1/3 size-80 rounded-full bg-white/[.04] blur-3xl" />
    </section>
    <section className="flex min-h-screen items-center justify-center p-6"><div className="w-full max-w-[390px]"><div className="mb-10 lg:hidden"><Brand /></div><h1 className="text-3xl font-semibold tracking-[-.045em]">{title}</h1><p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>{children}</div></section>
  </main>;
}

function Login() {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) { e.preventDefault(); setErr(""); setBusy(true); try { await api("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }); const next = new URLSearchParams(location.search).get("next"); window.location.assign(next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/app"); } catch (x) { setErr((x as Error).message); setBusy(false); } }
  return <AuthShell title="欢迎回来" subtitle="登录后继续整理你的知识库。"><form className="mt-8 space-y-5" onSubmit={submit}><div className="space-y-2"><label className="text-sm font-medium">邮箱</label><Input type="email" autoFocus autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></div><div className="space-y-2"><label className="text-sm font-medium">密码</label><Input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></div><FormError className="rounded-lg bg-destructive/10 px-3 py-2">{err}</FormError><Button type="submit" className="w-full" disabled={busy}>{busy ? "正在登录…" : "登录"}</Button><p className="text-center text-sm"><Link className="text-muted-foreground underline underline-offset-4" to="/forgot-password">忘记密码？</Link></p><p className="text-center text-sm text-muted-foreground">还没有账号？ <Link className="font-medium text-foreground underline underline-offset-4" to="/register">创建账号</Link></p></form></AuthShell>;
}

function ForgotPassword(){const[email,setEmail]=useState("");const[done,setDone]=useState(false);return <AuthShell title="找回密码" subtitle="输入邮箱，我们会发送一小时有效的重置链接。">{done?<div className="mt-8 rounded-xl border bg-muted/30 p-5 text-sm">如果邮箱存在，重置说明已经发送。<Link className="mt-4 block underline" to="/login">返回登录</Link></div>:<form className="mt-8 space-y-4" onSubmit={async e=>{e.preventDefault();await api('/api/v1/auth/forgot-password',{method:'POST',body:JSON.stringify({email})});setDone(true)}}><Input type="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="name@example.com"/><Button className="w-full">发送重置邮件</Button></form>}</AuthShell>}
function ResetPassword(){
  const token=new URLSearchParams(location.search).get("token")??""; const[password,setPassword]=useState(""); const[message,setMessage]=useState("");
  async function submit(e:FormEvent){e.preventDefault();try{await api("/api/v1/auth/reset-password",{method:"POST",body:JSON.stringify({token,password})});setMessage("密码已更新，请返回登录。");}catch(x){setMessage((x as Error).message);}}
  return <AuthShell title="设置新密码" subtitle="新密码至少 10 位，并同时包含字母和数字。"><form className="mt-8 space-y-4" onSubmit={submit}><Input type="password" value={password} onChange={e=>setPassword(e.target.value)} required/><Button className="w-full">更新密码</Button>{message&&<p className="text-sm">{message}</p>}<Link className="block text-center text-sm underline" to="/login">返回登录</Link></form></AuthShell>;
}
function VerifyEmail(){const token=new URLSearchParams(location.search).get('token')??'';const[status,setStatus]=useState('正在验证邮箱…');useEffect(()=>{api('/api/v1/auth/verify-email',{method:'POST',body:JSON.stringify({token})}).then(()=>location.assign('/app')).catch(e=>setStatus(e.message))},[]);return <AuthShell title="验证邮箱" subtitle="验证完成后即可使用知识库。"><p className="mt-8 rounded-xl border p-5 text-sm">{status}</p></AuthShell>}

function Register() {
  const [first, setFirst] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [form, setForm] = useState({ email: "", password: "", handle: "", displayName: "", registrationCode: "" });
  useEffect(() => { api<{ empty: boolean }>("/api/v1/meta").then(x => setFirst(x.empty)); }, []);
  const field = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });
  async function submit(e: FormEvent) { e.preventDefault(); setBusy(true); setErr(""); try { const result=await api<{requiresVerification?:boolean;mailSent?:boolean;developmentToken?:string}>("/api/v1/auth/register", { method: "POST", body: JSON.stringify(form) }); if(result.requiresVerification){setErr(result.mailSent?'验证邮件已发送，请验证后登录。':`SMTP 未配置。开发验证地址：/verify-email?token=${result.developmentToken}`);setBusy(false)}else window.location.assign("/app"); } catch (x) { setErr((x as Error).message); setBusy(false); } }
  return <AuthShell title="创建账号" subtitle={first ? "首个账号将成为实例管理员。" : "从一个默认的个人工作区开始。"}><form className="mt-8 space-y-4" onSubmit={submit}><div className="grid grid-cols-2 gap-3"><div className="space-y-2"><label className="text-sm font-medium">显示名</label><Input value={form.displayName} onChange={field("displayName")} /><p className="text-xs text-muted-foreground">别人看到的名字，之后可以改。</p></div><div className="space-y-2"><label className="text-sm font-medium">用户名</label><Input value={form.handle} onChange={field("handle")} /><p className="text-xs text-muted-foreground">公开主页地址 /u/用户名，小写字母开头，3–32 位。</p></div></div><div className="space-y-2"><label className="text-sm font-medium">邮箱</label><Input type="email" value={form.email} onChange={field("email")} /><p className="text-xs text-muted-foreground">用于登录和找回密码。</p></div><div className="space-y-2"><label className="text-sm font-medium">密码</label><Input type="password" value={form.password} onChange={field("password")} /><p className="text-xs text-muted-foreground">至少 10 位，需要同时含字母和数字。</p></div>{!first && <div className="space-y-2"><label className="text-sm font-medium">注册码 <span className="font-normal text-muted-foreground">（关闭开放注册时必填）</span></label><Input value={form.registrationCode} onChange={field("registrationCode")} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" /></div>}<FormError className="rounded-lg bg-destructive/10 px-3 py-2">{err}</FormError><Button className="w-full" disabled={busy}>{busy ? "正在创建…" : "创建账号"}</Button><p className="text-center text-sm text-muted-foreground">已有账号？ <Link className="font-medium text-foreground underline underline-offset-4" to="/login">返回登录</Link></p></form></AuthShell>;
}

type Ws = { id: string; name: string; kind: string; role: string; frozen?: boolean; deletionScheduledAt?: string | null };

const HIDE_FROZEN_KEY = "kb.hide-frozen-workspaces";
function loadHideFrozen() { try { return localStorage.getItem(HIDE_FROZEN_KEY) !== "0"; } catch { return true; } }
function saveHideFrozen(hide: boolean) { try { localStorage.setItem(HIDE_FROZEN_KEY, hide ? "1" : "0"); } catch { /* 隐私模式忽略 */ } }

function WorkspaceSwitcher({ spaces, wsId, onPick, onCreate }: { spaces: Ws[]; wsId?: string; onPick: (id: string) => void; onCreate: () => void }) {
  const [hideFrozen, setHideFrozen] = useState(loadHideFrozen);
  const active = spaces.find(s => s.id === wsId);
  const live = spaces.filter(s => !s.frozen || s.id === wsId);
  const frozen = spaces.filter(s => !!s.frozen && s.id !== wsId);
  function row(s: Ws) {
    return <DropdownMenuItem key={s.id} onSelect={() => onPick(s.id)}>
      <span className="grid size-7 place-items-center rounded-md bg-muted"><Users className="size-3.5" /></span>
      <span className="flex-1 truncate">{s.name}</span>
      {s.deletionScheduledAt ? <Badge>注销中</Badge> : s.frozen ? <Badge>冻结</Badge> : null}
      {s.id === wsId && <Check />}
    </DropdownMenuItem>;
  }
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" className="h-9 gap-2 px-2">
        <Brand compact />
        <span className="workspace-label max-w-40 truncate font-semibold">{active?.name ?? "工作区"}</span>
        {active?.frozen && <span className="text-[11px] font-normal text-muted-foreground">冻结</span>}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-64">
      <p className="px-2.5 py-2 text-xs font-medium text-muted-foreground">切换工作区</p>
      {live.map(row)}
      {frozen.length > 0 && <>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={e => { e.preventDefault(); const next = !hideFrozen; setHideFrozen(next); saveHideFrozen(next); }}>
          <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", !hideFrozen && "rotate-90")} />
          <span className="flex-1">{hideFrozen ? "显示冻结中的工作区" : "收起冻结中的工作区"}</span>
          <Badge>{frozen.length}</Badge>
        </DropdownMenuItem>
        {!hideFrozen && frozen.map(row)}
      </>}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onCreate}><Plus />新建工作区</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
type Nb = { id: string; title: string; defaultAiIndex?: boolean; visibility?: "open"|"private"|"restricted"; createdBy?:string };
type FolderDto = { id: string; title: string; parentId: string | null };
type TreeNote = { id: string; title: string; folderId: string | null; createdAt?: string; sortKey?: number };
type NoteDto = { id: string; notebookId: string; title: string; bodyMd: string; version: number; aiIndex: boolean; published: boolean; canEdit: boolean; tags?: string[] };
type Att = { id: string; filename: string; mime: string; bytes: number; url: string };
type Hit = { id: string; title: string; snippet: string; notebookId: string; workspaceId: string; tags?: string[] };
type CreateKind = "workspace" | "notebook" | "folder" | null;

function CreateDialog({ kind, onOpenChange, onSubmit }: { kind: CreateKind; onOpenChange: (v: boolean) => void; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(""); const [busy, setBusy] = useState(false);
  const names = kind === "workspace" ? ["新建工作区", "适合家庭、项目组或小团队协作。"] : kind === "notebook" ? ["新建笔记本", "笔记本是内容与权限的主要边界。"] : ["新建文件夹", "把相关笔记整理在一起。"];
  return <Dialog open={!!kind} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>{names[0]}</DialogTitle><DialogDescription>{names[1]}</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={async e => { e.preventDefault(); if (!name.trim()) return; setBusy(true); await onSubmit(name.trim()); setBusy(false); setName(""); onOpenChange(false); }}><Input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="输入名称" /><div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button><Button disabled={busy || !name.trim()}>{busy ? "创建中…" : "创建"}</Button></div></form></DialogContent></Dialog>;
}



function NotebookAccessDialog({notebook,workspaceId,open,onOpenChange,onSaved}:{notebook:Nb|undefined;workspaceId:string|undefined;open:boolean;onOpenChange:(v:boolean)=>void;onSaved:()=>void}) {
  type Member = { userId: string; displayName: string; handle: string; role: string };
  const [members, setMembers] = useState<Member[]>([]);
  const [allowed, setAllowed] = useState<Record<string, "view" | "edit">>({});
  const [visibility, setVisibility] = useState<"open" | "private" | "restricted">("open");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const toast = useToast();

  useEffect(() => {
    if (!open || !notebook || !workspaceId) return;
    setVisibility(notebook.visibility ?? "open");
    setFilter(""); setErr("");
    void Promise.all([
      api<{ members: Member[] }>(`/api/v1/workspaces/${workspaceId}/members`),
      api<{ members: Array<{ userId: string; role: "view" | "edit" }> }>(`/api/v1/notebooks/${notebook.id}/members`),
    ]).then(([ws, acl]) => {
      setMembers(ws.members.filter(m => m.role !== "owner"));
      setAllowed(Object.fromEntries(acl.members.map(m => [m.userId, m.role])));
    }).catch(e => setErr((e as Error).message));
  }, [open, notebook?.id, workspaceId]);

  if (!notebook) return null;
  const shown = members.filter(m => {
    const q = filter.trim().toLocaleLowerCase();
    return !q || m.displayName.toLocaleLowerCase().includes(q) || m.handle.toLocaleLowerCase().includes(q);
  });

  // 可见性和成员名单一起提交：以前 select 是立刻写库、勾选要点保存，改完直接关掉会丢一半。
  async function save() {
    if (!notebook) return;
    setBusy(true); setErr("");
    try {
      if (visibility !== (notebook.visibility ?? "open")) {
        await api(`/api/v1/notebooks/${notebook.id}`, { method: "PATCH", body: JSON.stringify({ visibility }) });
      }
      if (visibility === "restricted") {
        await api(`/api/v1/notebooks/${notebook.id}/members`, { method: "PUT", body: JSON.stringify({ members: Object.entries(allowed).map(([userId, role]) => ({ userId, role })) }) });
      }
      toast.success("访问权限已保存");
      onOpenChange(false);
      onSaved();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>《{notebook.title}》的访问权限</DialogTitle>
      <DialogDescription>全体成员：工作区里谁都能看；仅我可见：只有创建者；指定成员：只有下面勾上的人。</DialogDescription></DialogHeader>
    <div className="grid gap-1.5">
      {([["open", "全体成员", "工作区所有人可读写"], ["private", "仅我可见", "别人看不到这个笔记本"], ["restricted", "指定成员", "只有白名单里的人能进"]] as const).map(([value, label, hint]) => (
        <label key={value} className={cn("flex cursor-pointer items-start gap-3 rounded-xl border p-3", visibility === value ? "border-primary bg-primary/5" : "border-border")}>
          <input type="radio" className="mt-0.5" name="notebook-visibility" checked={visibility === value} onChange={() => setVisibility(value)} />
          <span className="min-w-0"><span className="block text-sm font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
        </label>
      ))}
    </div>
    {visibility === "restricted" && (members.length === 0
      ? <p className="text-xs text-muted-foreground">这个工作区还没有别的成员可以选。</p>
      : <>
        {members.length > 6 && <Input value={filter} onChange={e => setFilter(e.target.value)} placeholder="搜成员…" />}
        <div className="max-h-72 space-y-2 overflow-auto">
          {shown.map(m => <label key={m.userId} className="flex items-center gap-3 rounded-lg border p-3">
            <input type="checkbox" checked={!!allowed[m.userId]} onChange={e => setAllowed(v => { const n = { ...v }; if (e.target.checked) n[m.userId] = "view"; else delete n[m.userId]; return n; })} />
            <span className="min-w-0 flex-1 truncate text-sm">{m.displayName} <small className="text-muted-foreground">@{m.handle}</small></span>
            {allowed[m.userId] && <select className="h-8 rounded-lg border border-input bg-background px-2 text-xs" value={allowed[m.userId]} onChange={e => setAllowed(v => ({ ...v, [m.userId]: e.target.value as "view" | "edit" }))}>
              <option value="view">只读</option><option value="edit">可编辑</option>
            </select>}
          </label>)}
          {shown.length === 0 && <p className="py-6 text-center text-xs text-muted-foreground">没有匹配的成员。</p>}
        </div>
        <p className="text-xs text-muted-foreground">已选 {Object.keys(allowed).length} 人</p>
      </>)}
    <FormError>{err}</FormError>
    <div className="flex justify-end gap-2">
      <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
      <Button disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</Button>
    </div>
  </DialogContent></Dialog>;
}

/** 顶栏账号菜单。笔记、圈子、广场三处挂的是同一个，换个页面不会突然少掉半套入口。
    广场没有 wsId，就退回最近待过的工作区；连那个都没有时，跟工作区绑定的几项直接不出现，而不是给一个点了报错的链接。 */
function AccountMenu({ me, wsId }: { me: Me | null | undefined; wsId?: string }) {
  const nav = useNavigate(); const askText = usePrompt(); const toast = useToast();
  const home = wsId ?? loadLastWorkspace() ?? me?.personalWorkspaceId ?? undefined;
  return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="rounded-full"><Avatar.Root className="grid size-8 place-items-center rounded-full bg-foreground text-xs font-semibold text-background"><Avatar.Fallback>{me?.displayName?.slice(0, 1) ?? "U"}</Avatar.Fallback></Avatar.Root></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-56"><div className="px-2.5 py-2"><p className="text-sm font-medium">{me?.displayName}</p><p className="truncate text-xs text-muted-foreground">{me?.email}</p>{me?.storage&&<div className="mt-2"><div className="mb-1 flex justify-between text-[10px] text-muted-foreground"><span>存储空间</span><span>{(me.storage.usedBytes/1048576).toFixed(1)} MB / {(me.storage.quotaBytes/1073741824).toFixed(1)} GB</span></div><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{width:`${Math.min(100,me.storage.usedBytes/me.storage.quotaBytes*100)}%`}}/></div></div>}</div><DropdownMenuSeparator />{home && <><DropdownMenuItem onSelect={() => nav(`/w/${home}/trash`)}><Archive />回收站</DropdownMenuItem><DropdownMenuItem onSelect={() => nav(`/w/${home}/members`)}><Users />成员管理</DropdownMenuItem><DropdownMenuItem onSelect={() => nav(`/w/${home}/manage`)}><Archive />工作区管理</DropdownMenuItem><DropdownMenuItem onSelect={() => nav(`/settings/integrations?workspace=${home}`)}><Bot />AI 与 MCP</DropdownMenuItem></>}<DropdownMenuItem onSelect={() => nav("/settings/appearance")}><Settings />外观设置</DropdownMenuItem>{me?.instanceRole === "admin" && <DropdownMenuItem onSelect={() => nav("/admin")}><Settings />实例后台</DropdownMenuItem>}<DropdownMenuSeparator />{me?.status==="pending_deletion"?<DropdownMenuItem onSelect={async()=>{await api('/api/v1/account/cancel-deletion',{method:'POST'});location.reload()}}><RotateCcw/>撤销账号注销</DropdownMenuItem>:<DropdownMenuItem className="text-destructive" onSelect={async()=>{const password=await askText({title:'申请注销账号',description:'提交后账号进入注销流程，7 天内可以登录回来撤销；超过 7 天数据会被彻底删除。请输入当前密码确认。',label:'当前密码',type:'password',autoComplete:'current-password',confirmText:'申请注销',destructive:true});if(!password)return;try{await api('/api/v1/account/request-deletion',{method:'POST',body:JSON.stringify({password})});location.assign('/login')}catch(e){toast.error('申请注销失败',(e as Error).message)}}}><Trash2/>申请注销账号</DropdownMenuItem>}<DropdownMenuItem className="text-destructive" onSelect={async () => { await api("/api/v1/auth/logout", { method: "POST" }); window.location.assign("/login"); }}><LogOut />退出登录</DropdownMenuItem></DropdownMenuContent></DropdownMenu>;
}

function Workspace() {
  const askConfirm = useConfirm(); const askText = usePrompt(); const toast = useToast();
  const me = useMe(); const nav = useNavigate(); const { wsId, noteId } = useParams();
  const [spaces, setSpaces] = useState<Ws[]>([]); const [nbs, setNbs] = useState<Nb[]>([]); const [nbId, setNbId] = useState<string>();
  const autoOpenNb = useRef<string | null>(null);
  const [folders, setFolders] = useState<FolderDto[]>([]); const [activeFolder, setActiveFolder] = useState<string | null>(null); const [tree, setTree] = useState<TreeNote[]>([]);
  const [noteSort, setNoteSort] = useState<NoteSortMode>("created"); const [treeCanEdit, setTreeCanEdit] = useState(false);
  const [note, setNote] = useState<NoteDto | null>(null); const noteRef = useRef<NoteDto | null>(null); const saveTimer = useRef<number | null>(null); const [status, setStatus] = useState("就绪"); const [statusErr, setStatusErr] = useState(false);
  /** 编辑器状态条：dirty / saving / saved / conflict（规范 §11.4）。冲突与保存失败必须和「已保存」看得出区别。 */
  const say = (text: string, error = false) => { setStatus(text); setStatusErr(error); };
  const [search, setSearch] = useState(""); const [hits, setHits] = useState<Hit[]>([]); const [allSpaces, setAllSpaces] = useState(false); const [titleOnly, setTitleOnly] = useState(false); const [backlinks, setBacklinks] = useState<Array<{ id: string; title: string; snippet: string }>>([]); const [atts, setAtts] = useState<Att[]>([]); const [rail, setRailState] = useState<RailTab | null>(loadRailTab); const [create, setCreate] = useState<CreateKind>(null);  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null); const [showImport, setShowImport] = useState(false); const [favorited, setFavorited] = useState(false); const [viewers, setViewers] = useState<string[]>([]); const [quickOpen, setQuickOpen] = useState(false);  const[showAsk,setShowAsk]=useState(false); const [showNotebookAccess,setShowNotebookAccess]=useState(false); const [site, setSite] = useState<{ published: boolean; slug: string } | null>(null);
  const activeWs = spaces.find(x => x.id === wsId); const activeNb = nbs.find(x => x.id === nbId);

  useQuickOpenHotkey(setQuickOpen);
  useEffect(() => { if (me === null) nav("/login"); }, [me, nav]);
  useEffect(() => { if (wsId) saveLastWorkspace(wsId); }, [wsId]);
  useEffect(() => { api<{ workspaces: Ws[] }>("/api/v1/workspaces").then(d => { setSpaces(d.workspaces); if (!wsId && me?.personalWorkspaceId) nav(`/w/${me.personalWorkspaceId}`, { replace: true }); }); }, [me, wsId, nav]);
  useEffect(() => { if (!wsId) return; api<{ notebooks: Nb[] }>(`/api/v1/workspaces/${wsId}/notebooks`).then(d => { setNbs(d.notebooks); setNbId(d.notebooks[0]?.id); }); }, [wsId]);
  async function refreshTree(id = nbId): Promise<TreeNote[]> { if (!id) return []; const d = await api<{ folders: FolderDto[]; notes: TreeNote[]; canEdit?: boolean }>(`/api/v1/notebooks/${id}/tree`); setFolders(d.folders); setTree(d.notes); setTreeCanEdit(!!d.canEdit); return d.notes; }
  useEffect(() => {
    const id = nbId;
    void (async () => {
      let notes: TreeNote[] = [];
      try { notes = await refreshTree(id); } catch { /* 树加载失败下面照样收尾，别把用户留在别的笔记本的笔记上 */ }
      if (!id || !wsId || autoOpenNb.current !== id) return;
      autoOpenNb.current = null;
      const first = sortNotes(notes, loadNotebookNoteSort(id))[0];
      nav(first ? `/w/${wsId}/n/${first.id}` : `/w/${wsId}`);
    })();
    setActiveFolder(null);
    if (nbId) { setNoteSort(loadNotebookNoteSort(nbId)); api<{ published: boolean; slug: string }>(`/api/v1/notebooks/${nbId}/site`).then(setSite).catch(() => setSite(null)); }
  }, [nbId]);
  /** 换笔记本默认打开新本子的第一篇笔记（空本子退回空状态）；否则编辑区还停在上一个笔记本里，面包屑会显示成「新笔记本 › 旧笔记」。 */
  function pickNotebook(id: string | undefined) { if (!id || id === nbId) return; autoOpenNb.current = id; setNbId(id); }
  function changeNoteSort(mode: NoteSortMode) { setNoteSort(mode); if (nbId) saveNotebookNoteSort(nbId, mode); }
  async function persistNoteOrder(noteIds: string[]) {
    if (!nbId) return;
    const rank = new Map(noteIds.map((id, i) => [id, i]));
    setTree((prev) => prev.map((n) => rank.has(n.id) ? { ...n, sortKey: rank.get(n.id)! } : n));
    try { await api(`/api/v1/notebooks/${nbId}/notes/order`, { method: "PATCH", body: JSON.stringify({ noteIds }) }); }
    catch (e) { toast.error("未能保存自定义顺序", (e as Error).message); void refreshTree(); }
  }
  useEffect(() => { if (!noteId) { setNote(null); setAtts([]); return; } api<NoteDto>(`/api/v1/notes/${noteId}`).then(loaded => { setNote(loaded); noteRef.current = loaded; say(`已保存 · v${loaded.version}`); }); api<{ items: typeof backlinks }>(`/api/v1/notes/${noteId}/backlinks`).then(d => setBacklinks(d.items)); api<{ attachments: Att[] }>(`/api/v1/notes/${noteId}/attachments`).then(d => setAtts(d.attachments)).catch(() => setAtts([])); }, [noteId]);
  useEffect(() => { noteRef.current = note; }, [note]);
  /** 从搜索、快速打开或深链进来的笔记可能不在当前笔记本：侧栏跟着笔记走，面包屑才不会张冠李戴。 */
  useEffect(() => { if (note?.notebookId) setNbId(note.notebookId); }, [note?.notebookId]);

  useEffect(() => {
    if (!noteId) { setViewers([]); setFavorited(false); return; }
    const beat = () => api<{ viewers: string[]; favorited: boolean }>(`/api/v1/notes/${noteId}/visit`, { method: "POST" }).then(d => { setViewers(d.viewers); setFavorited(d.favorited); }).catch(() => { /* 心跳失败不打扰 */ });
    void beat();
    const timer = window.setInterval(beat, 20000);
    return () => clearInterval(timer);
  }, [noteId]);

  function openRail(tab: RailTab | null) { setRailState(tab); saveRailTab(tab); }

  /** 大纲跳转：编辑器滚到源码行，预览滚到对应标题锚点，两边都对上。 */
  function jumpToHeading(slug: string, line: number) {
    editorRef.current?.scrollToLine(line);
    document.querySelector(`[data-note-preview] #${CSS.escape(slug)}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  /** 在正文里选中这段文字并滚过去，用于纠错定位。 */
  function locateInBody(excerpt: string) {
    const body = noteRef.current?.bodyMd ?? "";
    const at = body.indexOf(excerpt);
    if (at < 0) { toast.error("定位失败", "正文里已经找不到这段原文了。"); return; }
    editorRef.current?.selectRange(at, at + excerpt.length);
  }

  async function deleteAttachment(a: Attachment) {
    if (!await askConfirm({ title: `删除附件《${a.filename}》？`, description: "文件会从存储里移除，不可恢复。正文里指向它的链接不会自动清理，需要你自己改。", confirmText: "删除附件", destructive: true })) return;
    try { await api(`/api/v1/attachments/${a.id}`, { method: "DELETE" }); setAtts(v => v.filter(x => x.id !== a.id)); }
    catch (e) { toast.error("删除附件失败", (e as Error).message); }
  }

  async function save(snapshot?: NoteDto) { const current = snapshot ?? noteRef.current; if (!current?.canEdit) return; if (saveTimer.current) clearTimeout(saveTimer.current); say("保存中…"); try { const saved = await api<NoteDto>(`/api/v1/notes/${current.id}`, { method: "PATCH", body: JSON.stringify({ expectedVersion: current.version, title: current.title, bodyMd: current.bodyMd, aiIndex: current.aiIndex, published: current.published, tags: current.tags ?? [] }) }); noteRef.current = saved; setNote(live => live?.id === saved.id && live.bodyMd !== current.bodyMd ? { ...live, version: saved.version } : saved); setTree(t => t.map(n => n.id === saved.id ? { ...n, title: saved.title } : n)); say(`已保存 · v${saved.version}`); } catch (x) { say((x as Error).message, true); } }
  function changeNote(patch: Partial<NoteDto>, instant = false) { if (!note) return; const next = { ...note, ...patch }; setNote(next); noteRef.current = next; say("未保存"); if (saveTimer.current) clearTimeout(saveTimer.current); saveTimer.current = window.setTimeout(() => void save(next), instant ? 0 : 850); }
  async function createNote(folderId: string | null = activeFolder) { if (!nbId || !wsId) return; const n = await api<{ id: string }>("/api/v1/notes", { method: "POST", body: JSON.stringify({ notebookId: nbId, folderId }) }); await refreshTree(); nav(`/w/${wsId}/n/${n.id}`); }
  async function createNamed(kind: Exclude<CreateKind, null>, name: string) { if (kind === "workspace") { const d = await api<{ workspace: Ws }>("/api/v1/workspaces", { method: "POST", body: JSON.stringify({ name }) }); window.location.assign(`/w/${d.workspace.id}`); } else if (kind === "notebook" && wsId) { const n = await api<Nb>(`/api/v1/workspaces/${wsId}/notebooks`, { method: "POST", body: JSON.stringify({ title: name, visibility: "open" }) }); setNbs(v => [...v, n]); pickNotebook(n.id); } else if (kind === "folder" && nbId) { await api("/api/v1/folders", { method: "POST", body: JSON.stringify({ notebookId: nbId, parentId: activeFolder, title: name }) }); await refreshTree(); } }
  async function runSearch(value: string, opts?: { all?: boolean; titleOnly?: boolean }) { setSearch(value); if (!wsId || !value.trim()) return setHits([]); const all = opts?.all ?? allSpaces, only = opts?.titleOnly ?? titleOnly; const params = new URLSearchParams({ q: value, limit: "20" }); if (!all) params.set("workspaceId", wsId); if (only) params.set("titleOnly", "1"); const d = await api<{ hits: Hit[] }>(`/api/v1/search?${params}`); setHits(d.hits); }
  async function deleteCurrent() {
    if (!note || !wsId) return;
    if (!await askConfirm({ title: `把《${note.title || "未命名笔记"}》移到回收站？`, description: "笔记会从列表里消失，30 天内可以在回收站里恢复，之后自动销毁。", confirmText: "移到回收站", destructive: true })) return;
    try { await api(`/api/v1/notes/${note.id}`, { method: "DELETE" }); await refreshTree(); toast.success("已移到回收站"); nav(`/w/${wsId}`); }
    catch (e) { toast.error("删除失败", (e as Error).message); }
  }
  const canDeleteNotebook = (activeWs?.role === "owner" || activeWs?.role === "admin") && !activeWs?.frozen;
  async function deleteNotebook(nb: Nb) {
    if (!wsId || !canDeleteNotebook) return;
    if (!await askConfirm({ title: `删除笔记本《${nb.title}》？`, description: "本内的笔记和文件夹会一起进入回收站，30 天后自动销毁。你可以稍后从回收站整本恢复。", confirmText: "继续删除", destructive: true })) return;
    if (!await askConfirm({ title: "再次确认删除", description: `将移走笔记本《${nb.title}》及其全部内容。请输入完整笔记本名称以确认。`, confirmText: "移到回收站", destructive: true, requireText: nb.title, requireTextLabel: "笔记本名称" })) return;
    try {
      await api(`/api/v1/notebooks/${nb.id}`, { method: "DELETE" });
      const remaining = nbs.filter(x => x.id !== nb.id);
      setNbs(remaining);
      if (nbId === nb.id) {
        setNbId(remaining[0]?.id);
        if (noteId) nav(`/w/${wsId}`);
      }
      toast.success(`已将《${nb.title}》移到回收站`);
    } catch (e) { toast.error("删除笔记本失败", (e as Error).message); }
  }
  /** 笔记本可改名的人：工作区 owner/admin，或这本的创建者。冻结的工作区一律只读。 */
  const canManageNotebook = (nb: Nb) => !activeWs?.frozen && (activeWs?.role === "owner" || activeWs?.role === "admin" || nb.createdBy === me?.id);
  async function renameNotebook(nb: Nb) {
    const title = await askText({ title: "重命名笔记本", label: "笔记本名称", defaultValue: nb.title, confirmText: "保存" });
    if (!title || title.trim() === nb.title) return;
    try { const saved = await api<Nb>(`/api/v1/notebooks/${nb.id}`, { method: "PATCH", body: JSON.stringify({ title: title.trim() }) }); setNbs(v => v.map(x => x.id === nb.id ? { ...x, ...saved } : x)); }
    catch (e) { toast.error("重命名失败", (e as Error).message); }
  }
  async function renameFolder(f: FolderDto) {
    const title = await askText({ title: "重命名目录", label: "目录名称", defaultValue: f.title, confirmText: "保存" });
    if (!title || title.trim() === f.title) return;
    try { await api(`/api/v1/folders/${f.id}`, { method: "PATCH", body: JSON.stringify({ title: title.trim() }) }); await refreshTree(); }
    catch (e) { toast.error("重命名失败", (e as Error).message); }
  }
  async function deleteFolder(f: FolderDto) {
    if (!await askConfirm({ title: `把目录《${f.title}》移到回收站？`, description: "目录连同里面的笔记一起进回收站，30 天内可以恢复，之后自动销毁。", confirmText: "移到回收站", destructive: true })) return;
    try { await api(`/api/v1/folders/${f.id}`, { method: "DELETE" }); if (activeFolder === f.id) setActiveFolder(null); await refreshTree(); toast.success("已移到回收站"); }
    catch (e) { toast.error("删除目录失败", (e as Error).message); }
  }
  async function renameNote(n: TreeNote) {
    const title = await askText({ title: "重命名笔记", label: "笔记标题", defaultValue: n.title, confirmText: "保存" });
    if (!title || title.trim() === n.title) return;
    try {
      // 笔记的 PATCH 要带 expectedVersion，树上没有版本号，先取一次当前笔记。
      const current = await api<NoteDto>(`/api/v1/notes/${n.id}`);
      const saved = await api<NoteDto>(`/api/v1/notes/${n.id}`, { method: "PATCH", body: JSON.stringify({ expectedVersion: current.version, title: title.trim() }) });
      setTree(t => t.map(x => x.id === n.id ? { ...x, title: saved.title } : x));
      if (noteRef.current?.id === n.id) { setNote(saved); noteRef.current = saved; say(`已保存 · v${saved.version}`); }
    } catch (e) { toast.error("重命名失败", (e as Error).message); }
  }
  async function deleteNoteFromTree(n: TreeNote) {
    if (!wsId) return;
    if (!await askConfirm({ title: `把《${n.title || "未命名笔记"}》移到回收站？`, description: "笔记会从列表里消失，30 天内可以在回收站里恢复，之后自动销毁。", confirmText: "移到回收站", destructive: true })) return;
    try { await api(`/api/v1/notes/${n.id}`, { method: "DELETE" }); await refreshTree(); toast.success("已移到回收站"); if (noteId === n.id) nav(`/w/${wsId}`); }
    catch (e) { toast.error("删除失败", (e as Error).message); }
  }
  /** 粘贴 / 拖入 / 工具栏上传共用一条路：存成当前笔记的附件，回一段可直接落进正文的 Markdown。 */
  async function uploadAttachment(file: File): Promise<string | null> {
    const current = noteRef.current;
    if (!current) return null;
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch(`/api/v1/notes/${current.id}/attachments`, { method: "POST", body: form, credentials: "include" });
      const json = await res.json();
      if (!json.ok) { toast.error("上传失败", json.error.message); return null; }
      const a = json.data as Att;
      setAtts(v => [...v, a]);
      return `${a.mime.startsWith("image/") ? "!" : ""}[${a.filename}](${a.url})`;
    } catch (e) { toast.error("上传失败", (e as Error).message); return null; }
  }

  // —— 分栏视图的滚动同步。两边靠 `data-line` 对齐；刚被程序滚过的一侧短暂闭嘴，免得来回抖。——
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const previewBox = useRef<HTMLDivElement | null>(null);
  const syncLock = useRef(0);
  function syncPreview(line: number) {
    const box = previewBox.current;
    if (!box || Date.now() < syncLock.current) return;
    let target: HTMLElement | null = null;
    for (const el of box.querySelectorAll<HTMLElement>("[data-line]")) {
      if (Number(el.dataset.line) > line) break;
      target = el;
    }
    if (!target) return;
    syncLock.current = Date.now() + 160;
    box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top;
  }
  const onPreviewScroll = useRef(() => {
    const box = previewBox.current;
    if (!box || Date.now() < syncLock.current) return;
    const top = box.getBoundingClientRect().top;
    for (const el of box.querySelectorAll<HTMLElement>("[data-line]")) {
      if (el.getBoundingClientRect().bottom < top) continue;
      syncLock.current = Date.now() + 160;
      editorRef.current?.scrollToLine(Number(el.dataset.line));
      return;
    }
  }).current;
  function bindPreview(el: HTMLDivElement | null) {
    if (previewBox.current === el) return;
    previewBox.current?.removeEventListener("scroll", onPreviewScroll);
    previewBox.current = el;
    el?.addEventListener("scroll", onPreviewScroll, { passive: true });
  }

  // —— 三栏布局：宽度可拖、可折叠、记在本机（设计 17 P2）——
  const [layout, setLayout] = useState<LayoutPrefs>(loadLayout);
  useEffect(() => saveLayout(layout), [layout]);
  const [zen, setZen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [cursor, setCursor] = useState<CursorInfo | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);

  function startResize(which: "notebooks" | "tree", event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const key = which === "notebooks" ? "notebooksWidth" : "treeWidth";
    const [min, max] = which === "notebooks" ? [NOTEBOOKS_MIN, NOTEBOOKS_MAX] : [TREE_MIN, TREE_MAX];
    const startX = event.clientX, startWidth = layout[key];
    const move = (e: PointerEvent) => setLayout(v => ({ ...v, [key]: clamp(startWidth + e.clientX - startX, min, max) }));
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.style.cursor = ""; document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
  }

  /** 编辑器全屏。优先要浏览器真全屏，被拒就退化成占满窗口，两种都靠 Esc 退出。 */
  async function toggleZen(next = !zen) {
    setZen(next);
    try {
      if (next) await sectionRef.current?.requestFullscreen?.();
      else if (document.fullscreenElement) await document.exitFullscreen();
    } catch { /* 不给全屏就用占满窗口那套 */ }
  }
  useEffect(() => {
    const onFullscreen = () => { if (!document.fullscreenElement) setZen(false); };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); setPalette(true); return; }
      if (mod && e.code === "Backslash") {
        e.preventDefault();
        setLayout(v => v.showNotebooks || v.showTree ? { ...v, showNotebooks: false, showTree: false } : { ...v, showNotebooks: true, showTree: true });
        return;
      }
      if (e.key === "Escape" && zen && !document.fullscreenElement) void toggleZen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zen]);

  function paletteCommands(): PaletteCommand[] {
    const list: PaletteCommand[] = [
      { id: "new-note", group: "新建", label: "新建笔记", icon: <FilePlus2 />, run: () => void createNote() },
      { id: "new-folder", group: "新建", label: "新建目录", icon: <FolderPlus />, run: () => setCreate("folder") },
      { id: "new-notebook", group: "新建", label: "新建笔记本", icon: <Notebook />, run: () => setCreate("notebook") },
      { id: "zen", group: "编辑器", label: zen ? "退出全屏" : "编辑器全屏", hint: "Esc", icon: zen ? <Minimize2 /> : <Maximize2 />, run: () => void toggleZen() },
      { id: "toggle-sides", group: "编辑器", label: layout.showNotebooks || layout.showTree ? "折叠左侧栏" : "展开左侧栏", hint: "Ctrl+\\", icon: <PanelLeft />, run: () => setLayout(v => v.showNotebooks || v.showTree ? { ...v, showNotebooks: false, showTree: false } : { ...v, showNotebooks: true, showTree: true }) },
      { id: "toggle-notebooks", group: "编辑器", label: layout.showNotebooks ? "折叠笔记本栏" : "展开笔记本栏", icon: <Notebook />, run: () => setLayout(v => ({ ...v, showNotebooks: !v.showNotebooks })) },
      { id: "toggle-tree", group: "编辑器", label: layout.showTree ? "折叠目录栏" : "展开目录栏", icon: <Folder />, run: () => setLayout(v => ({ ...v, showTree: !v.showTree })) },
      { id: "wysiwyg", group: "编辑器", label: layout.wysiwyg ? "切回源码模式（显示标记）" : "切到即时渲染（Typora 模式）", icon: <Type />, run: () => setLayout(v => ({ ...v, wysiwyg: !v.wysiwyg })) },
      { id: "typewriter", group: "编辑器", label: layout.typewriter ? "关闭打字机滚动" : "打开打字机滚动", icon: <PenLine />, run: () => setLayout(v => ({ ...v, typewriter: !v.typewriter })) },
      { id: "quick-open", group: "导航", label: "快速打开笔记", hint: "Ctrl+K", icon: <Search />, run: () => setQuickOpen(true) },
      { id: "calendar", group: "导航", label: "日历", icon: <CalendarDays />, run: () => nav(`/w/${wsId}/calendar`) },
      { id: "today", group: "导航", label: "今天", icon: <Sun />, run: () => nav(`/w/${wsId}/today`) },
      { id: "trash", group: "导航", label: "回收站", icon: <Archive />, run: () => nav(`/w/${wsId}/trash`) },
      { id: "feed", group: "导航", label: "圈子动态", icon: <Users />, run: () => nav(`/w/${wsId}/feed`) },
      { id: "appearance", group: "设置", label: "外观设置", icon: <Paintbrush />, run: () => nav("/settings/appearance") },
      { id: "import", group: "笔记本", label: "导入 Markdown 或 zip", icon: <Upload />, run: () => setShowImport(true) },
    ];
    if (note) list.push(
      { id: "diagram", group: "笔记", label: "AI 画图", icon: <Workflow />, run: () => openRail("diagram") },
      { id: "outline", group: "笔记", label: "大纲", icon: <List />, run: () => openRail("outline") },
      { id: "links", group: "笔记", label: "反向链接", icon: <PanelRight />, run: () => openRail("links") },
      { id: "attachments", group: "笔记", label: "附件", icon: <Paperclip />, run: () => openRail("attachments") },
      { id: "versions", group: "笔记", label: "版本历史", icon: <RotateCcw />, run: () => openRail("versions") },
      { id: "share", group: "笔记", label: "分享这篇", icon: <Share2 />, run: () => setShareTarget({ kind: "note", id: note.id, title: note.title, bodyMd: note.bodyMd }) },
      { id: "upload", group: "笔记", label: "上传附件", icon: <Paperclip />, run: () => document.getElementById("note-attachment-input")?.click() },
      { id: "ai-index", group: "笔记", label: note.aiIndex ? "关闭 AI 可读" : "打开 AI 可读", icon: <Bot />, disabled: !note.canEdit, run: () => changeNote({ aiIndex: !note.aiIndex }, true) },
      { id: "trash-note", group: "笔记", label: "移到回收站", icon: <Trash2 />, disabled: !note.canEdit, run: () => void deleteCurrent() },
    );
    return list;
  }

  function openWiki(title: string) { const target = tree.find(n => n.title.localeCompare(title, undefined, { sensitivity: "accent" }) === 0); if (target) nav(`/w/${wsId}/n/${target.id}`); }
  if (me === undefined) return <div className="grid h-full place-items-center"><Circle className="size-5 animate-pulse fill-current" /></div>;

  return <TooltipProvider delayDuration={300}><div className="flex h-full flex-col bg-background">
    <header className={cn("h-14 shrink-0 items-center gap-3 border-b border-border px-3 md:px-4", zen ? "hidden" : "flex")}>
      <WorkspaceSwitcher spaces={spaces} wsId={wsId} onPick={id => nav(`/w/${id}`)} onCreate={() => setCreate("workspace")} />
      <Tooltip content={layout.showNotebooks || layout.showTree ? "折叠左侧栏（Ctrl+\\）" : "展开左侧栏（Ctrl+\\）"}><Button variant="ghost" size="icon" aria-label="折叠或展开左侧栏" onClick={() => setLayout(v => v.showNotebooks || v.showTree ? { ...v, showNotebooks: false, showTree: false } : { ...v, showNotebooks: true, showTree: true })}><PanelLeft /></Button></Tooltip>
      <Separator orientation="vertical" className="h-5" />
      <AppNav wsId={wsId} active="notes" />
      <div className="relative mx-auto w-full max-w-md"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="h-9 bg-muted/70 pl-9 shadow-none" value={search} onChange={e => void runSearch(e.target.value)} placeholder="搜索这个工作区…" />{search && <Button variant="ghost" size="icon" className="absolute right-0 top-0 size-9" onClick={() => { setSearch(""); setHits([]); }}><X /></Button>}{search.trim() && <div className="absolute left-0 right-0 top-11 z-40 rounded-xl border border-border bg-popover p-1.5 shadow-2xl">
        <div className="flex items-center gap-1 border-b border-border px-1.5 pb-1.5">
          <Button variant={allSpaces ? "secondary" : "ghost"} size="sm" onClick={() => { const v = !allSpaces; setAllSpaces(v); void runSearch(search, { all: v }); }}>{allSpaces ? "全部工作区" : "仅本工作区"}</Button>
          <Button variant={titleOnly ? "secondary" : "ghost"} size="sm" onClick={() => { const v = !titleOnly; setTitleOnly(v); void runSearch(search, { titleOnly: v }); }}>仅标题</Button>
          <span className="ml-auto pr-1 text-[11px] text-muted-foreground">{hits.length} 条</span>
        </div>
        {hits.length === 0 ? <p className="px-3 py-6 text-center text-xs text-muted-foreground">没有匹配的笔记。</p> : hits.map(h => <button key={h.id} className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-muted" onClick={() => { nav(`/w/${h.workspaceId}/n/${h.id}`); setSearch(""); setHits([]); }}><Search className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block truncate">{h.title}</span><span className="block truncate text-[11px] text-muted-foreground">{h.workspaceId !== wsId ? `${spaces.find(w => w.id === h.workspaceId)?.name ?? "其他工作区"} · ` : ""}{h.snippet}</span></span></button>)}</div>}</div>
      <Tooltip content="用 AI 问这个工作区"><Button variant="ghost" size="sm" className="hidden text-muted-foreground lg:inline-flex" onClick={() => setShowAsk(true)}><Sparkles />问知识库</Button></Tooltip>
      <Tooltip content="快速打开（Ctrl+K）"><Button variant="ghost" size="icon" aria-label="快速打开" onClick={() => setQuickOpen(true)}><Search /></Button></Tooltip>
      <NotificationBell />
      <Tooltip content="外观"><Button variant="ghost" size="icon" onClick={() => nav("/settings/appearance")}><Paintbrush /></Button></Tooltip>
      <AccountMenu me={me} wsId={wsId} />
    </header>

    <main className="app-grid grid min-h-0 flex-1" style={{ gridTemplateColumns: [!zen && layout.showNotebooks ? `${layout.notebooksWidth}px` : null, !zen && layout.showTree ? `${layout.treeWidth}px` : null, "minmax(0, 1fr)"].filter(Boolean).join(" ") }}>
      {!zen && layout.showNotebooks && <aside className="notebook-panel relative flex min-h-0 flex-col border-r border-border bg-muted/35 p-2.5">
        <div role="separator" aria-label="调整笔记本栏宽度" onPointerDown={e => startResize("notebooks", e)} className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize hover:bg-primary/20" /><div className="flex h-10 items-center justify-between px-2"><span className="sidebar-copy text-[11px] font-semibold uppercase tracking-[.12em] text-muted-foreground">笔记本</span><Tooltip content="新建笔记本"><Button variant="ghost" size="icon" className="size-7" onClick={() => setCreate("notebook")}><Plus /></Button></Tooltip></div><ScrollArea className="flex-1"><div className="space-y-1">{nbs.map(n => <ContextMenu key={n.id}><ContextMenuTrigger asChild><div className={cn("group flex h-9 items-center rounded-lg transition", n.id === nbId ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground")}><button onClick={() => pickNotebook(n.id)} className="flex h-9 min-w-0 flex-1 items-center gap-2.5 px-2.5 text-left text-sm"><Notebook className="size-4 shrink-0" /><span className="sidebar-copy truncate">{n.title}</span></button>{canDeleteNotebook && <Tooltip content="删除笔记本"><Button variant="ghost" size="icon" aria-label={`删除笔记本 ${n.title}`} className={cn("mr-0.5 size-7 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100", n.id === nbId ? "text-background hover:bg-background/15 hover:text-background" : "hover:text-destructive")} onClick={() => void deleteNotebook(n)}><Trash2 className="size-3.5" /></Button></Tooltip>}</div></ContextMenuTrigger><ContextMenuContent><ContextMenuLabel>{n.title}</ContextMenuLabel><ContextMenuItem disabled={!canManageNotebook(n)} onSelect={() => void renameNotebook(n)}><Pencil />重命名</ContextMenuItem><ContextMenuItem disabled={!canManageNotebook(n)} onSelect={() => { pickNotebook(n.id); setShowNotebookAccess(true); }}><Lock />访问权限</ContextMenuItem><ContextMenuSeparator /><ContextMenuItem onSelect={() => { pickNotebook(n.id); setShowImport(true); }}><Upload />导入 Markdown 或 zip</ContextMenuItem><ContextMenuItem onSelect={() => void downloadZip(`/api/v1/notebooks/${n.id}/export.zip`)}><Download />导出这个笔记本</ContextMenuItem>{canDeleteNotebook && <><ContextMenuSeparator /><ContextMenuItem className="text-destructive" onSelect={() => void deleteNotebook(n)}><Trash2 />删除笔记本</ContextMenuItem></>}</ContextMenuContent></ContextMenu>)}</div></ScrollArea><div className="border-t border-border pt-2"><button onClick={() => nav(`/w/${wsId}/calendar`)} className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"><CalendarDays className="size-4" /><span className="sidebar-copy">日历</span></button><button onClick={() => nav(`/w/${wsId}/today`)} className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"><Sun className="size-4" /><span className="sidebar-copy">今天</span></button><button onClick={() => nav(`/w/${wsId}/trash`)} className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"><Archive className="size-4" /><span className="sidebar-copy">回收站</span></button></div></aside>}

      {!zen && layout.showTree && <aside className="tree-panel relative flex min-h-0 flex-col border-r border-border bg-background">
        <div role="separator" aria-label="调整目录栏宽度" onPointerDown={e => startResize("tree", e)} className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize hover:bg-primary/20" /><div className="flex h-14 items-center gap-1 border-b border-border px-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{activeNb?.title ?? "笔记"}</p><p className="truncate text-[11px] text-muted-foreground">{tree.length} 篇笔记 · {activeNb?.visibility==="private"?"私密":activeNb?.visibility==="restricted"?"指定成员":"全体成员"}</p></div><NoteSortMenu mode={noteSort} onChange={changeNoteSort} /><DropdownMenu><Tooltip content="笔记本操作"><span className="inline-flex"><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="笔记本操作" className="size-8"><MoreHorizontal /></Button></DropdownMenuTrigger></span></Tooltip><DropdownMenuContent align="end">{activeNb && <DropdownMenuItem disabled={!canManageNotebook(activeNb)} onSelect={() => void renameNotebook(activeNb)}><Pencil />重命名笔记本</DropdownMenuItem>}<DropdownMenuItem onSelect={()=>setShowNotebookAccess(true)}><Lock />访问权限</DropdownMenuItem><DropdownMenuItem onSelect={() => setShowImport(true)}><Upload />导入 Markdown 或 zip</DropdownMenuItem><DropdownMenuItem onSelect={() => { if (nbId) void downloadZip(`/api/v1/notebooks/${nbId}/export.zip`); }}><Download />导出这个笔记本</DropdownMenuItem>{canDeleteNotebook && activeNb && <><DropdownMenuSeparator /><DropdownMenuItem className="text-destructive" onSelect={() => void deleteNotebook(activeNb)}><Trash2 />删除笔记本</DropdownMenuItem></>}</DropdownMenuContent></DropdownMenu><Tooltip content="新建文件夹"><Button variant="ghost" size="icon" className="size-8" onClick={() => setCreate("folder")}><FolderPlus /></Button></Tooltip><Tooltip content="新建笔记"><Button size="icon" className="size-8" onClick={() => void createNote()}><FilePlus2 /></Button></Tooltip></div><ScrollArea className="flex-1"><div className="p-2.5"><ContextMenu><ContextMenuTrigger asChild><button onClick={() => setActiveFolder(null)} className={cn("mb-1 flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-sm", activeFolder === null ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/70")}><Folder className="size-4" />全部笔记</button></ContextMenuTrigger><ContextMenuContent><ContextMenuItem disabled={!treeCanEdit} onSelect={() => void createNote(null)}><FilePlus2 />新建笔记</ContextMenuItem><ContextMenuItem disabled={!treeCanEdit} onSelect={() => { setActiveFolder(null); setCreate("folder"); }}><FolderPlus />新建目录</ContextMenuItem></ContextMenuContent></ContextMenu>{folders.map(f => <ContextMenu key={f.id}><ContextMenuTrigger asChild><div className={cn("group mb-1 flex h-9 items-center gap-2 rounded-lg pr-1 text-sm", activeFolder === f.id ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/70")}><button onClick={() => setActiveFolder(f.id)} className="flex h-9 min-w-0 flex-1 items-center gap-2 pl-2.5 text-left"><ChevronRight className="size-3.5 shrink-0" /><Folder className="size-4 shrink-0" /><span className="truncate">{f.title}</span></button><Tooltip content="分享此目录"><Button variant="ghost" size="icon" className="size-7 opacity-0 group-hover:opacity-100" onClick={() => setShareTarget({ kind: "folder", id: f.id, title: f.title })}><Share2 className="size-3.5" /></Button></Tooltip></div></ContextMenuTrigger><ContextMenuContent><ContextMenuLabel>{f.title}</ContextMenuLabel><ContextMenuItem disabled={!treeCanEdit} onSelect={() => void renameFolder(f)}><Pencil />重命名</ContextMenuItem><ContextMenuItem disabled={!treeCanEdit} onSelect={() => void createNote(f.id)}><FilePlus2 />在此新建笔记</ContextMenuItem><ContextMenuItem onSelect={() => setShareTarget({ kind: "folder", id: f.id, title: f.title })}><Share2 />分享此目录</ContextMenuItem><ContextMenuSeparator /><ContextMenuItem className="text-destructive" disabled={!treeCanEdit} onSelect={() => void deleteFolder(f)}><Trash2 />移到回收站</ContextMenuItem></ContextMenuContent></ContextMenu>)}<Separator className="my-3" /><NoteList notes={tree} folderId={activeFolder} noteId={noteId} wsId={wsId} mode={noteSort} canReorder={treeCanEdit} onReorder={persistNoteOrder} onRename={treeCanEdit ? renameNote : undefined} onDelete={treeCanEdit ? deleteNoteFromTree : undefined} /></div></ScrollArea></aside>}

      <section ref={sectionRef} data-zen={zen ? "1" : undefined} className="relative flex min-h-0 min-w-0 flex-col bg-background">{note ? <>
        <input id="note-attachment-input" className="hidden" type="file" onChange={async e=>{const f=e.target.files?.[0];if(!f)return;const md=await uploadAttachment(f);const current=noteRef.current;if(md&&current)changeNote({bodyMd:`${current.bodyMd}\n\n${md}`});e.target.value=''}} />
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4"><div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"><span>{activeNb?.title}</span><ChevronRight className="size-3" /><span className="truncate text-foreground">{note.title || "未命名"}</span></div><div className="ml-auto flex items-center gap-1">{viewers.length > 0 && <Tooltip content={`${viewers.join("、")} 也打开着这篇`}><Badge className="mr-1 gap-1"><Users className="size-3" />{viewers.length === 1 ? `${viewers[0]} 在看` : `${viewers.length} 人在看`}</Badge></Tooltip>}
<Tooltip content={favorited ? "取消收藏" : "收藏这篇"}><Button variant="ghost" size="icon" aria-label={favorited ? "取消收藏" : "收藏"} onClick={async () => { const next = !favorited; setFavorited(next); try { await api(`/api/v1/notes/${note.id}/favorite`, { method: next ? "PUT" : "DELETE" }); } catch (e) { setFavorited(!next); setStatus((e as Error).message); } }}><Star className={favorited ? "fill-current" : ""} /></Button></Tooltip>
<Button size="sm" onClick={() => setShareTarget({ kind: "note", id: note.id, title: note.title, bodyMd: note.bodyMd })}><Share2 /> <span className="hidden sm:inline">分享</span></Button><Tooltip content={note.aiIndex ? "AI 可读取此笔记" : "AI 无法读取此笔记"}><Button variant={note.aiIndex ? "secondary" : "ghost"} size="sm" onClick={() => changeNote({ aiIndex: !note.aiIndex }, true)}><Bot /> <span className="hidden sm:inline">AI 可读</span></Button></Tooltip><Tooltip content={rail ? "收起右栏" : "展开右栏（大纲 / 反向链接 / 附件 / 版本）"}><Button variant={rail ? "secondary" : "ghost"} size="icon" aria-label="右栏" onClick={() => openRail(rail ? null : "outline")}><PanelRight /></Button></Tooltip><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon"><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => openRail("ai")}><Sparkles />AI 写作建议</DropdownMenuItem><DropdownMenuItem onSelect={() => openRail("diagram")}><Workflow />AI 画图</DropdownMenuItem><DropdownMenuItem onSelect={() => openRail("outline")}><List />大纲</DropdownMenuItem><DropdownMenuItem onSelect={() => openRail("versions")}><RotateCcw />版本历史</DropdownMenuItem><DropdownMenuItem onSelect={() => openRail("attachments")}><Paperclip />附件 {atts.length > 0 && <Badge className="ml-auto">{atts.length}</Badge>}</DropdownMenuItem><DropdownMenuItem onSelect={() => openRail("review")}><MessageSquare />评论与纠错</DropdownMenuItem><DropdownMenuItem onSelect={() => openRail("links")}><PanelRight />反向链接 <Badge className="ml-auto">{backlinks.length}</Badge></DropdownMenuItem><DropdownMenuItem onSelect={() => changeNote({ published: !note.published }, true)}><Globe2 />{note.published ? "从文档站隐藏此页" : "在文档站发布此页"}</DropdownMenuItem><DropdownMenuItem onSelect={async () => { if (!nbId) return; const next = !site?.published; const d = await api<{ published: boolean; slug: string }>(`/api/v1/notebooks/${nbId}/site`, { method: "PATCH", body: JSON.stringify({ published: next }) }); setSite(d); }}><Globe2 />{site?.published ? "下线文档站" : "发布笔记本为文档站"}</DropdownMenuItem>{site?.published && <DropdownMenuItem onSelect={() => window.open(site.slug, "_blank")}><ExternalLink />打开文档站</DropdownMenuItem>}<DropdownMenuSeparator /><DropdownMenuItem className="text-destructive" onSelect={() => void deleteCurrent()}><Trash2 />移到回收站</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div></div>
        <div className="relative flex min-h-0 flex-1"><div className="min-h-0 min-w-0 flex-1"><Tabs.Root defaultValue="split" className="flex h-full flex-col"><div className="flex items-center justify-between px-6 pt-6"><Tabs.List className="inline-flex rounded-lg bg-muted p-1"><Tabs.Trigger value="write" className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">编辑</Tabs.Trigger><Tabs.Trigger value="preview" className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">预览</Tabs.Trigger><Tabs.Trigger value="split" className="hidden rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm sm:block">分栏</Tabs.Trigger></Tabs.List><div className="flex items-center gap-1"><Tooltip content={layout.wysiwyg ? "即时渲染：开（点击显示 Markdown 标记）" : "即时渲染：关（点击隐藏标记）"}><Button variant={layout.wysiwyg ? "secondary" : "ghost"} size="icon" className="size-8" aria-label="切换即时渲染" onClick={() => setLayout(v => ({ ...v, wysiwyg: !v.wysiwyg }))}><Type /></Button></Tooltip><Tooltip content="命令面板（Ctrl+Shift+P）"><Button variant="ghost" size="icon" className="size-8" aria-label="命令面板" onClick={() => setPalette(true)}><Terminal /></Button></Tooltip><Tooltip content={zen ? "退出全屏（Esc）" : "编辑器全屏"}><Button variant="ghost" size="icon" className="size-8" aria-label={zen ? "退出全屏" : "编辑器全屏"} onClick={() => void toggleZen()}>{zen ? <Minimize2 /> : <Maximize2 />}</Button></Tooltip></div></div><div className="editor-measure mx-auto flex min-h-0 flex-1 flex-col px-6 pb-6 pt-4"><input className="mb-4 w-full border-0 bg-transparent font-[var(--font-title)] text-3xl font-semibold tracking-[-.045em] outline-none placeholder:text-muted-foreground/40 md:text-4xl" value={note.title} onChange={e => changeNote({ title: e.target.value })} placeholder="无标题" /><Tabs.Content value="write" className="min-h-0 flex-1 overflow-hidden"><MarkdownEditor ref={editorRef} className="h-full" resetKey={note.id} value={note.bodyMd} readOnly={!note.canEdit} onChange={bodyMd => changeNote({ bodyMd })} onSave={() => void save()} onWiki={openWiki} onUpload={uploadAttachment} onCursor={setCursor} typewriter={layout.typewriter} wysiwyg={layout.wysiwyg} completion={{ workspaceId: wsId, excludeNoteId: note.id, notebookNames: Object.fromEntries(nbs.map(n => [n.id, n.title])) }} autoFocus placeholder="开始写作，或输入 [[笔记标题]] 建立双链…" /></Tabs.Content><Tabs.Content value="preview" className="min-h-0 flex-1 overflow-auto"><div data-note-preview className="w-full py-2"><MarkdownView source={note.bodyMd} onWiki={openWiki} onToggleTask={note.canEdit ? bodyMd => changeNote({ bodyMd }, true) : undefined} /></div></Tabs.Content><Tabs.Content value="split" className="min-h-0 flex-1"><div className="grid h-full min-h-0 grid-cols-1 divide-x divide-border overflow-hidden rounded-xl border border-border md:grid-cols-2"><MarkdownEditor ref={editorRef} className="h-full min-h-0 overflow-hidden bg-muted/25 p-5" resetKey={note.id} value={note.bodyMd} readOnly={!note.canEdit} onChange={bodyMd => changeNote({ bodyMd })} onSave={() => void save()} onWiki={openWiki} onUpload={uploadAttachment} onScrollLine={syncPreview} onCursor={setCursor} typewriter={layout.typewriter} wysiwyg={layout.wysiwyg} completion={{ workspaceId: wsId, excludeNoteId: note.id, notebookNames: Object.fromEntries(nbs.map(n => [n.id, n.title])) }} placeholder="开始写作，或输入 [[笔记标题]] 建立双链…" /><ScrollArea className="h-full" viewportRef={bindPreview}><div data-note-preview className="p-6"><MarkdownView source={note.bodyMd} sourceLines onWiki={openWiki} onToggleTask={note.canEdit ? bodyMd => changeNote({ bodyMd }, true) : undefined} /></div></ScrollArea></div></Tabs.Content></div></Tabs.Root></div>
          {rail && <NoteRail
            note={note}
            tab={rail}
            onTab={openRail}
            onClose={() => openRail(null)}
            backlinks={backlinks}
            atts={atts}
            wsId={wsId}
            onJump={jumpToHeading}
            onSearchTag={t => { setSearch(t); void runSearch(t); }}
            onChangeTags={tags => changeNote({ tags }, true)}
            onUpload={() => document.getElementById("note-attachment-input")?.click()}
            onShareAttachment={a => setShareTarget({ kind: "attachment", id: a.id, title: a.filename })}
            onDeleteAttachment={a => void deleteAttachment(a)}
            onInsertAttachment={a => changeNote({ bodyMd: `${note.bodyMd}

${a.mime.startsWith("image/") ? "!" : ""}[${a.filename}](${a.url})` }, true)}
            onRestored={n => { const next = { ...note, ...n }; setNote(next); noteRef.current = next; say(`已恢复 · v${n.version}`); }}
            workspaceId={wsId}
            getSelection={() => editorRef.current?.getSelection() ?? null}
            getDiagramTarget={() => { const at = editorRef.current?.getCursorPos(); return at == null ? null : diagramBlockAt(note.bodyMd, at); }}
            onInsertDiagram={(fence, target) => {
              const editor = editorRef.current;
              const block = ["", "", fence, ""].join("\n");
              // 编辑器开着就就地替换 / 插到光标处；只开预览时退化成接在文末。
              if (!editor) { changeNote({ bodyMd: note.bodyMd + block }); return; }
              if (target) { editor.replaceRange(target.from, target.to, fence); return; }
              const at = editor.getCursorPos() ?? note.bodyMd.length;
              editor.replaceRange(at, at, block);
            }}
            onApplyAi={async (bodyMd, baseVersion) => {
              const saved = await api<NoteDto>(`/api/v1/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ expectedVersion: baseVersion, title: note.title, bodyMd, aiIndex: note.aiIndex, published: note.published, source: "ai_accept" }) });
              setNote(saved); noteRef.current = saved; say(`已保存 · v${saved.version}`);
            }}
            onReviewApplied={() => { void api<NoteDto>(`/api/v1/notes/${note.id}`).then(fresh => { setNote(fresh); noteRef.current = fresh; say(`已保存 · v${fresh.version}`); }); }}
            onLocate={locateInBody}
          />}
        </div>
        <EditorStatusBar status={status} statusErr={statusErr} bodyMd={note.bodyMd} cursor={cursor} readOnly={!note.canEdit} />
      </> : <div className="grid h-full place-items-center p-8"><div className="max-w-sm text-center"><span className="mx-auto grid size-14 place-items-center rounded-2xl bg-muted"><Notebook className="size-6 text-muted-foreground" /></span><h2 className="mt-5 text-lg font-semibold tracking-tight">选择一篇笔记开始</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">从左侧打开现有笔记，或者新建一篇内容。</p><Button className="mt-5" onClick={() => void createNote()}><FilePlus2 />新建笔记</Button></div></div>}</section>
    </main>
    <CreateDialog kind={create} onOpenChange={v => !v && setCreate(null)} onSubmit={name => createNamed(create!, name)} />
    <ShareDialog target={shareTarget} open={!!shareTarget} onOpenChange={v => { if (!v) setShareTarget(null); }} />
    <ImportDialog notebookId={nbId} notebookTitle={activeNb?.title} open={showImport} onOpenChange={setShowImport} onDone={() => void refreshTree()} />
    <CommandPalette open={palette} onOpenChange={setPalette} commands={paletteCommands()} />
    <QuickOpen open={quickOpen} onOpenChange={setQuickOpen} onPick={(ws, note) => nav(`/w/${ws}/n/${note}`)} workspaceNames={Object.fromEntries(spaces.map(w => [w.id, w.name]))} />
    <NotebookAccessDialog notebook={activeNb} workspaceId={wsId} open={showNotebookAccess} onOpenChange={setShowNotebookAccess} onSaved={()=>wsId&&api<{notebooks:Nb[]}>(`/api/v1/workspaces/${wsId}/notebooks`).then(d=>{setNbs(d.notebooks);const fresh=d.notebooks.find(n=>n.id===nbId);if(!fresh)setNbId(d.notebooks[0]?.id)})} />
    <AskDialog open={showAsk} onOpenChange={setShowAsk} workspaceId={wsId} onOpenNote={id=>nav(`/w/${wsId}/n/${id}`)}/>
  </div></TooltipProvider>;
}


type PublicShareData={requiresPassword:boolean;type:string;shareToken?:string;title:string;bodyMd?:string;updatedAt?:string;notebookTitle?:string;noteId?:string|null;noteTitle?:string|null;commentsEnabled?:boolean;correctionsEnabled?:boolean;showBacklinks?:boolean;folders?:Array<{id:string;title:string;parentId:string|null}>;notes?:Array<{id:string;title:string;folderId:string|null}>;attachment?:{filename:string;mime:string;bytes:number;url:string}};
function PublicShare() {
  const { token } = useParams(); const [data, setData] = useState<PublicShareData | null>(null); const [password, setPassword] = useState(""); const [err, setErr] = useState(""); const [pick, setPick] = useState<string | null>(null);
  const load = (noteId?: string | null) => token && api<PublicShareData>(`/api/v1/public/shares/${token}${noteId ? `?noteId=${noteId}` : ""}`).then(setData).catch(e => setErr((e as Error).message));
  useEffect(() => { void load(pick); }, [token, pick]);
  if (err) return <PublicFrame><Empty icon={<Link2 />} title="分享不存在或已失效" text="链接可能已被撤销、过期，或者内容已删除。" /></PublicFrame>;
  if (!data) return <div className="grid h-full place-items-center"><Circle className="size-5 animate-pulse fill-current" /></div>;
  if (data.requiresPassword) return <PublicFrame><div className="mx-auto max-w-sm rounded-2xl border border-border p-7 text-center"><span className="mx-auto grid size-12 place-items-center rounded-xl bg-muted"><Lock className="size-5" /></span><h1 className="mt-4 text-xl font-semibold">此分享受密码保护</h1><p className="mt-2 text-sm text-muted-foreground">输入分享者提供的密码以继续阅读。</p><form className="mt-5 space-y-3" onSubmit={async e => { e.preventDefault(); setErr(""); try { await api(`/api/v1/public/shares/${token}/unlock`, { method: "POST", body: JSON.stringify({ password }) }); setData(null); void load(pick); } catch (x) { setErr((x as Error).message); } }}><Input autoFocus type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="访问密码" /><FormError>{err}</FormError><Button className="w-full">解锁内容</Button></form></div></PublicFrame>;

  if (data.type === "attachment" && data.attachment) { const a = data.attachment;
    return <PublicFrame><div className="mx-auto max-w-xl">{a.mime.startsWith("image/") ? <img src={a.url} alt={a.filename} className="mx-auto max-h-[70vh] rounded-xl border" /> : <div className="rounded-2xl border p-10 text-center"><span className="mx-auto grid size-12 place-items-center rounded-xl bg-muted"><Paperclip className="size-5" /></span><p className="mt-4 text-lg font-medium">{a.filename}</p><p className="mt-1 text-xs text-muted-foreground">{a.mime} · {a.bytes < 1048576 ? `${Math.round(a.bytes / 1024)} KB` : `${(a.bytes / 1048576).toFixed(1)} MB`}</p></div>}<div className="mt-5 text-center"><a href={a.url} download={a.filename}><Button><Download />下载 {a.filename}</Button></a></div></div></PublicFrame>;
  }

  const body = <article className="mx-auto max-w-3xl"><div className="mb-10 border-b border-border pb-8">{data.notebookTitle && <Badge>{data.notebookTitle}</Badge>}<h1 className="mt-4 text-4xl font-semibold tracking-[-.055em] md:text-5xl">{data.type === "folder" ? (data.noteTitle ?? data.title) : data.title}</h1>{data.updatedAt && <p className="mt-4 text-xs text-muted-foreground">更新于 {new Date(data.updatedAt).toLocaleString()}</p>}</div><MarkdownView source={data.bodyMd ?? ""} /></article>;
  const interactions = data.noteId && data.shareToken && (data.commentsEnabled || data.correctionsEnabled) ? <PublicInteractions noteId={data.noteId} shareToken={data.shareToken} commentsEnabled={!!data.commentsEnabled} correctionsEnabled={!!data.correctionsEnabled} bodyMd={data.bodyMd ?? ""} /> : null;

  if (data.type === "folder") {
    const notes = data.notes ?? [];
    return <div className="flex h-full flex-col"><header className="flex h-14 shrink-0 items-center border-b border-border px-5"><Brand /><Badge className="ml-3">目录分享 · {data.title}</Badge></header>
      <div className="grid min-h-0 flex-1 md:grid-cols-[260px_1fr]">
        <aside className="hidden min-h-0 border-r border-border bg-muted/30 md:block"><ScrollArea className="h-full"><div className="p-4"><p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{notes.length} 篇</p>{notes.map(n => <button key={n.id} onClick={() => setPick(n.id)} className={cn("mb-1 w-full rounded-lg px-3 py-2.5 text-left text-sm", n.id === data.noteId ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>{n.title}</button>)}</div></ScrollArea></aside>
        <ScrollArea className="h-full"><main className="px-5 py-10 md:py-16">{notes.length === 0 ? <Empty icon={<Folder />} title="这个目录还没有笔记" text="之后在此目录下新建的笔记会自动出现在这里。" /> : body}{interactions}</main></ScrollArea>
      </div></div>;
  }
  return <PublicFrame>{body}{interactions}</PublicFrame>;
}
function PublicFrame({ children }: { children: ReactNode }) { return <div className="min-h-full bg-background"><header className="flex h-14 items-center border-b border-border px-5"><Brand /><Badge className="ml-3">公开阅读</Badge></header><main className="px-5 py-10 md:py-16">{children}</main></div>; }

function PublicSite() {
  const { wsSlug, nbSlug } = useParams(); const [data, setData] = useState<{ workspace: string; notebook: string; notebookId: string; accent: string | null; notes: Array<{ id: string; title: string; bodyMd: string; updatedAt: string }> } | null>(null); const [active, setActive] = useState<string>(); const [err, setErr] = useState("");
  useEffect(() => { api<typeof data>(`/api/v1/public/sites/${wsSlug}/${nbSlug}`).then(d => { setData(d); setActive(d?.notes[0]?.id); }).catch(e => setErr((e as Error).message)); }, [wsSlug, nbSlug]);
  if (err) return <PublicFrame><Empty icon={<Globe2 />} title="文档站尚未发布" text="此站点不存在，或者管理员已将其下线。" /></PublicFrame>;
  if (!data) return <div className="grid h-full place-items-center"><Circle className="size-5 animate-pulse fill-current" /></div>;
  const current = data.notes.find(n => n.id === active);
  return <div className="flex h-full flex-col" style={data.accent ? ({ "--primary": data.accent } as React.CSSProperties) : undefined}><header className="flex h-14 items-center border-b border-border px-4"><Brand /><Separator orientation="vertical" className="mx-4 h-5" /><span className="font-medium">{data.notebook}</span><span className="ml-auto text-xs text-muted-foreground">{data.workspace}</span></header><div className="grid min-h-0 flex-1 md:grid-cols-[260px_1fr]"><aside className="hidden min-h-0 border-r border-border bg-muted/30 md:block"><ScrollArea className="h-full"><div className="p-4"><p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">目录</p>{data.notes.map(n => <button key={n.id} onClick={() => setActive(n.id)} className={cn("mb-1 w-full rounded-lg px-3 py-2.5 text-left text-sm", n.id === active ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>{n.title}</button>)}</div></ScrollArea></aside><ScrollArea className="h-full"><main className="mx-auto max-w-3xl px-6 py-12"><h1 className="mb-10 text-4xl font-semibold tracking-[-.055em]">{current?.title ?? "暂无公开页面"}</h1>{current && <MarkdownView source={current.bodyMd} />}{current && <PublicInteractions noteId={current.id} siteNotebookId={data.notebookId} commentsEnabled correctionsEnabled bodyMd={current.bodyMd} />}</main></ScrollArea></div></div>;
}

function Members() {
  const askConfirm = useConfirm(); const toast = useToast();
  const { wsId } = useParams(); const nav = useNavigate(); const [kind, setKind] = useState(""); const [ownerId,setOwnerId]=useState(""); const [members, setMembers] = useState<Array<{ userId: string; handle: string; displayName: string; email: string; role: string; joinedAt: string }>>([]); const [handle, setHandle] = useState(""); const [role, setRole] = useState("viewer"); const [invite, setInvite] = useState(""); const [msg, setMsg] = useState("");
  const load = () => wsId && api<{ kind: string; members: typeof members }>(`/api/v1/workspaces/${wsId}/members`).then(d => { setKind(d.kind); setMembers(d.members);setOwnerId(d.members.find(m=>m.role==='owner')?.userId??''); }); useEffect(() => { void load(); }, [wsId]);
  async function add() { if (!handle || !wsId) return; setMsg(""); try { await api(`/api/v1/workspaces/${wsId}/members`, { method: "POST", body: JSON.stringify({ handle, role }) }); setHandle(""); await load(); } catch (e) { setMsg((e as Error).message); } }
  async function makeInvite() { if (!wsId) return; const d = await api<{ url: string }>(`/api/v1/workspaces/${wsId}/invites`, { method: "POST", body: JSON.stringify({ role, expiresInDays: 7, maxUses: 1 }) }); const url = location.origin + d.url; setInvite(url); await navigator.clipboard.writeText(url); }
  return <PageShell title="成员管理" subtitle={kind === "personal" ? "个人工作区只能由你自己使用。请新建普通工作区进行协作。" : "添加成员、调整角色或生成一次性邀请链接。"} back={() => nav(`/w/${wsId}`)}>{kind !== "personal" && <div className="mb-6 rounded-xl border border-border bg-background p-4"><div className="grid gap-3 sm:grid-cols-[1fr_150px_auto_auto]"><Input value={handle} onChange={e => setHandle(e.target.value)} placeholder="对方的用户名" /><select className="h-9 rounded-lg border bg-background px-3 text-sm" value={role} onChange={e => setRole(e.target.value)}><option value="viewer">Viewer</option><option value="editor">Editor</option><option value="admin">Admin</option></select><Button onClick={add}><Users />直接添加</Button><Button variant="outline" onClick={makeInvite}><Link2 />邀请链接</Button></div>{invite && <div className="mt-3 flex items-center gap-2 rounded-lg bg-muted px-3 py-2 font-mono text-xs"><span className="min-w-0 flex-1 truncate">{invite}</span><Badge>已复制</Badge></div>}<FormError className="mt-2">{msg}</FormError></div>}<div className="overflow-hidden rounded-xl border bg-background">{members.map((m, i) => <div key={m.userId} className={cn("flex items-center gap-4 p-4", i && "border-t")}><Avatar.Root className="grid size-10 place-items-center rounded-full bg-foreground text-background"><Avatar.Fallback>{m.displayName.slice(0, 1)}</Avatar.Fallback></Avatar.Root><div className="min-w-0 flex-1"><p className="text-sm font-medium">{m.displayName} <span className="font-normal text-muted-foreground">@{m.handle}</span></p><p className="text-xs text-muted-foreground">{m.email}</p></div><Badge>{m.role}</Badge>{kind !== "personal" && m.role !== "owner" && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon"><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">{m.userId!==ownerId&&<DropdownMenuItem onSelect={async()=>{if(!await askConfirm({title:`把工作区 Owner 转让给 ${m.displayName}？`,description:'转让后对方成为唯一 Owner，你会降级为 Admin，不能再删除或转让这个工作区。需要拿回来只能由对方再转回给你。',confirmText:'转让 Owner',destructive:true}))return;try{await api(`/api/v1/workspaces/${wsId}/transfer`,{method:'POST',body:JSON.stringify({newOwnerUserId:m.userId})});toast.success(`已把 Owner 转让给 ${m.displayName}`);void load()}catch(e){toast.error('转让失败',(e as Error).message)}}}><Users/>转让 Owner</DropdownMenuItem>}{["admin","editor","viewer"].map(r => <DropdownMenuItem key={r} onSelect={async () => { try { await api(`/api/v1/workspaces/${wsId}/members/${m.userId}`, { method: "PATCH", body: JSON.stringify({ role: r }) }); toast.success(`${m.displayName} 的角色已改为 ${r}`); void load(); } catch (e) { toast.error("改角色失败", (e as Error).message); } }}>{r}{m.role === r && <Check className="ml-auto" />}</DropdownMenuItem>)}<DropdownMenuSeparator /><DropdownMenuItem className="text-destructive" onSelect={async () => { try { await api(`/api/v1/workspaces/${wsId}/members/${m.userId}`, { method: "DELETE" }); toast.success(`已把 ${m.displayName} 移出工作区`); void load(); } catch (e) { toast.error("移出失败", (e as Error).message); } }}><Trash2 />移出工作区</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}</div>)}</div></PageShell>;
}

function InvitePage() { const { token } = useParams(); const nav = useNavigate(); const me = useMe(); const [data, setData] = useState<{ workspace: string; role: string; expiresAt: string } | null>(null); const [err, setErr] = useState(""); useEffect(() => { api<typeof data>(`/api/v1/invites/${token}`).then(setData).catch(e => setErr((e as Error).message)); }, [token]); return <PublicFrame>{err ? <Empty icon={<Link2 />} title="邀请已失效" text={err} /> : !data ? <div className="grid place-items-center py-20"><Circle className="animate-pulse fill-current" /></div> : <div className="mx-auto max-w-md rounded-2xl border p-8 text-center"><Users className="mx-auto size-10 text-muted-foreground" /><h1 className="mt-5 text-2xl font-semibold">加入 {data.workspace}</h1><p className="mt-2 text-sm text-muted-foreground">你将以 {data.role} 身份加入此工作区。</p>{me === null ? <Button className="mt-6" onClick={() => location.assign(`/login?redirect=/invite/${token}`)}>登录后加入</Button> : <Button className="mt-6" onClick={async () => { const d = await api<{ workspaceId: string }>(`/api/v1/invites/${token}/accept`, { method: "POST" }); nav(`/w/${d.workspaceId}`); }}>确认加入</Button>}</div>}</PublicFrame>; }

function Trash(){const askConfirm=useConfirm();const toast=useToast();const{wsId}=useParams();const nav=useNavigate();type Item={id:string;title:string;path:string;trashedAt:string;trashedByName:string;purgeAt:string|null};const[data,setData]=useState<{notes:Item[];folders:Item[];notebooks:Item[]}>({notes:[],folders:[],notebooks:[]});const load=()=>wsId&&api<typeof data>(`/api/v1/workspaces/${wsId}/trash`).then(setData);useEffect(()=>{void load()},[wsId]);
  const left=(purgeAt:string|null)=>purgeAt?Math.max(0,Math.ceil((new Date(purgeAt).getTime()-Date.now())/86400000)):null;
  const groups:[string,"note"|"folder"|"notebook",Item[]][]=[["笔记","note",data.notes],["目录","folder",data.folders],["笔记本","notebook",data.notebooks]];
  return <PageShell title="回收站" subtitle="内容保留 30 天；恢复目录或笔记本时会恢复同一删除批次的子内容。" back={()=>nav(`/w/${wsId}`)}>
    <div className="space-y-5">{groups.map(([label,type,items])=>items.length>0&&<section key={type} className="overflow-hidden rounded-xl border"><h2 className="bg-muted/40 px-4 py-3 text-sm font-semibold">{label}</h2>{items.map((n,i)=><div key={n.id} className={cn("flex flex-wrap items-center gap-4 p-4",i&&"border-t")}><span className="grid size-10 place-items-center rounded-lg bg-muted"><Trash2 className="size-4"/></span>
      <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{n.title}</p><p className="truncate text-xs text-muted-foreground">{n.path} · {n.trashedByName} 删除于 {new Date(n.trashedAt).toLocaleString()}{left(n.purgeAt)!==null&&` · ${left(n.purgeAt)} 天后自动销毁`}</p></div>
      <Button variant="outline" size="sm" onClick={async()=>{try{const r=await api<{renamed?:boolean;movedToRoot?:boolean;title?:string}>(`/api/v1/trash/${type}/${n.id}/restore`,{method:"POST"});toast.success("已恢复",r.renamed?`原位置已有同名内容，改名为《${r.title}》。`:r.movedToRoot?"原目录还在回收站里，已放到笔记本根目录。":undefined);void load()}catch(e){toast.error("恢复失败",(e as Error).message)}}}><RotateCcw/>恢复</Button>
      <Button variant="ghost" size="icon" className="text-destructive" aria-label="立即销毁" onClick={async()=>{if(!await askConfirm({title:`立即销毁《${n.title}》？`,description:"连同附件、版本历史和评论一起物理删除，不进回收站也不可恢复。",confirmText:"永久销毁",destructive:true}))return;try{await api(`/api/v1/trash/${type}/${n.id}`,{method:"DELETE"});toast.success(`已彻底销毁《${n.title}》`);void load()}catch(e){toast.error("销毁失败",(e as Error).message)}}}><Trash2/></Button>
    </div>)}</section>)}
    {!data.notes.length&&!data.folders.length&&!data.notebooks.length&&<Empty icon={<Archive/>} title="回收站是空的" text="删除的笔记、目录和笔记本会出现在这里。"/>}</div></PageShell>;}

function PageShell({ title, subtitle, back, children }: { title: string; subtitle: string; back: () => void; children: ReactNode }) { return <div className="min-h-full bg-muted/25"><header className="flex h-14 items-center border-b border-border bg-background px-4"><Button variant="ghost" onClick={back}><ChevronRight className="rotate-180" />返回工作区</Button><div className="ml-auto"><Brand /></div></header><main className="mx-auto max-w-4xl px-5 py-10"><h1 className="text-3xl font-semibold tracking-[-.045em]">{title}</h1><p className="mt-2 text-sm text-muted-foreground">{subtitle}</p><div className="mt-8">{children}</div></main></div>; }
function Empty({ icon, title, text }: { icon: ReactNode; title: string; text: string }) { return <div className="py-20 text-center"><span className="mx-auto grid size-12 place-items-center rounded-xl bg-muted text-muted-foreground">{icon}</span><p className="mt-4 text-sm font-medium">{title}</p><p className="mt-1 text-xs text-muted-foreground">{text}</p></div>; }

function Integrations() { const nav=useNavigate(); const q=new URLSearchParams(location.search); const workspaceId=q.get("workspace")??""; const [providers,setProviders]=useState<Array<{id:string;baseUrl:string;chatModel:string;keySuffix:string}>>([]); const [spaces,setSpaces]=useState<Ws[]>([]); const [provider,setProvider]=useState({baseUrl:"https://api.openai.com/v1",chatModel:"gpt-4o-mini",apiKey:""}); const load=async()=>{if(workspaceId){const p=await api<{providers:typeof providers}>(`/api/v1/workspaces/${workspaceId}/ai/provider`);setProviders(p.providers)}const w=await api<{workspaces:Ws[]}>("/api/v1/workspaces");setSpaces(w.workspaces)};useEffect(()=>{void load()},[workspaceId]);return <PageShell title="AI 与 MCP" subtitle="配置 OpenAI 兼容模型，并为外部 Agent 创建受限钥匙。" back={()=>nav("/app")}><Tabs.Root defaultValue="ai"><Tabs.List className="mb-6 inline-flex rounded-lg bg-muted p-1"><Tabs.Trigger value="ai" className="rounded-md px-4 py-2 text-sm data-[state=active]:bg-background">AI 提供商</Tabs.Trigger><Tabs.Trigger value="mcp" className="rounded-md px-4 py-2 text-sm data-[state=active]:bg-background">MCP 钥匙</Tabs.Trigger></Tabs.List><Tabs.Content value="ai"><div className="rounded-xl border bg-background p-5"><div className="grid gap-3"><Input value={provider.baseUrl} onChange={e=>setProvider({...provider,baseUrl:e.target.value})} placeholder="Base URL"/><Input value={provider.chatModel} onChange={e=>setProvider({...provider,chatModel:e.target.value})} placeholder="模型"/><Input type="password" value={provider.apiKey} onChange={e=>setProvider({...provider,apiKey:e.target.value})} placeholder="API Key"/><Button className="w-fit" onClick={async()=>{await api(`/api/v1/workspaces/${workspaceId}/ai/provider`,{method:"POST",body:JSON.stringify({...provider,personal:false})});setProvider({...provider,apiKey:""});void load()}}>保存工作区配置</Button></div></div><div className="mt-4 space-y-2">{providers.map(p=><div key={p.id} className="flex items-center gap-3 rounded-xl border bg-background p-4"><Bot/><div className="flex-1"><p className="text-sm font-medium">{p.chatModel}</p><p className="text-xs text-muted-foreground">{p.baseUrl} · Key ••••{p.keySuffix}</p></div><Button variant="ghost" size="icon" onClick={async()=>{await api(`/api/v1/ai/providers/${p.id}`,{method:"DELETE"});void load()}}><Trash2/></Button></div>)}</div></Tabs.Content><Tabs.Content value="mcp"><McpPanel workspaces={spaces} defaultWorkspaceId={workspaceId||undefined}/></Tabs.Content></Tabs.Root></PageShell>; }

function Appearance() {
  const { refresh } = useThemeRefresh(); const nav = useNavigate(); const [me, setMe] = useState<Me | null>(null); const [themes, setThemes] = useState<{ id: string; name: string; author?: string }[]>([]); const [accent, setAccent] = useState("#111111"); const [raw, setRaw] = useState(""); const [err, setErr] = useState(""); const toast = useToast();
  useEffect(() => { api<Me>("/api/v1/me").then(m => { setMe(m); setAccent(m.accent ?? "#111111"); }); api<{ themes: typeof themes }>("/api/v1/themes").then(d => setThemes(d.themes)); }, []);
  async function patch(p: Partial<{ appearance: Me["appearance"]; themeId: string; accent: string | null }>) { await api("/api/v1/me/appearance", { method: "PATCH", body: JSON.stringify(p) }); refresh(); }
  const colors = ["#111111", "#52525b", "#2563eb", "#7c3aed", "#0f766e", "#c2410c"];
  return <PageShell title="外观" subtitle="选择明暗模式、强调色和已安装的主题包。" back={() => nav("/app")}><div className="space-y-8"><section><h2 className="text-sm font-semibold">显示模式</h2><p className="mt-1 text-xs text-muted-foreground">跟随操作系统，或固定为浅色、深色。</p><div className="mt-4 grid grid-cols-3 gap-3">{(["system", "light", "dark"] as const).map(mode => <button key={mode} onClick={() => { setMe(me && { ...me, appearance: mode }); void patch({ appearance: mode }); }} className={cn("rounded-xl border p-3 text-left transition hover:border-foreground/30", me?.appearance === mode && "border-primary ring-2 ring-primary/10")}><div className={cn("mb-3 h-20 rounded-lg border p-2", mode === "dark" ? "bg-zinc-900" : mode === "light" ? "bg-white" : "bg-gradient-to-r from-white to-zinc-900")}><div className="h-2 w-1/2 rounded bg-zinc-400/40" /><div className="mt-2 h-8 rounded border border-zinc-400/20" /></div><span className="text-sm font-medium">{mode === "system" ? "跟随系统" : mode === "light" ? "浅色" : "深色"}</span></button>)}</div></section><Separator /><section><h2 className="text-sm font-semibold">强调色</h2><p className="mt-1 text-xs text-muted-foreground">用于按钮、链接和选中状态。</p><div className="mt-4 flex items-center gap-3">{colors.map(c => <button key={c} aria-label={c} onClick={() => { setAccent(c); void patch({ accent: c }); }} className={cn("size-8 rounded-full border-2 border-background shadow-sm ring-offset-2", accent === c && "ring-2 ring-foreground")} style={{ backgroundColor: c }} />)}<label className="relative grid size-8 cursor-pointer place-items-center rounded-full border border-dashed border-border"><Plus className="size-3.5" /><input className="absolute inset-0 opacity-0" type="color" value={accent} onChange={e => { setAccent(e.target.value); void patch({ accent: e.target.value }); }} /></label></div></section><Separator /><section><h2 className="text-sm font-semibold">主题包</h2><p className="mt-1 text-xs text-muted-foreground">主题包只能定义安全的 JSON 设计令牌。</p><div className="mt-4 grid gap-3 sm:grid-cols-2">{themes.map(t => <button key={t.id} onClick={() => { setMe(me && { ...me, themeId: t.id }); void patch({ themeId: t.id }); }} className={cn("flex items-center gap-3 rounded-xl border p-4 text-left hover:bg-muted/50", me?.themeId === t.id && "border-primary ring-2 ring-primary/10")}><span className="grid size-10 place-items-center rounded-lg bg-foreground text-background"><Paintbrush className="size-4" /></span><span><b className="block text-sm">{t.name}</b><small className="text-muted-foreground">{t.author ?? "本地主题"}</small></span>{me?.themeId === t.id && <Check className="ml-auto" />}</button>)}</div><details className="mt-4 rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm font-medium">导入 theme.json</summary><div className="mt-4 space-y-3"><Textarea className="min-h-40 font-mono text-xs" value={raw} onChange={e => setRaw(e.target.value)} placeholder="粘贴主题 JSON…" /><Button size="sm" onClick={async () => { setErr(""); try { await api("/api/v1/themes/import", { method: "POST", body: JSON.stringify(JSON.parse(raw)) }); const d = await api<{ themes: typeof themes }>("/api/v1/themes"); setThemes(d.themes); toast.success("主题已安装"); } catch (x) { setErr((x as Error).message); } }}>导入主题</Button><FormError>{err}</FormError></div></details></section></div></PageShell>;
}

/** 圈子和广场共用的外壳：同一条顶栏（身份 + 三处导航 + 通知 + 账号）、同一套两栏。
    圈子原来套的是 PageShell，进去只剩一个「返回工作区」，看着像跳出了产品；现在它和笔记页是同一个系统的三个页签，
    退出靠顶栏的「笔记」，不再需要一个专门的返回按钮。 */
function FeedShell({ identity, active, wsId, me, title, subtitle, notice, rail, children }: {
  identity: ReactNode; active: NavPlace; wsId?: string; me: Me | null | undefined;
  title: string; subtitle: ReactNode; notice?: ReactNode; rail: ReactNode; children: ReactNode;
}) {
  const nav = useNavigate();
  return <div className="flex h-full min-h-0 flex-col bg-muted/25">
    <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-background">
      <div className="mx-auto flex h-14 w-full max-w-[1180px] items-center gap-2 px-4 sm:gap-3 sm:px-6">
        {identity}
        <Separator orientation="vertical" className="hidden h-5 sm:block" />
        <AppNav wsId={wsId} active={active} />
        <div className="ml-auto flex items-center gap-1">
          {me ? <><NotificationBell /><Button variant="ghost" size="icon" aria-label="外观设置" onClick={() => nav("/settings/appearance")}><Paintbrush /></Button><AccountMenu me={me} wsId={wsId} /></>
            : me === null ? <><Button variant="ghost" size="sm" onClick={() => nav("/login")}>登录</Button><Button size="sm" onClick={() => nav("/register")}>注册</Button></> : null}
        </div>
      </div>
    </header>
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1180px] px-4 py-8 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-[-.035em]">{title}</h1>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{subtitle}</p>
        {notice}
        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0">{children}</div>
          <aside>{rail}</aside>
        </div>
      </div>
    </main>
  </div>;
}

function Square() {
  const me = useMe(); const nav = useNavigate();
  const [spaces, setSpaces] = useState<Ws[]>([]); const [posts, setPosts] = useState<FeedPost[]>([]);
  useEffect(() => { if (me) api<{ workspaces: Ws[] }>("/api/v1/workspaces").then(d => setSpaces(d.workspaces)).catch(() => setSpaces([])); }, [me]);
  /** 顶栏的「笔记 / 圈子」要有个落点：优先最后待过的库，其次个人库。都没有（还没加载完 / 未登录）就只剩「广场」一项。 */
  const last = loadLastWorkspace();
  const home = spaces.find(w => w.id === last)?.id ?? me?.personalWorkspaceId ?? spaces[0]?.id;
  const openNote = (ws: string, note: string) => nav(`/w/${ws}/n/${note}`);
  return <FeedShell
    identity={home ? <button className="-mx-1 flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-muted" aria-label="回到我的知识库" onClick={() => nav(`/w/${home}`)}><Brand /></button> : <Brand />}
    active="square" wsId={home} me={me}
    title="广场" subtitle="整个实例的公开时间线。这里发的东西谁都看得到，写给自己人的用圈子。"
    rail={<SquareRail posts={posts} me={me} homeWsId={home} onOpenNote={openNote} onNav={to => nav(to)} />}
  >
    <FeedView scope="public" workspaces={spaces} canPost={!!me} onOpenNote={openNote} onLoaded={setPosts} />
  </FeedShell>;
}

function WorkspaceFeed() {
  const { wsId } = useParams(); const nav = useNavigate(); const me = useMe(); const squareOn = useSquareEnabled();
  const [spaces, setSpaces] = useState<Ws[]>([]); const [posts, setPosts] = useState<FeedPost[]>([]); const [create, setCreate] = useState<CreateKind>(null);
  useEffect(() => { api<{ workspaces: Ws[] }>("/api/v1/workspaces").then(d => setSpaces(d.workspaces)).catch(() => setSpaces([])); }, []);
  useEffect(() => { if (wsId) saveLastWorkspace(wsId); }, [wsId]);
  const here = spaces.find(w => w.id === wsId);
  if (!wsId) return null;
  /** 只读的两种理由要分开说：冻结是工作区的状态，Viewer 是自己的角色，混成一句「不能发」用户不知道该找谁。 */
  const readOnly = here ? here.role === "viewer" || !!here.frozen : false;
  const openNote = (ws: string, note: string) => nav(`/w/${ws}/n/${note}`);
  return <FeedShell
    identity={<WorkspaceSwitcher spaces={spaces} wsId={wsId} onPick={id => nav(`/w/${id}/feed`)} onCreate={() => setCreate("workspace")} />}
    active="circle" wsId={wsId} me={me}
    title="圈子动态" subtitle={<>只有 <b className="font-medium text-foreground">{here?.name ?? "这个工作区"}</b> 的成员看得到。碎片想法先发这里，值得留的再转正为笔记。</>}
    notice={readOnly ? <p className="mt-4 rounded-xl border border-dashed px-3 py-2 text-xs text-muted-foreground">{here?.frozen ? "工作区已冻结，圈子现在只能看。" : "你在这个工作区是 Viewer，可以看动态但不能发。"}</p> : undefined}
    rail={<CircleRail wsId={wsId} wsName={here?.name ?? "这个工作区"} wsKind={here?.kind ?? ""} canInvite={here?.kind !== "personal" && (here?.role === "owner" || here?.role === "admin")} posts={posts} squareEnabled={squareOn} onOpenNote={openNote} onNav={to => nav(to)} />}
  >
    <FeedView scope="workspace" workspaceId={wsId} workspaces={spaces} canPost={!!me && !readOnly} onOpenNote={openNote} onLoaded={setPosts} />
    <CreateDialog kind={create} onOpenChange={v => !v && setCreate(null)} onSubmit={async name => { const d = await api<{ workspace: Ws }>("/api/v1/workspaces", { method: "POST", body: JSON.stringify({ name }) }); nav(`/w/${d.workspace.id}/feed`); }} />
  </FeedShell>;
}

function PublicProfile() { const { handle } = useParams();
  type Profile={handle:string;displayName:string;bio:string|null;joinedAt:string;posts:FeedPost[];sites:Array<{title:string;url:string}>};
  const [data,setData]=useState<Profile|null>(null); const [err,setErr]=useState("");
  useEffect(()=>{ api<Profile>(`/api/v1/public/users/${handle}`).then(setData).catch(e=>setErr((e as Error).message)); },[handle]);
  if(err) return <PublicFrame><Empty icon={<Users/>} title="用户不存在" text="这个主页可能已注销，或者从来没有过。" /></PublicFrame>;
  if(!data) return <div className="grid h-full place-items-center"><Circle className="size-5 animate-pulse fill-current" /></div>;
  return <PublicFrame><div className="mx-auto max-w-2xl">
    <div className="flex items-center gap-4 border-b pb-8"><Avatar.Root className="grid size-16 place-items-center rounded-full bg-foreground text-xl font-semibold text-background"><Avatar.Fallback>{data.displayName.slice(0,1)}</Avatar.Fallback></Avatar.Root>
      <div className="min-w-0"><h1 className="text-2xl font-semibold tracking-[-.03em]">{data.displayName}</h1><p className="text-sm text-muted-foreground">@{data.handle} · 加入于 {new Date(data.joinedAt).toLocaleDateString()}</p>{data.bio&&<p className="mt-2 text-sm">{data.bio}</p>}</div></div>
    {data.sites.length>0&&<section className="mt-8"><h2 className="mb-3 text-sm font-semibold">公开的文档站</h2><div className="space-y-2">{data.sites.map(s=><a key={s.url} href={s.url} className="flex items-center gap-2.5 rounded-xl border p-3 text-sm hover:bg-muted"><Globe2 className="size-4 text-muted-foreground"/>{s.title}</a>)}</div></section>}
    <section className="mt-8"><h2 className="mb-3 text-sm font-semibold">广场动态</h2>
      {data.posts.length===0?<p className="py-10 text-center text-sm text-muted-foreground">还没有公开动态。</p>
      :<div className="space-y-3">{data.posts.map(p=><article key={p.id} className="rounded-2xl border bg-background p-4"><p className="text-xs text-muted-foreground">{new Date(p.createdAt).toLocaleString()}{p.editedAt?" · 已编辑":""}</p><p className="mt-2 whitespace-pre-wrap text-sm leading-7">{p.body}</p><p className="mt-2 text-xs text-muted-foreground">{p.likes} 次喜欢</p></article>)}</div>}
    </section>
  </div></PublicFrame>;
}

function Manage() { const { wsId } = useParams(); const nav = useNavigate(); const [ws, setWs] = useState<Ws | null>(null); const load = () => api<{ workspaces: Ws[] }>("/api/v1/workspaces").then(d => setWs(d.workspaces.find(x => x.id === wsId) ?? null)); useEffect(() => { void load(); }, [wsId]); if (!wsId) return null;
  const tab = "rounded-md px-4 py-2 text-sm data-[state=active]:bg-background";
  const pending = ws?.deletionScheduledAt ? ` · 将于 ${new Date(ws.deletionScheduledAt).toLocaleString()} 注销` : ws?.frozen ? " · 已冻结，当前只读" : "";
  return <PageShell title="工作区管理" subtitle={`${ws?.name ?? "工作区"}${pending}。备份、分享、导出、审计、冻结与注销集中在这里。`} back={() => nav(`/w/${wsId}`)}>
    <Tabs.Root defaultValue="backup"><Tabs.List className="mb-6 inline-flex rounded-lg bg-muted p-1"><Tabs.Trigger value="backup" className={tab}>备份</Tabs.Trigger><Tabs.Trigger value="shares" className={tab}>分享</Tabs.Trigger><Tabs.Trigger value="transfer" className={tab}>导出与恢复</Tabs.Trigger><Tabs.Trigger value="audit" className={tab}>审计日志</Tabs.Trigger><Tabs.Trigger value="danger" className={tab}>危险操作</Tabs.Trigger></Tabs.List>
      <Tabs.Content value="backup"><BackupPanel workspaceId={wsId} /></Tabs.Content>
      <Tabs.Content value="shares"><SharesPanel workspaceId={wsId} /></Tabs.Content>
      <Tabs.Content value="transfer"><TransferPanel workspaceId={wsId} workspaceName={ws?.name ?? "工作区"} /></Tabs.Content>
      <Tabs.Content value="audit"><AuditPanel workspaceId={wsId} /></Tabs.Content>
      <Tabs.Content value="danger"><DangerPanel workspaceId={wsId} workspaceName={ws?.name ?? ""} kind={ws?.kind ?? ""} role={ws?.role ?? ""} frozen={ws?.frozen ?? false} deletionScheduledAt={ws?.deletionScheduledAt} onChanged={() => void load()} /></Tabs.Content>
    </Tabs.Root></PageShell>;
}

export function App() { const me = useMe(); return <Routes><Route path="/" element={<Square />} /><Route path="/login" element={<Login />} /><Route path="/register" element={<Register />} /><Route path="/forgot-password" element={<ForgotPassword />} /><Route path="/reset-password" element={<ResetPassword />} /><Route path="/verify-email" element={<VerifyEmail />} /><Route path="/app" element={me === undefined ? null : me === null ? <Navigate to="/login" replace /> : me.personalWorkspaceId ? <Navigate to={`/w/${me.personalWorkspaceId}`} replace /> : <Navigate to="/login" />} /><Route path="/w/:wsId" element={<Workspace />} /><Route path="/w/:wsId/n/:noteId" element={<Workspace />} /><Route path="/w/:wsId/calendar" element={<CalendarPage />} /><Route path="/w/:wsId/today" element={<TodayPage />} /><Route path="/w/:wsId/trash" element={<Trash />} /><Route path="/w/:wsId/members" element={<Members />} /><Route path="/w/:wsId/manage" element={<Manage />} /><Route path="/w/:wsId/feed" element={<WorkspaceFeed />} /><Route path="/u/:handle" element={<PublicProfile />} /><Route path="/invite/:token" element={<InvitePage />} /><Route path="/admin" element={<AdminPage />} /><Route path="/p/:token" element={<PublicShare />} /><Route path="/s/:wsSlug/:nbSlug" element={<PublicSite />} /><Route path="/oauth/consent" element={<OauthConsent />} /><Route path="/settings/integrations" element={<Integrations />} /><Route path="/settings/appearance" element={<Appearance />} /></Routes>; }
