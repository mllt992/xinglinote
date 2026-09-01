import { useEffect, useState } from "react";
import { CheckCircle2, Circle, Crosshair, MessageCircleReply, Quote, RotateCcw, Send, Trash2 } from "lucide-react";
import { api } from "../api";
import { commentAnchorAt, pickQuoteSelection, resolveCommentAnchor, type CommentAnchor, type TextSelection } from "../lib/note-comments";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Textarea } from "./ui/textarea";
import { useConfirm } from "./ui/confirm";
import { useToast } from "./ui/toast";
import { UserAvatar } from "./user-avatar";

type Author = { id: string | null; displayName: string; avatarUrl: string | null };
type Message = {
  id: string; body: string; author: Author; mine: boolean; canDelete: boolean;
  createdAt: string; editedAt: string | null;
};
type Discussion = Message & {
  status: "visible" | "resolved"; resolvedAt: string | null; canManage: boolean;
  anchor: CommentAnchor | null; replies: Message[];
};

function stamp(value: string) {
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function ReplyBox({ thread, onSent }: { thread: Discussion; onSent: () => void }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const toast = useToast();
  if (!open) return <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setOpen(true)}><MessageCircleReply />回复</Button>;
  return <form className="mt-2 space-y-2" onSubmit={async event => {
    event.preventDefault();
    if (!body.trim() || sending) return;
    setSending(true);
    try {
      await api(`/api/v1/discussions/${thread.id}/replies`, { method: "POST", body: JSON.stringify({ body }) });
      setBody(""); setOpen(false); onSent();
    } catch (error) { toast.error("回复失败", (error as Error).message); }
    finally { setSending(false); }
  }}>
    <Textarea autoFocus value={body} onChange={event => setBody(event.target.value)} maxLength={4000} placeholder="写下回复…" className="min-h-16 text-xs" />
    <div className="flex justify-end gap-1.5"><Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>取消</Button><Button size="sm" disabled={!body.trim() || sending}><Send />回复</Button></div>
  </form>;
}

