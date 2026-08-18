import { useEffect, useState } from "react";
import { AlertCircle, Check, Crosshair, MessageSquare, PenLine, X } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Textarea } from "./ui/textarea";
import { Tooltip } from "./ui/tooltip";
import { useToast } from "./ui/toast";

type Comment = { id: string; body: string; guestName?: string | null; status: string; createdAt: string };
type Correction = {
  id: string;
  originalExcerpt: string;
  suggested: string;
  comment?: string | null;
  guestName?: string | null;
  status: string;
  createdAt: string;
};
type Interactions = { comments: Comment[]; corrections: Correction[] };

const STATUS_LABELS: Record<string, string> = {
  visible: "已通过",
  rejected: "已拒绝",
  hidden: "已隐藏",
  accepted: "已采纳",
  stale: "原文已变，未应用",
};

function who(name?: string | null) {
  return name || "访客";
}

function CorrectionCard({
  fix,
  bodyMd,
  onLocate,
  onReview,
  readOnly,
}: {
  fix: Correction;
  bodyMd: string;
  onLocate: (excerpt: string) => void;
  onReview: (action: "accept" | "reject", suggested?: string) => void;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fix.suggested);
  // 正文里找不到这段原文，说明它已经被改过了，接受一定失败——提前说，别让人白点。
  const found = bodyMd.includes(fix.originalExcerpt);

  return (
    <div className="rounded-xl border border-border p-3">
      <div className="mb-2 flex items-center gap-2">
        <PenLine className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {who(fix.guestName)} · {new Date(fix.createdAt).toLocaleString("zh-CN")}
        </span>
        {readOnly
          ? <span className="shrink-0 text-[11px] text-muted-foreground">{STATUS_LABELS[fix.status] ?? fix.status}</span>
          : (
            <Tooltip content={found ? "在正文里选中这句" : "正文里已经找不到这段原文"}>
              <span className="inline-flex">
                <Button variant="ghost" size="icon" className="size-7" disabled={!found} aria-label="定位到正文" onClick={() => onLocate(fix.originalExcerpt)}>
                  <Crosshair />
                </Button>
              </span>
            </Tooltip>
          )}
      </div>

      <p className="rounded-lg bg-destructive/5 p-2 text-xs leading-5 text-destructive line-through">{fix.originalExcerpt}</p>
      {editing ? (
        <Textarea className="mt-1.5 min-h-16 font-mono text-xs" value={draft} onChange={e => setDraft(e.target.value)} />
      ) : (
        <p className="mt-1.5 rounded-lg bg-green-500/5 p-2 text-xs leading-5 text-green-700 dark:text-green-400">{draft}</p>
      )}
      {fix.comment && <p className="mt-2 text-xs text-muted-foreground">留言：{fix.comment}</p>}
      {!found && !readOnly && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertCircle className="size-3.5" />原文已经变了，这条只能拒绝。
        </p>
      )}

      {!readOnly && (
        <div className="mt-2 flex flex-wrap justify-end gap-1.5">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEditing(v => !v)}>
            {editing ? "收起编辑" : "改一下再采纳"}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onReview("reject")}><X />拒绝</Button>
          <Button size="sm" className="h-7 px-2 text-xs" disabled={!found} onClick={() => onReview("accept", draft === fix.suggested ? undefined : draft)}>
            <Check />采纳
          </Button>
        </div>
      )}
    </div>
  );
}

