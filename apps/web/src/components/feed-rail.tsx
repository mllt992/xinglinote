import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FileText, Globe2, Link2, LayoutGrid, NotebookPen, Users, UserPlus, Lock } from "lucide-react";
import { api, type Me } from "../api";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import type { FeedPost } from "./feed";
import { usePublicCatalog } from "./square-catalog";

type Member = { userId: string; handle: string; displayName: string; role: string };

/** 右栏一律用这一张卡：标题小、边框细、不加投影，和 14 §4「卡片弱、分割线强」对齐。 */
function RailCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="rounded-2xl border bg-background p-4">
    <div className="flex items-center gap-2"><h2 className="text-xs font-semibold text-muted-foreground">{title}</h2>{action && <div className="ml-auto">{action}</div>}</div>
    <div className="mt-3">{children}</div>
  </section>;
}

function PersonRow({ name, handle, right }: { name: string; handle: string; right?: ReactNode }) {
  return <a href={`/u/${handle}`} className="-mx-1.5 flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-muted">
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-xs font-semibold text-background">{name.slice(0, 1)}</span>
    <span className="min-w-0 flex-1"><b className="block truncate text-sm font-medium">{name}</b><small className="block truncate text-xs text-muted-foreground">@{handle}</small></span>
    {right && <span className="shrink-0 text-xs text-muted-foreground">{right}</span>}
  </a>;
}

function NoteRow({ title, onOpen }: { title: string; onOpen: () => void }) {
  return <button className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-sm hover:bg-muted" onClick={onOpen}>
    <NotebookPen className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{title}</span>
  </button>;
}

