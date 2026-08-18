import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpen, LayoutGrid, Users } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";

/** 顶栏认的三个「地方」。问知识库不在其中：它是一个动作（开对话框），不是一个能停留的页面。 */
export type NavPlace = "notes" | "circle" | "square";

const LAST_WS_KEY = "kb.last-workspace";
/** 广场没有 wsId。记下最后待过的工作区，从广场点「笔记 / 圈子」才回得去原来那个库，而不是被扔回个人库。 */
export function saveLastWorkspace(id: string) { try { localStorage.setItem(LAST_WS_KEY, id); } catch { /* 隐私模式忽略 */ } }
export function loadLastWorkspace(): string | undefined { try { return localStorage.getItem(LAST_WS_KEY) ?? undefined; } catch { return undefined; } }

let metaOnce: Promise<{ squareEnabled: boolean }> | null = null;
/** 实例可以关广场（09 §4.1）。关了就别在顶栏挂一个点进去只会报「广场已关闭」的入口。 */
export function useSquareEnabled() {
  const [on, setOn] = useState(true);
  useEffect(() => { metaOnce ??= api<{ squareEnabled: boolean }>("/api/v1/meta"); void metaOnce.then(m => setOn(m.squareEnabled)).catch(() => setOn(true)); }, []);
  return on;
}

/**
 * 笔记 / 圈子 / 广场共用的顶栏导航。三处都渲染同一个组件、同一套选中态，
 * 用户才看得出自己在哪、点下去会去哪；以前四个一模一样的 ghost 按钮谁也不像「当前页」。
 */
export function AppNav({ wsId, active, className }: { wsId?: string; active: NavPlace; className?: string }) {
  const nav = useNavigate();
  const squareOn = useSquareEnabled();
  const items: Array<{ id: NavPlace; label: string; icon: typeof BookOpen; to: string }> = [];
  if (wsId) items.push({ id: "notes", label: "笔记", icon: BookOpen, to: `/w/${wsId}` }, { id: "circle", label: "圈子", icon: Users, to: `/w/${wsId}/feed` });
  if (squareOn) items.push({ id: "square", label: "广场", icon: LayoutGrid, to: "/" });
  if (items.length < 2) return null;
  return <nav aria-label="主导航" className={cn("inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-1", className)}>
    {items.map(i => {
      const Icon = i.icon; const current = i.id === active;
      return <button key={i.id} onClick={() => nav(i.to)} aria-current={current ? "page" : undefined}
        className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors",
          current ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
        <Icon className="size-4 shrink-0" /><span className="hidden sm:inline">{i.label}</span>
      </button>;
    })}
  </nav>;
}