export function ReviewTab({
  note,
  onLocate,
  onApplied,
}: {
  note: { id: string; bodyMd: string };
  /** 把正文里的这段选中并滚过去。 */
  onLocate: (excerpt: string) => void;
  /** 采纳纠错会产生新版本，宿主要重新拉一次笔记。 */
  onApplied: () => void;
}) {
  const [tab, setTab] = useState<"pending" | "handled">("pending");
  const [data, setData] = useState<Interactions>({ comments: [], corrections: [] });
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  async function load(scope: "pending" | "handled") {
    setLoading(true);
    try {
      setData(await api<Interactions>(`/api/v1/notes/${note.id}/interactions${scope === "handled" ? "?scope=handled" : ""}`));
    } catch (e) {
      toast.error("读取互动失败", (e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(tab); }, [note.id, tab]);

  async function reviewComment(id: string, status: "visible" | "rejected") {
    try {
      await api(`/api/v1/comments/${id}/review`, { method: "PATCH", body: JSON.stringify({ status }) });
      setData(d => ({ ...d, comments: d.comments.filter(c => c.id !== id) }));
    } catch (e) { toast.error("操作失败", (e as Error).message); }
  }

  async function reviewFix(id: string, action: "accept" | "reject", suggested?: string) {
    try {
      const r = await api<{ status: string }>(`/api/v1/corrections/${id}/review`, {
        method: "PATCH",
        body: JSON.stringify({ action, ...(suggested ? { suggested } : {}) }),
      });
      setData(d => ({ ...d, corrections: d.corrections.filter(f => f.id !== id) }));
      if (r.status === "accepted") { toast.success("已采纳并生成新版本"); onApplied(); }
      else if (r.status === "stale") toast.error("没能应用", "正文已经变了，这条被标成失效。");
    } catch (e) { toast.error("操作失败", (e as Error).message); }
  }

  async function approveAllComments() {
    const ids = data.comments.map(c => c.id);
    for (const id of ids) await reviewComment(id, "visible");
    if (ids.length) toast.success(`已通过 ${ids.length} 条评论`);
  }

  const empty = data.comments.length === 0 && data.corrections.length === 0;
  const readOnly = tab === "handled";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="inline-flex rounded-lg bg-muted p-1">
          {([["pending", "待审"], ["handled", "已处理"]] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn("rounded-md px-2.5 py-1 text-xs font-medium", tab === key ? "bg-background shadow-sm" : "text-muted-foreground")}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "pending" && data.comments.length > 1 && (
          <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-[11px]" onClick={() => void approveAllComments()}>
            全部通过评论
          </Button>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-3">
          {loading ? (
            <p className="py-16 text-center text-sm text-muted-foreground">读取中…</p>
          ) : empty ? (
            <div className="py-16 text-center">
              <MessageSquare className="mx-auto mb-3 size-8 text-muted-foreground/40" />
              <p className="text-sm font-medium">{readOnly ? "还没有处理过的记录" : "没有待审的内容"}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {readOnly ? "通过、拒绝、采纳过的都会留在这里。" : "分享页上的评论和纠错建议会先到这里等你审。"}
              </p>
            </div>
          ) : (
            <>
              {data.corrections.length > 0 && (
                <p className="px-1 text-[11px] font-semibold uppercase tracking-[.12em] text-muted-foreground">纠错 {data.corrections.length}</p>
              )}
              {data.corrections.map(fix => (
                <CorrectionCard
                  key={fix.id}
                  fix={fix}
                  bodyMd={note.bodyMd}
                  readOnly={readOnly}
                  onLocate={onLocate}
                  onReview={(action, suggested) => void reviewFix(fix.id, action, suggested)}
                />
              ))}

              {data.comments.length > 0 && (
                <p className="px-1 pt-2 text-[11px] font-semibold uppercase tracking-[.12em] text-muted-foreground">评论 {data.comments.length}</p>
              )}
              {data.comments.map(c => (
                <div key={c.id} className="rounded-xl border border-border p-3">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                      {who(c.guestName)} · {new Date(c.createdAt).toLocaleString("zh-CN")}
                    </span>
                    {readOnly && <span className="shrink-0 text-[11px] text-muted-foreground">{STATUS_LABELS[c.status] ?? c.status}</span>}
                  </div>
                  <p className="my-2 whitespace-pre-wrap text-sm leading-6">{c.body}</p>
                  {!readOnly && (
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => void reviewComment(c.id, "rejected")}><X />拒绝</Button>
                      <Button size="sm" className="h-7 px-2 text-xs" onClick={() => void reviewComment(c.id, "visible")}><Check />通过</Button>
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