/** 右栏的料全部从已经拿到的时间线里推，不额外打接口，翻页也不会多一轮请求。 */
function TagCloud({ tags, active, onPick }: { tags: string[]; active?: string; onPick: (tag: string) => void }) {
  if (!tags.length) return null;
  return <div className="flex flex-wrap gap-1.5">
    {tags.map(t => <button key={t} type="button" onClick={() => onPick(t)}
      className={`rounded-full border px-2 py-0.5 text-xs ${active === t ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}>
      #{t}
    </button>)}
  </div>;
}

function useFeedDigest(posts: FeedPost[]) {
  const authors = useMemo(() => {
    const seen = new Map<string, { handle: string; displayName: string; count: number }>();
    for (const p of posts) { if (!p.author) continue; const hit = seen.get(p.author.handle); if (hit) hit.count += 1; else seen.set(p.author.handle, { ...p.author, count: 1 }); }
    return [...seen.values()].sort((a, b) => b.count - a.count).slice(0, 6);
  }, [posts]);
  const cited = useMemo(() => {
    const seen = new Set<string>(); const out: Array<{ id: string; title: string; workspaceId: string }> = [];
    for (const p of posts) { if (!p.note || !p.workspaceId || seen.has(p.note.id)) continue; seen.add(p.note.id); out.push({ id: p.note.id, title: p.note.title, workspaceId: p.workspaceId }); }
    return out.slice(0, 5);
  }, [posts]);
  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of posts) for (const t of p.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh")).slice(0, 12).map(([name]) => name);
  }, [posts]);
  return { authors, cited, tags };
}

/** 右栏跟着滚：main 是滚动容器，顶栏在容器外面，所以贴顶只留一点呼吸位就够。 */
const rail = "space-y-4 lg:sticky lg:top-4";

/** 广场右栏。 */
export function SquareRail({ posts, me, homeWsId, activeTag, tab, onOpenNote, onNav, onTag }: { posts: FeedPost[]; me: Me | null | undefined; homeWsId?: string; activeTag?: string; tab?: "feed" | "notebooks" | "articles"; onOpenNote: (workspaceId: string, noteId: string) => void; onNav: (to: string) => void; onTag?: (tag: string) => void }) {
  const { authors, cited, tags } = useFeedDigest(posts);
  const catalog = usePublicCatalog();
  const books = (catalog?.notebooks ?? []).slice(0, 5);
  const articles = (catalog?.articles ?? []).slice(0, 5);
  return <div className={rail}>
    {me === null && <RailCard title="加入这个实例">
      <p className="text-xs leading-5 text-muted-foreground">登录后可以发动态、评论、收藏，也能把值得留下的想法转正成笔记。</p>
      <div className="mt-3 flex gap-2"><Button size="sm" onClick={() => onNav("/login")}>登录</Button><Button size="sm" variant="ghost" onClick={() => onNav("/register")}>注册</Button></div>
    </RailCard>}
    {tab !== "notebooks" && books.length > 0 && <RailCard title="公开笔记本" action={<button type="button" className="text-xs text-muted-foreground hover:underline" onClick={() => onNav("/?tab=notebooks")}>全部</button>}>
      <ul className="space-y-1">{books.map(nb => <li key={nb.id}>
        <a href={nb.url} className="-mx-1.5 flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-sm hover:bg-muted">
          <Globe2 className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{nb.title}</span>
        </a>
      </li>)}</ul>
    </RailCard>}
    {tab !== "articles" && articles.length > 0 && <RailCard title="公开文章" action={<button type="button" className="text-xs text-muted-foreground hover:underline" onClick={() => onNav("/?tab=articles")}>全部</button>}>
      <ul className="space-y-1">{articles.map(a => <li key={a.id}>
        <a href={a.url} className="-mx-1.5 flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-sm hover:bg-muted">
          <FileText className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{a.title}</span>
        </a>
      </li>)}</ul>
    </RailCard>}
    {authors.length > 0 && <RailCard title="最近活跃">
      <ul className="space-y-1">{authors.map(a => <li key={a.handle}><PersonRow name={a.displayName} handle={a.handle} right={`${a.count} 条`} /></li>)}</ul>
    </RailCard>}
    {cited.length > 0 && <RailCard title="动态里提到的笔记">
      <ul className="space-y-1">{cited.map(n => <li key={n.id}><NoteRow title={n.title} onOpen={() => onOpenNote(n.workspaceId, n.id)} /></li>)}</ul>
    </RailCard>}
    {tags.length > 0 && onTag && <RailCard title="热门标签"><TagCloud tags={tags} active={activeTag} onPick={onTag} /></RailCard>}
    <RailCard title="关于广场">
      <ul className="space-y-2 text-xs leading-5 text-muted-foreground">
        <li className="flex gap-2"><Globe2 className="mt-0.5 size-3.5 shrink-0" /><span>发到这里的动态，实例里所有人都看得到。</span></li>
        <li className="flex gap-2"><Link2 className="mt-0.5 size-3.5 shrink-0" /><span>可以用 [[双链]] 引用已公开的笔记；没公开的会退化成纯文本。</span></li>
        <li className="flex gap-2"><NotebookPen className="mt-0.5 size-3.5 shrink-0" /><span>值得留下的动态，随时可以转正成一篇笔记。</span></li>
      </ul>
      {homeWsId && <Button variant="outline" size="sm" className="mt-3 w-full" onClick={() => onNav(`/w/${homeWsId}/feed`)}><Users />只发给工作区，去圈子</Button>}
    </RailCard>
  </div>;
}

/** 圈子右栏。广场那边靠时间线推人，圈子里成员是确定的，直接列出来才知道「只有谁看得到」。 */
export function CircleRail({ wsId, wsName, wsKind, canInvite, posts, squareEnabled, activeTag, onOpenNote, onNav, onTag }: {
  wsId: string; wsName: string; wsKind: string; canInvite: boolean; posts: FeedPost[]; squareEnabled: boolean; activeTag?: string;
  onOpenNote: (workspaceId: string, noteId: string) => void; onNav: (to: string) => void; onTag?: (tag: string) => void;
}) {
  const { authors, cited, tags } = useFeedDigest(posts);
  const [members, setMembers] = useState<Member[] | null>(null);
  useEffect(() => { setMembers(null); api<{ members: Member[] }>(`/api/v1/workspaces/${wsId}/members`).then(d => setMembers(d.members)).catch(() => setMembers([])); }, [wsId]);
  const counted = new Map(authors.map(a => [a.handle, a.count]));
  const shown = (members ?? []).slice(0, 8);
  return <div className={rail}>
    <RailCard title={`圈子成员${members ? ` · ${members.length}` : ""}`} action={canInvite ? <Button variant="ghost" size="sm" onClick={() => onNav(`/w/${wsId}/settings?tab=members`)}><UserPlus />邀请</Button> : undefined}>
      {wsKind === "personal"
        ? <p className="text-xs leading-5 text-muted-foreground">这是个人工作区，圈子里只有你自己——当私密碎片本用正好。想有人一起发，新建一个协作工作区再把人拉进来。</p>
        : members === null ? <p className="text-xs text-muted-foreground">加载中…</p>
        : <><ul className="space-y-1">{shown.map(m => <li key={m.userId}><PersonRow name={m.displayName} handle={m.handle} right={counted.get(m.handle) ? `${counted.get(m.handle)} 条` : <Badge>{m.role}</Badge>} /></li>)}</ul>
          {members.length > shown.length && <button className="mt-2 text-xs text-muted-foreground hover:underline" onClick={() => onNav(`/w/${wsId}/settings?tab=members`)}>还有 {members.length - shown.length} 位，去设置里看全部</button>}</>}
    </RailCard>
    {cited.length > 0 && <RailCard title="动态里提到的笔记">
      <ul className="space-y-1">{cited.map(n => <li key={n.id}><NoteRow title={n.title} onOpen={() => onOpenNote(n.workspaceId, n.id)} /></li>)}</ul>
    </RailCard>}
    {tags.length > 0 && onTag && <RailCard title="热门标签"><TagCloud tags={tags} active={activeTag} onPick={onTag} /></RailCard>}
    <RailCard title="关于圈子">
      <ul className="space-y-2 text-xs leading-5 text-muted-foreground">
        <li className="flex gap-2"><Lock className="mt-0.5 size-3.5 shrink-0" /><span>只有 {wsName} 的成员看得到，Viewer 只读。</span></li>
        <li className="flex gap-2"><Link2 className="mt-0.5 size-3.5 shrink-0" /><span>[[双链]] 按库内权限渲染，私密笔记在这里也点得开。</span></li>
        <li className="flex gap-2"><NotebookPen className="mt-0.5 size-3.5 shrink-0" /><span>想留下的动态可以转正成笔记，原文和出处一起带过去。</span></li>
      </ul>
      {squareEnabled && <Button variant="outline" size="sm" className="mt-3 w-full" onClick={() => onNav("/")}><LayoutGrid />要让所有人看到，去广场</Button>}
    </RailCard>
  </div>;
}
