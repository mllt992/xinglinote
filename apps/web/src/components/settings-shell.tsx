import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Archive, ArrowUpRight, BellRing, Bot, ChevronRight, CloudUpload, Download, FileClock, HardDrive, Kanban, Link2,
  Paintbrush, ShieldAlert, ShieldCheck, Snowflake, Sparkles, TriangleAlert, UserRound, Users,
} from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";
import { loadLastWorkspace } from "./app-nav";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

/**
 * 设置类页面的公共外壳（设计 14 §14.1）。
 *
 * 以前只有 /w/:id/settings 长这样，回收站、AI 与 MCP、外观各自套一个只有「返回工作区」的 PageShell，
 * 从设置点过去面包屑、身份卡、左栏导航全没了，观感上像跳出了产品。现在这几页都长在这一个骨架上，
 * 「回收站 / 圈子动态 / AI 与 MCP」也从脚注式的「相关页面」升成导航里的一等条目。
 */

export const cardCls = "rounded-xl border border-border bg-background";

/** 设置壳认的所有落点。前八个是 /w/:id/settings 的 ?tab=，后面是独立路由。 */
export type SettingsPlace =
  | "overview" | "members" | "shares" | "backup" | "transfer" | "audit" | "moderation" | "danger"
  | "trash" | "feed" | "projects" | "integrations" | "profile" | "appearance" | "notifications" | "account";

type NavItem = {
  id: SettingsPlace;
  label: string;
  hint: string;
  icon: typeof Users;
  /** 这一项去哪。wsId 一定有值——壳解析不出工作区时整个左栏都不渲染。 */
  to: (wsId: string) => string;
  managerOnly?: boolean;
  /** 点了会离开设置壳（圈子动态是应用页，不是设置分区）。标出来，别让人以为点进去还在原地。 */
  leaves?: boolean;
  /** 个人工作区没有「成员」这回事，但成员页还得能进（看角色、退出），只有邀请那块会自己藏。 */
  personalHidden?: boolean;
};

const tab = (id: string) => (wsId: string) => id === "overview" ? `/w/${wsId}/settings` : `/w/${wsId}/settings?tab=${id}`;

export const SETTINGS_NAV: Array<{ title: string; items: NavItem[] }> = [
  {
    title: "工作区",
    items: [
      { id: "overview", label: "概览", hint: "这个工作区现在是什么状态，有什么该处理。", icon: Sparkles, to: tab("overview") },
      { id: "members", label: "成员与邀请", hint: "谁在里面、各自能做什么、别人怎么进来。", icon: Users, to: tab("members") },
      { id: "shares", label: "分享与外链", hint: "所有对外开的口子：分享链接和日历订阅地址。", icon: Link2, to: tab("shares") },
      { id: "backup", label: "备份", hint: "打包加密后上传到你自己的 WebDAV 或 S3。", icon: CloudUpload, to: tab("backup"), managerOnly: true },
      { id: "transfer", label: "导入与导出", hint: "把数据原样拿走，或从导出文件搬回来。", icon: Download, to: tab("transfer") },
      { id: "audit", label: "审计日志", hint: "成员变更、备份、MCP 写入都记在这里。", icon: FileClock, to: tab("audit"), managerOnly: true },
      { id: "moderation", label: "内容审核", hint: "AI 从圈子动态里拦下来的内容，等你拍板。", icon: ShieldCheck, to: tab("moderation"), managerOnly: true },
    ],
  },
  {
    title: "内容",
    items: [
      { id: "trash", label: "回收站", hint: "删掉的东西在这里躺 30 天，过期自动销毁。", icon: Archive, to: wsId => `/w/${wsId}/trash` },
      { id: "projects", label: "项目", hint: "交付面：看板、甘特、计时和脉搏。", icon: Kanban, to: wsId => `/w/${wsId}/projects`, leaves: true },
      { id: "feed", label: "圈子动态", hint: "只有本工作区成员看得到的时间线。", icon: Users, to: wsId => `/w/${wsId}/feed`, leaves: true },
      { id: "integrations", label: "AI 与 MCP", hint: "配置 OpenAI 兼容模型，并为外部 Agent 创建受限钥匙。", icon: Bot, to: wsId => `/w/${wsId}/settings/integrations` },
    ],
  },
  {
    title: "账号",
    items: [
      { id: "profile", label: "个人资料", hint: "设置公开显示名、用户名和个人简介。", icon: UserRound, to: () => "/settings/profile" },
      { id: "account", label: "存储与服务", hint: "看自己用了多少空间，向管理员申请扩容。", icon: HardDrive, to: () => "/settings/account" },
      { id: "appearance", label: "外观", hint: "选择明暗模式、强调色和已安装的主题包。", icon: Paintbrush, to: () => "/settings/appearance" },
      { id: "notifications", label: "通知与推送", hint: "日历提醒发到哪里；哪几台设备能收到推送。", icon: BellRing, to: () => "/settings/notifications" },
    ],
  },
  {
    title: "危险区",
    items: [
      { id: "danger", label: "冻结与注销", hint: "会影响所有人的不可逆操作。", icon: ShieldAlert, to: tab("danger"), managerOnly: true },
    ],
  },
];