export function NoteCommentsTab({
  note, getSelection, selectedQuote, onLocate,
}: {
  note: { id: string; bodyMd: string; version: number; canEdit: boolean };
  getSelection: () => TextSelection | null;
  selectedQuote: TextSelection | null;
  onLocate: (from: number, to: number) => void;
}) {
  const [resolved, setResolved] = useState(false);
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState("");
  const [anchor, setAnchor] = useState<CommentAnchor | null>(null);
  const [sending, setSending] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  async function load() {
    setLoading(true);
    try {
      const data = await api<{ discussions: Discussion[] }>(`/api/v1/notes/${note.id}/discussions${resolved ? "?resolved=1" : ""}`);
      setDiscussions(data.discussions);
    } catch (error) { toast.error("读取评论失败", (error as Error).message); }
    finally { setLoading(false); }
  }

  function captureSelection(report = true) {
    const selection = pickQuoteSelection(getSelection(), null, note.bodyMd);
    if (!selection) { if (report) toast.error("请先在正文里选中要引用的内容"); return; }
    if (selection.text.length > 2000) { if (report) toast.error("引用内容不能超过 2000 个字符"); return; }
    const next = commentAnchorAt(note.bodyMd, note.version, selection);
    if (!next) { if (report) toast.error("选区与当前正文不一致，请重新选择"); return; }
    setAnchor(next);
  }

  useEffect(() => { void load(); }, [note.id, resolved]);
  // 从编辑器选中文字后第一次打开评论栏，直接带入引用，少一次点击。
  useEffect(() => { captureSelection(false); }, [note.id]);
  // 评论栏已经打开时，正文每形成一个新选区就直接替换引用，不再让用户跨区域点按钮。
  useEffect(() => {
    if (!selectedQuote || selectedQuote.text.length > 2000) return;
    const next = commentAnchorAt(note.bodyMd, note.version, selectedQuote);
    if (next) setAnchor(next);
  }, [selectedQuote]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!body.trim() || sending) return;
    setSending(true);
    try {
      await api(`/api/v1/notes/${note.id}/discussions`, { method: "POST", body: JSON.stringify({ body, anchor }) });
      setBody(""); setAnchor(null); await load(); toast.success("评论已发表");
    } catch (error) { toast.error("发表评论失败", (error as Error).message); }
    finally { setSending(false); }
  }

  async function changeStatus(thread: Discussion) {
    const status = thread.status === "resolved" ? "visible" : "resolved";
    try {
      await api(`/api/v1/discussions/${thread.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      setDiscussions(items => items.filter(item => item.id !== thread.id));
      toast.success(status === "resolved" ? "已标记为解决" : "已重新打开");
    } catch (error) { toast.error("操作失败", (error as Error).message); }
  }

  async function remove(path: string, label: string) {
    if (!await confirm({ title: `删除这条${label}？`, description: label === "评论" ? "整条讨论和回复会从侧栏隐藏。" : "这条回复会从讨论中隐藏。", confirmText: "删除", destructive: true })) return;
    try { await api(path, { method: "DELETE" }); await load(); }
    catch (error) { toast.error("删除失败", (error as Error).message); }
  }

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="border-b border-border p-3">
      <form className="space-y-2" onSubmit={create}>
        {anchor && <div className="rounded-lg border-l-2 border-primary bg-muted/60 p-2 text-xs">
          <div className="mb-1 flex items-center gap-1 text-[11px] text-muted-foreground"><Quote className="size-3" />引用选中内容<Button type="button" variant="ghost" size="sm" className="ml-auto h-5 px-1.5 text-[10px]" onClick={() => setAnchor(null)}>移除</Button></div>
          <p className="line-clamp-3 whitespace-pre-wrap leading-5">{anchor.text}</p>
        </div>}
        <Textarea value={body} onChange={event => setBody(event.target.value)} maxLength={4000} placeholder={anchor ? "评论这段内容…" : "评论这篇笔记…"} className="min-h-20 text-sm" />
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">{anchor ? "选中新内容可替换引用" : "选中正文即可引用；不选则评论整篇"}</span>
          <Button className="ml-auto" size="sm" disabled={!body.trim() || sending}><Send />发表</Button>
        </div>
      </form>
    </div>
    <div className="flex items-center gap-1 border-b border-border px-3 py-2">
      {([[false, "未解决"], [true, "已解决"]] as const).map(([key, label]) => <button key={label} onClick={() => setResolved(key)} className={cn("rounded-md px-2.5 py-1 text-xs font-medium", resolved === key ? "bg-muted text-foreground" : "text-muted-foreground")}>{label}</button>)}
      <Button variant="ghost" size="icon" className="ml-auto size-7" aria-label="刷新评论" onClick={() => void load()}><RotateCcw /></Button>
    </div>
    <ScrollArea className="min-h-0 flex-1"><div className="space-y-3 p-3">
      {loading ? <p className="py-12 text-center text-sm text-muted-foreground">读取中…</p> : discussions.length === 0 ? <div className="py-12 text-center"><MessageCircleReply className="mx-auto mb-3 size-8 text-muted-foreground/40" /><p className="text-sm font-medium">{resolved ? "还没有已解决的评论" : "还没有评论"}</p><p className="mt-1 text-xs text-muted-foreground">选中正文后引用评论，讨论会一直跟着这段内容。</p></div> : discussions.map(thread => {
        const located = thread.anchor ? resolveCommentAnchor(note.bodyMd, thread.anchor) : null;
        return <article key={thread.id} className="rounded-xl border border-border p-3">
          <div className="flex items-center gap-2"><UserAvatar name={thread.author.displayName} url={thread.author.avatarUrl} className="size-7 text-[10px]" /><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{thread.author.displayName}</p><p className="text-[10px] text-muted-foreground">{stamp(thread.createdAt)}{thread.editedAt ? " · 已编辑" : ""}</p></div></div>
          {thread.anchor && <button type="button" disabled={!located} onClick={() => located && onLocate(located.from, located.to)} className={cn("mt-2 block w-full rounded-lg border-l-2 p-2 text-left text-xs leading-5", located ? "border-primary bg-muted/60 hover:bg-muted" : "cursor-not-allowed border-destructive/50 bg-destructive/5 text-muted-foreground")}>
            <span className="mb-1 flex items-center gap-1 text-[10px] text-muted-foreground">{located ? <Crosshair className="size-3" /> : <Quote className="size-3" />}{located ? (located.state === "moved" ? "原文已移动 · 点击定位" : "点击定位原文") : "原文已变化，无法定位"}</span>
            <span className="line-clamp-3 whitespace-pre-wrap">{thread.anchor.text}</span>
          </button>}
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{thread.body}</p>
          {thread.replies.length > 0 && <div className="mt-3 space-y-2 border-l border-border pl-3">{thread.replies.map(reply => <div key={reply.id} className="group/reply"><div className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><UserAvatar name={reply.author.displayName} url={reply.author.avatarUrl} className="size-5 text-[8px]" /><span className="font-medium text-foreground">{reply.author.displayName}</span><span>· {stamp(reply.createdAt)}</span>{reply.canDelete && <button className="ml-auto opacity-0 hover:text-destructive group-hover/reply:opacity-100 focus:opacity-100" onClick={() => void remove(`/api/v1/discussion-replies/${reply.id}`, "回复")} aria-label="删除回复"><Trash2 className="size-3" /></button>}</div><p className="mt-1 whitespace-pre-wrap text-xs leading-5">{reply.body}</p></div>)}</div>}
          <div className="mt-2 flex items-center gap-1">
            {thread.status === "visible" && <ReplyBox thread={thread} onSent={() => void load()} />}
            {thread.canManage && <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => void changeStatus(thread)}>{thread.status === "resolved" ? <Circle /> : <CheckCircle2 />}{thread.status === "resolved" ? "重新打开" : "解决"}</Button>}
            {thread.canDelete && <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-xs text-muted-foreground hover:text-destructive" onClick={() => void remove(`/api/v1/discussions/${thread.id}`, "评论")}><Trash2 />删除</Button>}
          </div>
        </article>;
      })}
    </div></ScrollArea>
  </div>;
}
