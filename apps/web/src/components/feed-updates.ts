import { useEffect, useState } from "react";
import { api } from "../api";

export type FeedUpdateCounts = { newPosts: number; repliedPosts: number; now?: string };

const SEEN_EVENT = "kb:feed-seen";
export const FEED_REFRESH_EVENT = "kb:feed-refresh";

export function feedSeenKey(scope: "public" | "workspace", workspaceId?: string) {
  return scope === "public" ? "kb.feed.seen.public" : `kb.feed.seen.ws.${workspaceId}`;
}

export function commentsOpenKey(scope: "public" | "workspace", workspaceId?: string) {
  return scope === "public" ? "kb.feed.comments-open.public" : `kb.feed.comments-open.ws.${workspaceId}`;
}

/** 本页会话记住展开的那楼，刷新不丢。 */
export function readOpenComments(scope: "public" | "workspace", workspaceId?: string): string | null {
  try { return sessionStorage.getItem(commentsOpenKey(scope, workspaceId)); } catch { return null; }
}

export function writeOpenComments(scope: "public" | "workspace", workspaceId: string | undefined, postId: string | null) {
  try {
    const key = commentsOpenKey(scope, workspaceId);
    if (postId) sessionStorage.setItem(key, postId);
    else sessionStorage.removeItem(key);
  } catch { /* 隐私模式忽略 */ }
}

/** 第一次进这个时间线记「现在」，历史帖不算未读。 */
export function readFeedSeen(scope: "public" | "workspace", workspaceId?: string): string {
  try {
    const key = feedSeenKey(scope, workspaceId);
    const saved = localStorage.getItem(key);
    if (saved) return saved;
    const now = new Date().toISOString();
    localStorage.setItem(key, now);
    return now;
  } catch {
    return new Date().toISOString();
  }
}

export function writeFeedSeen(scope: "public" | "workspace", workspaceId: string | undefined, at: string) {
  try { localStorage.setItem(feedSeenKey(scope, workspaceId), at); } catch { /* 隐私模式忽略 */ }
  window.dispatchEvent(new CustomEvent(SEEN_EVENT, { detail: { scope, workspaceId, at } }));
}

export function askFeedRefresh(scope: "public" | "workspace") {
  window.dispatchEvent(new CustomEvent(FEED_REFRESH_EVENT, { detail: { scope } }));
}

export function updatesPath(scope: "public" | "workspace", workspaceId?: string) {
  return scope === "public" ? "/api/v1/feed/public/updates" : `/api/v1/feed/workspaces/${workspaceId}/updates`;
}

export function feedUpdateTotal(u: FeedUpdateCounts) {
  return Math.max(0, (u.newPosts || 0) + (u.repliedPosts || 0));
}

export function formatFeedUpdateLabel(u: FeedUpdateCounts) {
  const parts: string[] = [];
  if (u.newPosts > 0) parts.push(`${u.newPosts > 99 ? "99+" : u.newPosts} 条新动态`);
  if (u.repliedPosts > 0) parts.push(`${u.repliedPosts > 99 ? "99+" : u.repliedPosts} 条有新回复`);
  return parts.join(" · ");
}

/**
 * 顶栏 / 左栏用的水位。跟时间线里的横幅共用 localStorage，点过「查看」两边一起清。
 * 页签不可见时停，避免后台空转。
 */
export function useFeedBadges(opts: { workspaceId?: string; square?: boolean }) {
  const empty: FeedUpdateCounts = { newPosts: 0, repliedPosts: 0 };
  const [square, setSquare] = useState(empty);
  const [circle, setCircle] = useState(empty);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      if (opts.square) {
        try {
          const d = await api<FeedUpdateCounts>(`${updatesPath("public")}?since=${encodeURIComponent(readFeedSeen("public"))}`);
          if (alive) setSquare(d);
        } catch { if (alive) setSquare(empty); }
      } else if (alive) setSquare(empty);
      if (opts.workspaceId) {
        try {
          const d = await api<FeedUpdateCounts>(`${updatesPath("workspace", opts.workspaceId)}?since=${encodeURIComponent(readFeedSeen("workspace", opts.workspaceId))}`);
          if (alive) setCircle(d);
        } catch { if (alive) setCircle(empty); }
      } else if (alive) setCircle(empty);
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 45_000);
    const onVis = () => { if (document.visibilityState === "visible") void poll(); };
    const onSeen = (e: Event) => {
      const d = (e as CustomEvent<{ scope?: string; workspaceId?: string }>).detail;
      if (d?.scope === "public") setSquare(empty);
      if (d?.scope === "workspace" && (!d.workspaceId || d.workspaceId === opts.workspaceId)) setCircle(empty);
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener(SEEN_EVENT, onSeen);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener(SEEN_EVENT, onSeen);
    };
  }, [opts.square, opts.workspaceId]);

  return { square, circle };
}
