import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Circle, Lock, Share2, UserPlus, Users } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import type { CollabPeer, CollabStatus } from "../editor/collab";

type Person = {
  userId: string; displayName: string; handle: string;
  wsRole: string | null; can: "edit" | "read"; via: "workspace" | "notebook" | "owner"; me: boolean;
};
type Data = {
  people: Person[]; workspaceId: string; workspaceKind: string; frozen: boolean;
  notebookVisibility: string; canInvite: boolean;
};

const VIA_LABEL: Record<Person["via"], string> = {
  workspace: "工作区角色",
  notebook: "笔记本单独授权",
  owner: "笔记本创建者",
};
const VISIBILITY_LABEL: Record<string, string> = {
  open: "全体成员可见",
  restricted: "指定成员可见",
  private: "私密，只有创建者",
};

/**
 * 「协作」面板。
 *
 * 协同没有「开启协同」这个动作——它跟着 ACL 走（设计 17 §3.4）。但没有动作不等于没有入口：
 * 用户想拉人一起写的时候，需要一个地方回答「谁能编这篇 / 怎么再拉一个人 / 此刻谁在」。
 * 这个面板就是那个地方，同时把它和对外只读「分享」在措辞上彻底分开。
 */
export function CollabDialog({ noteId, open, onOpenChange, collab, viewers, onShare }: {
  noteId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  collab: { status: CollabStatus; peers: CollabPeer[] };
  viewers: string[];
  onShare: () => void;
}) {
  const nav = useNavigate();
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    setErr("");
    api<Data>(`/api/v1/notes/${noteId}/collaborators`).then(setData).catch(e => setErr((e as Error).message));
  }, [open, noteId]);

  const editors = data?.people.filter(p => p.can === "edit") ?? [];
  const readers = data?.people.filter(p => p.can === "read") ?? [];

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><Users className="size-5" />协作</DialogTitle>
        <DialogDescription>
          站内一起写。谁能编这篇由工作区成员与笔记本权限决定，打开同一篇就自动进同一个协同房间——没有「开启协同」这一步。
        </DialogDescription>
      </DialogHeader>

      <section className="rounded-xl border border-border">
        <h3 className="border-b border-border px-4 py-2.5 text-xs font-medium text-muted-foreground">此刻在这篇</h3>
        <div className="space-y-2 px-4 py-3">
          <p className="flex items-center gap-1.5 text-xs">
            {collab.status === "connected"
              ? <><Circle className="size-2 fill-[var(--good)] text-[var(--good)]" />协同已连上</>
              : collab.status === "connecting"
                ? <span className="text-muted-foreground">正在连协同…</span>
                : <><Circle className="size-2 fill-current opacity-40" /><span className="text-muted-foreground">离线编辑（连不上协同，正在用单机自动保存）</span></>}
          </p>
          {collab.peers.length > 0 ? <div className="flex flex-wrap gap-1.5">
            {collab.peers.map(p => <Badge key={p.id} className="gap-1.5">
              <span className="size-2 rounded-full" style={{ background: p.color }} />
              {p.name}{p.editing ? " · 正在编辑" : ""}
            </Badge>)}
          </div>
            : viewers.length > 0
              ? <p className="text-xs text-muted-foreground">{viewers.join("、")} 也打开着这篇（还没进协同房间）。</p>
              : <p className="text-xs text-muted-foreground">此刻只有你。</p>}
        </div>
      </section>

      <section className="rounded-xl border border-border">
        <h3 className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs font-medium text-muted-foreground">
          <Lock className="size-3" />谁能编这篇
          {data && <span className="ml-auto font-normal">所在笔记本：{VISIBILITY_LABEL[data.notebookVisibility] ?? data.notebookVisibility}</span>}
        </h3>
        {err && <p className="px-4 py-3 text-xs text-destructive">{err}</p>}
        {!err && !data && <div className="space-y-2 p-4">{[0, 1].map(i => <div key={i} className="h-8 animate-pulse rounded-lg bg-muted/60" />)}</div>}
        {data && <div className="max-h-56 overflow-y-auto">
          {[["可编辑", editors], ["只能看", readers]].map(([label, list]) => (list as Person[]).length > 0 && <div key={label as string}>
            <p className="px-4 pt-2.5 text-[11px] text-muted-foreground">{label as string}</p>
            {(list as Person[]).map(p => <div key={p.userId} className="flex items-center gap-2 px-4 py-1.5 text-sm">
              <span className={cn("grid size-6 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-medium", p.me && "bg-primary text-primary-foreground")}>{p.displayName.slice(0, 1)}</span>
              <span className="truncate">{p.displayName}{p.me && "（你）"}</span>
              <span className="truncate text-xs text-muted-foreground">@{p.handle}</span>
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{VIA_LABEL[p.via]}</span>
            </div>)}
          </div>)}
          {data.frozen && <p className="px-4 py-2 text-xs text-[var(--warning)]">工作区已冻结，现在谁都写不了。</p>}
        </div>}
      </section>

      <div className="flex flex-wrap items-center gap-2">
        {data?.canInvite && <Button size="sm" onClick={() => { onOpenChange(false); nav(`/w/${data.workspaceId}/settings?tab=members`); }}>
          <UserPlus />邀请成员
        </Button>}
        {data && data.workspaceKind === "personal" && <p className="text-xs text-muted-foreground">
          这是个人工作区，只有你自己。要跟人一起写，先建一个团队工作区，把笔记移过去。
        </p>}
        {data && data.workspaceKind !== "personal" && !data.canInvite && <p className="text-xs text-muted-foreground">
          只有工作区 Owner / Admin 能邀请新成员。
        </p>}
        {/* 协作和分享是两件事，两边互相留个出口，省得再有人拿分享当协同用 */}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => { onOpenChange(false); onShare(); }}>
          <Share2 />只想给人看？去分享
        </Button>
      </div>
    </DialogContent>
  </Dialog>;
}
