import { useEffect, useState } from "react";
import { Check, MessageSquare, Reply, Send, X } from "lucide-react";
import { api } from "../api";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { FormError } from "./ui/form-error";
import { Input } from "./ui/input";
import { useToast } from "./ui/toast";
import { MentionField } from "./mention-field";
import { MentionText, type MentionAgent } from "./mention-text";

type Comment = {
  id: string; body: string; parentId: string | null; status: string;
  author: string | null; authorKind?: "user" | "guest" | "agent";
  authorHandle?: string | null;
  agent?: { id: string; handle: string; displayName: string; avatarEmoji: string } | null;
  createdAt: string; editedAt: string | null;
  mine: boolean; editableUntil: string;
};
type Challenge = { question: string; token: string };

/** 动态底下的一层评论。登录直发；广场访客要过验证码，先待审。 */
function AuthorLabel({ c }: { c: Comment }) {
  return <>
    {c.agent?.avatarEmoji && <span>{c.agent.avatarEmoji}</span>}
    <b className="text-foreground">{c.author ?? "访客"}</b>
    {c.authorKind === "agent" && <Badge>智能体</Badge>}
    {c.authorHandle && <span>@{c.authorHandle}</span>}
  </>;
}

export function FeedComments({ postId, signedIn, agents = [], onCount }: { postId: string; signedIn: boolean; agents?: MentionAgent[]; onCount?: (n: number) => void }) {
  const toast = useToast();
  const [comments, setComments] = useState<Comment[]>([]);
  const [canModerate, setCanModerate] = useState(false);
  const [body, setBody] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api<{ comments: Comment[]; canModerate: boolean }>(`/api/v1/posts/${postId}/comments`)
    .then(d => { setComments(d.comments); setCanModerate(d.canModerate); onCount?.(d.comments.filter(c => c.status === "visible").length); })
    .catch(() => setComments([]));
  const newChallenge = () => api<Challenge>("/api/v1/public/captcha").then(c => { setChallenge(c); setAnswer(""); }).catch(() => setChallenge(null));

  useEffect(() => { void load(); if (!signedIn) void newChallenge(); }, [postId, signedIn]);

  const roots = comments.filter(c => !c.parentId);
  const repliesOf = (id: string) => comments.filter(c => c.parentId === id).sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));

  async function send(e: React.FormEvent) {
    e.preventDefault(); if (!body.trim()) return;
    setBusy(true); setErr("");
    try {
      const d = await api<{ status: string }>(`/api/v1/posts/${postId}/comments`, {
        method: "POST",
        body: JSON.stringify({ body, parentId: replyTo?.id ?? null, guestName: name || undefined, challengeToken: challenge?.token, challengeAnswer: answer || undefined }),
      });
      setBody(""); setReplyTo(null); setAnswer("");
      if (!signedIn) void newChallenge();
      if (d.status === "pending") toast.success("评论已提交", "等待作者审核后才会公开显示。");
      else toast.success("评论已发布");
      void load();
    } catch (x) {
      setErr((x as Error).message);
      if (!signedIn) void newChallenge();
    } finally { setBusy(false); }
  }

  async function review(id: string, status: "visible" | "rejected" | "hidden") {
    try {
      await api(`/api/v1/comments/${id}/review`, { method: "PATCH", body: JSON.stringify({ status }) });
      toast.success(status === "visible" ? "已通过" : status === "rejected" ? "已拒绝" : "已隐藏");
      void load();
    } catch (x) { toast.error("操作失败", (x as Error).message); }
  }

  return <div className="mt-4 border-t pt-3">
    <div className="space-y-3">
      {roots.length === 0 && <p className="text-xs text-muted-foreground">还没有评论。</p>}
      {roots.map(c => <div key={c.id} className="rounded-lg bg-muted/40 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <AuthorLabel c={c} />
          <span>{new Date(c.createdAt).toLocaleString()}</span>
          {c.editedAt && <Badge>已编辑</Badge>}
          {c.status === "pending" && <Badge className="border-transparent bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)]">待审</Badge>}
          <span className="ml-auto flex gap-1">
            {c.status === "visible" && <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setReplyTo(c)}><Reply />回复</Button>}
            {canModerate && c.status === "pending" && <>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => void review(c.id, "visible")}><Check />通过</Button>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive" onClick={() => void review(c.id, "rejected")}><X />拒绝</Button>
            </>}
            {(canModerate || c.mine) && c.status === "visible" && <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => void review(c.id, "hidden")}>隐藏</Button>}
          </span>
        </div>
        <MentionText text={c.body} agents={c.agent ? [...agents, c.agent] : agents} className="mt-1.5 text-sm leading-6" />
        {repliesOf(c.id).map(r => <div key={r.id} className="mt-2 border-l-2 border-border pl-3">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <AuthorLabel c={r} />
            <span>{new Date(r.createdAt).toLocaleString()}</span>
            {r.status === "pending" && <Badge className="border-transparent bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)]">待审</Badge>}
            {(canModerate || r.mine) && r.status === "visible" && <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" onClick={() => void review(r.id, "hidden")}>隐藏</Button>}
            {canModerate && r.status === "pending" && <span className="ml-auto flex gap-1">
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => void review(r.id, "visible")}><Check />通过</Button>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive" onClick={() => void review(r.id, "rejected")}><X />拒绝</Button>
            </span>}
          </div>
          <MentionText text={r.body} agents={r.agent ? [...agents, r.agent] : agents} className="mt-1 text-sm leading-6" />
        </div>)}
      </div>)}
    </div>

    <form className="mt-3 space-y-2" onSubmit={send}>
      {replyTo && <p className="flex items-center gap-2 text-xs text-muted-foreground"><MessageSquare className="size-3.5" />正在回复 <b>{replyTo.author}</b><Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => setReplyTo(null)}>取消</Button></p>}
      {!signedIn && <Input value={name} onChange={e => setName(e.target.value)} placeholder="访客昵称" maxLength={40} />}
      <MentionField value={body} onChange={setBody} agents={agents} maxLength={2000} placeholder={replyTo ? `回复 ${replyTo.author}…` : "写下评论，输入 @ 可叫智能体"} className="min-h-16" />
      {!signedIn && challenge && <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">访客请作答：{challenge.question}</span>
        <Input className="w-24" value={answer} onChange={e => setAnswer(e.target.value)} inputMode="numeric" placeholder="答案" />
        <Button type="button" variant="ghost" size="sm" onClick={() => void newChallenge()}>换一题</Button>
      </div>}
      <FormError>{err}</FormError>
      <Button size="sm" disabled={busy || !body.trim()}><Send />发表评论</Button>
    </form>
  </div>;
}
