import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpen, Compass, Kanban, LayoutGrid, Users } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";
import { askFeedRefresh, feedUpdateTotal, formatFeedUpdateLabel, useFeedBadges } from "./feed-updates";

/** 顶栏认的几个「地方」。问知识库不在其中：它是一个动作（开右侧问答栏），不是一个能停留的页面。 */
export type NavPlace = "notes" | "projects" | "circle" | "square" | "nav";

const LAST_WS_KEY = "kb.last-workspace";
/** 广场没有 wsId。记下最后待过的工作区，从广场点「笔记 / 项目 / 圈子」才回得去原来那个库，而不是被扔回个人库。 */
export function saveLastWorkspace(id: string) { try { localStorage.setItem(LAST_WS_KEY, id); } catch { /* 隐私模式忽略 */ } }
export function loadLastWorkspace(): string | undefined { try { return localStorage.getItem(LAST_WS_KEY) ?? undefined; } catch { return undefined; } }

export type InstanceMeta = { squareEnabled: boolean; navEnabled?: boolean; helpSource?: "builtin" | "external"; helpUrl?: string | null };
let metaOnce: Promise<InstanceMeta> | null = null;

export function useInstanceMeta() {
  const [meta, setMeta] = useState<InstanceMeta>({ squareEnabled: true, navEnabled: true, helpSource: "builtin", helpUrl: null });
  useEffect(() => {
    metaOnce ??= api<InstanceMeta>("/api/v1/meta");
    void metaOnce.then(m => setMeta({ ...m, squareEnabled: m.squareEnabled, navEnabled: m.navEnabled !== false })).catch(() => {});
  }, []);
  return meta;
}

/** 实例可以关广场（09 §4.1）。关了就别在顶栏挂一个点进去只会报「广场已关闭」的入口。 */
export function useSquareEnabled() {
  return useInstanceMeta().squareEnabled;
}

/** 导航总闸（设计 19）。关掉后顶栏不再出现「导航」。 */
export function useNavEnabled() {
  return useInstanceMeta().navEnabled !== false;
}

/**
 * 笔记 / 项目 / 广场 / 圈子 / 导航共用的顶栏。各处都渲染同一个组件、同一套选中态，
 * 用户才看得出自己在哪、点下去会去哪。顺序见设计 23。
 */
export function AppNav({ wsId, active, className }: { wsId?: string; active: NavPlace; className?: string }) {
  const nav = useNavigate();
  const meta = useInstanceMeta();
  const squareOn = meta.squareEnabled;
  const navOn = meta.navEnabled !== false;
  const home = wsId || loadLastWorkspace();
  const badges = useFeedBadges({ workspaceId: home, square: squareOn });
  const items: Array<{ id: NavPlace; label: string; icon: typeof BookOpen; to: string; count: number; hint?: string }> = [];
  if (home) {
    items.push({ id: "notes", label: "笔记", icon: BookOpen, to: `/w/${home}`, count: 0 });
    items.push({ id: "projects", label: "项目", icon: Kanban, to: `/w/${home}/projects`, count: 0 });
  }
  if (squareOn) items.push({ id: "square", label: "广场", icon: LayoutGrid, to: "/", count: feedUpdateTotal(badges.square), hint: formatFeedUpdateLabel(badges.square) });
  if (home) items.push({ id: "circle", label: "圈子", icon: Users, to: `/w/${home}/feed`, count: feedUpdateTotal(badges.circle), hint: formatFeedUpdateLabel(badges.circle) });
  if (navOn) items.push({ id: "nav", label: "导航", icon: Compass, to: "/nav", count: 0 });
  if (!items.length) return null;
  return <nav aria-label="主导航" className={cn("inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-1", className)}>
    {items.map(i => {
      const Icon = i.icon; const current = i.id === active;
      return <button key={i.id} title={i.hint || undefined} onClick={() => {
        if (current && (i.id === "circle" || i.id === "square")) askFeedRefresh(i.id === "square" ? "public" : "workspace");
        nav(i.to);
      }} aria-current={current ? "page" : undefined}
        className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors",
          current ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
        <Icon className="size-4 shrink-0" /><span className="hidden sm:inline">{i.label}</span>
        {i.count > 0 && <span className="grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">{i.count > 99 ? "99+" : i.count}</span>}
      </button>;
    })}
  </nav>;
}