const ALL_ITEMS = SETTINGS_NAV.flatMap(g => g.items);
export const settingsItem = (id: SettingsPlace) => ALL_ITEMS.find(i => i.id === id) ?? ALL_ITEMS[0];

export type ShellWorkspace = { id: string; name: string; kind: string; role: string; frozen?: boolean };

/** 壳自己兜底解析工作区：外观页没有 wsId，但左栏不该因此塌掉。 */
function useShellWorkspace(wsId: string | undefined, given: ShellWorkspace | null | undefined) {
  const [spaces, setSpaces] = useState<ShellWorkspace[] | null>(null);
  const need = !given;
  useEffect(() => {
    if (!need) return;
    let alive = true;
    api<{ workspaces: ShellWorkspace[] }>("/api/v1/workspaces")
      .then(d => alive && setSpaces(d.workspaces))
      .catch(() => alive && setSpaces([]));
    return () => { alive = false; };
  }, [need]);
  return useMemo(() => {
    if (given) return given;
    if (!spaces) return null;
    const pick = wsId ?? loadLastWorkspace();
    return spaces.find(w => w.id === pick) ?? spaces.find(w => w.kind === "personal") ?? spaces[0] ?? null;
  }, [given, spaces, wsId]);
}

export function SettingsShell({
  wsId, current, workspace, counts, title, subtitle, loading, error, onRetry, children,
}: {
  /** 工作区级页面传路由里的 wsId；外观这种账号级页面不传，壳会挑一个最近待过的库来撑导航。 */
  wsId?: string;
  current: SettingsPlace;
  /** 调用方已经拿到工作区信息时传进来，省掉壳自己那次请求带来的抖动。 */
  workspace?: ShellWorkspace | null;
  counts?: Partial<Record<SettingsPlace, number>>;
  /** 不传就用导航表里登记的标题和说明——绝大多数页面都不需要自己写一遍。 */
  title?: string;
  subtitle?: ReactNode;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  children: ReactNode;
}) {
  const nav = useNavigate();
  const loc = useLocation();
  const ws = useShellWorkspace(wsId, workspace);
  const item = settingsItem(current);
  const canManage = ws?.role === "owner" || ws?.role === "admin";
  const personal = ws?.kind === "personal";
  const homeId = ws?.id;

  /** 同一路由内换页签用 replace，跨路由用 push：在设置里点几下不该把返回键堆满。 */
  const go = (to: string) => {
    const samePage = to.split("?")[0] === loc.pathname;
    nav(to, samePage ? { replace: true } : undefined);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return <div className="min-h-full bg-muted/25">
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/90 px-4 backdrop-blur">
      <Button variant="ghost" onClick={() => nav(homeId ? `/w/${homeId}` : "/app")}><ChevronRight className="rotate-180" />返回工作区</Button>
      <nav aria-label="位置" className="ml-1 hidden min-w-0 items-center gap-1.5 text-sm text-muted-foreground md:flex">
        <span className="truncate font-medium text-foreground">{ws?.name ?? "工作区"}</span>
        <ChevronRight className="size-3.5" />
        <span>{title ?? item.label}</span>
      </nav>
      <div className="ml-auto flex items-center gap-2">
        {ws?.frozen && <Badge className="gap-1 border-destructive/40 text-destructive"><Snowflake className="size-3" />已冻结</Badge>}
        {homeId && <Button variant="outline" size="sm" onClick={() => nav(`/w/${homeId}`)}>打开工作区<ArrowUpRight /></Button>}
      </div>
    </header>

    <div className="mx-auto grid max-w-[1440px] gap-6 px-4 py-6 lg:grid-cols-[264px_minmax(0,1fr)] lg:gap-8 lg:px-6 lg:py-8">
      <aside className="min-w-0 lg:sticky lg:top-[4.5rem] lg:self-start">
        <div className={cn(cardCls, "mb-3 flex items-center gap-3 p-3")}>
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary text-lg font-semibold text-primary-foreground">{(ws?.name ?? "工").slice(0, 1)}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold tracking-[-0.01em]">{ws?.name ?? "…"}</p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{personal ? "个人工作区" : "协作工作区"} · {ROLE_LABEL[ws?.role ?? ""] ?? "成员"}</p>
          </div>
        </div>

        {/* 窄屏把四组拍平成一条横向滚动条：分组标题在这个宽度里只会占地方。 */}
        <nav aria-label="设置导航" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:block lg:overflow-visible lg:pb-0">
          {SETTINGS_NAV.map(group => {
            const items = group.items.filter(i => (!i.managerOnly || canManage) && (!i.personalHidden || !personal));
            if (!items.length || !homeId) return null;
            return <div key={group.title} className="contents lg:mb-3 lg:block lg:last:mb-0">
              <p className="hidden px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground lg:block">{group.title}</p>
              {items.map(i => {
                const Icon = i.icon;
                const active = i.id === current;
                const n = counts?.[i.id];
                return <button key={i.id} type="button" onClick={() => go(i.to(homeId))} aria-current={active ? "page" : undefined}
                  className={cn("group flex w-full shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                    active ? "bg-background font-medium shadow-sm ring-1 ring-border" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    i.id === "danger" && !active && "hover:text-destructive")}>
                  <Icon className={cn("size-4 shrink-0", active && "text-primary")} />
                  <span className="flex-1 whitespace-nowrap">{i.label}</span>
                  {n != null && n > 0 && <span className="rounded-full px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">{n}</span>}
                  {i.leaves && <ArrowUpRight className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />}
                </button>;
              })}
            </div>;
          })}
        </nav>
      </aside>

      <main className="min-w-0">
        <div className="mb-5">
          <h1 className="text-2xl font-semibold tracking-[-0.035em]">{title ?? item.label}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">{subtitle ?? item.hint}</p>
        </div>

        {error ? <ErrorCard message={error} onRetry={onRetry} />
          : loading ? <ShellSkeleton />
            : children}
      </main>
    </div>
  </div>;
}

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", editor: "Editor", viewer: "Viewer" };

function ErrorCard({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className={cn(cardCls, "p-10 text-center")}>
    <span className="mx-auto grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground"><TriangleAlert className="size-5" /></span>
    <p className="mt-3 text-sm font-medium">这个页面没打开</p>
    <p className="mt-1 text-xs text-muted-foreground">{message}</p>
    {onRetry && <Button className="mt-4" variant="outline" onClick={onRetry}>重试</Button>}
  </div>;
}

function ShellSkeleton() {
  return <div className="space-y-3">
    <div className="h-32 animate-pulse rounded-xl border border-border bg-muted/60" />
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map(i => <div key={i} className="h-24 animate-pulse rounded-xl border border-border bg-muted/60" />)}</div>
  </div>;
}

/* ------------------------------- 页面内的区块 ------------------------------- */

/** 带标题栏的卡片：设置页里所有分区都是这个形状，别再各写各的 border + padding。 */
export function SectionCard({ icon, title, desc, action, children, className }: {
  icon?: ReactNode; title: ReactNode; desc?: ReactNode; action?: ReactNode; children?: ReactNode; className?: string;
}) {
  return <section className={cn(cardCls, className)}>
    <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
      {icon && <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">{icon}</span>}
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-semibold">{title}</h2>
        {desc && <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>}
      </div>
      {action}
    </header>
    {children}
  </section>;
}

/** 卡片里的一行：左图标 + 主副文案 + 右动作。回收站、AI 提供商、备份目标都是这个形状。 */
export function Row({ icon, title, desc, actions, first }: {
  icon?: ReactNode; title: ReactNode; desc?: ReactNode; actions?: ReactNode; first?: boolean;
}) {
  return <div className={cn("flex flex-wrap items-center gap-3 px-4 py-3", !first && "border-t border-border")}>
    {icon && <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">{icon}</span>}
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-medium">{title}</p>
      {desc && <p className="mt-0.5 truncate text-xs text-muted-foreground">{desc}</p>}
    </div>
    {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
  </div>;
}

/** 带标签和说明的表单字段。规范 §11.2：输入框不能只有 placeholder，一填字说明就没了。 */
export function Field({ label, hint, htmlFor, children }: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return <div className="grid gap-1.5">
    <label htmlFor={htmlFor} className="text-sm font-medium">{label}</label>
    {children}
    {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
  </div>;
}

export function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return <div className="px-6 py-14 text-center">
    <span className="mx-auto grid size-12 place-items-center rounded-xl bg-muted text-muted-foreground">{icon}</span>
    <p className="mt-4 text-sm font-medium">{title}</p>
    <p className="mt-1 text-xs text-muted-foreground">{text}</p>
    {action && <div className="mt-4">{action}</div>}
  </div>;
}
