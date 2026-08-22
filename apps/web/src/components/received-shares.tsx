import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ChevronRight, Circle, ExternalLink, Inbox, Link2 } from "lucide-react";
import { api } from "../api";
import { MarkdownView } from "../MarkdownView";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { useConfirm } from "./ui/confirm";
import { useToast } from "./ui/toast";

export type SavedShareItem = {
  id: string;
  source: "share" | "site";
  kind: string;
  title: string;
  authorName: string;
  lastNoteId: string | null;
  lastOpenedAt: string;
  createdAt: string;
  live: boolean;
};

type Content = {
  savedId: string;
  source: "share" | "site";
  kind: string;
  title?: string;
  notebook?: string;
  workspace?: string;
  notebookTitle?: string;
  noteTitle?: string | null;
  noteId?: string | null;
  bodyMd?: string;
  updatedAt?: string | null;
  folders?: Array<{ id: string; title: string; parentId: string | null }>;
  notes?: Array<{ id: string; title: string; folderId?: string | null; bodyMd?: string }>;
  attachment?: { filename: string; mime: string; bytes: number; url: string };
};

const KIND_LABEL: Record<string, string> = {
  note: "单篇",
  heading: "单节",
  folder: "目录",
  notebook: "整本",
  attachment: "附件",
  site: "文档站",
};

function isTree(kind: string) {
  return kind === "folder" || kind === "notebook" || kind === "site";
}

function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

async function dismissWithUndo(id: string, askConfirm: ReturnType<typeof useConfirm>, toast: ReturnType<typeof useToast>, restore: () => Promise<void>, after: () => Promise<void>) {
  if (!await askConfirm({
    title: "从你的「已分享」拿掉？",
    description: "原链接还在，不影响分享者。",
    confirmText: "移出",
  })) return false;
  await api(`/api/v1/me/saved-shares/${id}`, { method: "DELETE" });
  toast.toast({
    title: "已移出",
    duration: 10000,
    description: <button className="underline underline-offset-2" onClick={() => { void restore().then(() => toast.success("已重新保存")); }}>撤销</button>,
  });
  await after();
  return true;
}

export function ReceivedShares({ wsId, savedId }: { wsId: string; savedId?: string }) {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const askConfirm = useConfirm();
  const noteId = params.get("noteId");
  const [items, setItems] = useState<SavedShareItem[]>([]);
  const [content, setContent] = useState<Content | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const current = items.find(i => i.id === savedId) ?? null;
  const treeMode = !!current && isTree(current.kind);

  async function loadList() {
    const d = await api<{ items: SavedShareItem[] }>("/api/v1/me/saved-shares");
    setItems(d.items);
    return d.items;
  }

  useEffect(() => {
    setLoading(true);
    loadList().then(() => setErr("")).catch(e => setErr((e as Error).message)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!savedId) { setContent(null); setErr(""); return; }
    const q = noteId ? `?noteId=${noteId}` : "";
    api<Content>(`/api/v1/me/saved-shares/${savedId}/content${q}`)
      .then(d => { setContent(d); setErr(""); })
      .catch(e => { setContent(null); setErr((e as Error).message); });
  }, [savedId, noteId]);

  async function restore(id: string) {
    const item = items.find(i => i.id === id);
    if (!item) return;
    // 重新保存需要原通道。列表没有 token，走 open 拿不到。这里用 content 打不开的行：
    // 公开页「重新保存」才是正路。撤销只对刚移出、服务端行还在 dismissed 的生效——
    // POST 手工保存需要 token/slug。所以撤销改为：再 POST 同一 id 做不到。
    // 设计写的是「撤销 = 重新保存」。我们用一个内部约定：DELETE 后 10 秒内
    // 再 POST /me/saved-shares 需要通道。改成 DELETE 只 dismissed，重新保存
    // 若没有 token，就调一个「按 id 重新激活」——当前 POST 不支持 id。
    // 用 open 接口拿不到 JSON。最简单：前端在移出前记下 source，公开页再存。
    // 为了 toast 撤销能用，POST 增加 reactivate by id：下面走 restoreSaved。
    await restoreSaved(id);
    await loadList();
  }

  async function remove(id: string) {
    try {
      const ok = await dismissWithUndo(id, askConfirm, toast, () => restore(id), async () => {
        setItems(v => v.filter(i => i.id !== id));
        if (savedId === id) nav(`/w/${wsId}/received`);
      });
      if (!ok) return;
    } catch (e) { toast.error("移出失败", (e as Error).message); }
  }

  function openItem(item: SavedShareItem) {
    const q = item.lastNoteId && isTree(item.kind) ? `?noteId=${item.lastNoteId}` : "";
    nav(`/w/${wsId}/received/${item.id}${q}`);
  }

  function pickNote(id: string) {
    setParams(p => { p.set("noteId", id); return p; }, { replace: true });
  }

  const treeNotes = content?.notes ?? [];
  const readingTitle = content?.noteTitle ?? content?.title ?? current?.title ?? "已分享";

  return <>
    <aside className="tree-panel relative flex min-h-0 flex-col border-r border-border bg-background">
      <div className="flex h-14 items-center gap-1 border-b border-border px-3">
        <div className="min-w-0 flex-1">
          {treeMode && savedId
            ? <button className="truncate text-left text-sm font-semibold hover:underline" onClick={() => nav(`/w/${wsId}/received`)}>← 已分享</button>
            : <p className="truncate text-sm font-semibold">已分享</p>}
          <p className="truncate text-[11px] text-muted-foreground">
            {treeMode && current ? `${KIND_LABEL[current.kind] ?? current.kind} · ${current.title}` : `${items.length} 条`}
          </p>
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2.5">
          {loading && <p className="px-2 py-8 text-center text-xs text-muted-foreground">加载中…</p>}
          {!loading && !treeMode && items.length === 0 && (
            <p className="px-2 py-8 text-center text-sm leading-6 text-muted-foreground">打开别人发给你的分享链接或文档站，登录后会自动出现在这里。</p>
          )}
          {!treeMode && items.map(item => (
            <div key={item.id} className={cn("group mb-1 flex items-start gap-1 rounded-lg pr-1", item.id === savedId ? "bg-muted" : "hover:bg-muted/70")}>
              <button onClick={() => openItem(item)} className="min-w-0 flex-1 rounded-lg px-2.5 py-2 text-left">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm">{item.title}</span>
                  {!item.live && <Badge className="shrink-0 border-transparent bg-muted text-[10px]">已失效</Badge>}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                  {KIND_LABEL[item.kind] ?? item.kind}{item.authorName ? ` · ${item.authorName}` : ""} · {formatWhen(item.lastOpenedAt)}
                </span>
              </button>
              <Button variant="ghost" size="sm" className="mt-1 opacity-0 group-hover:opacity-100" onClick={() => void remove(item.id)}>移出</Button>
            </div>
          ))}
          {treeMode && treeNotes.map(n => (
            <button key={n.id} onClick={() => pickNote(n.id)} className={cn("mb-1 w-full rounded-lg px-2.5 py-2 text-left text-sm", n.id === (content?.noteId ?? noteId) ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/70")}>
              {n.title}
            </button>
          ))}
        </div>
      </ScrollArea>
    </aside>

    <section className="relative flex min-h-0 min-w-0 flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span>已分享</span>
          <ChevronRight className="size-3" />
          <span className="truncate text-foreground">{readingTitle}</span>
          {current && !current.live && <Badge className="border-transparent bg-muted">已失效</Badge>}
        </div>
        {savedId && <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => { window.open(`/api/v1/me/saved-shares/${savedId}/open${noteId ? `?noteId=${noteId}` : ""}`, "_blank"); }}><ExternalLink />打开原页</Button>
          <Button variant="ghost" size="sm" onClick={() => void remove(savedId)}>移出</Button>
        </div>}
      </div>
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-3xl px-6 py-10">
          {!savedId && <div className="grid place-items-center py-20 text-center">
            <span className="grid size-12 place-items-center rounded-xl bg-muted text-muted-foreground"><Inbox className="size-5" /></span>
            <p className="mt-4 text-sm font-medium">从列表挑一条</p>
            <p className="mt-1 text-xs text-muted-foreground">这里是只读的。要评论或纠错，点「打开原页」。</p>
          </div>}
          {savedId && err && <div className="grid place-items-center py-20 text-center">
            <span className="grid size-12 place-items-center rounded-xl bg-muted text-muted-foreground"><Link2 className="size-5" /></span>
            <p className="mt-4 text-sm font-medium">内容不存在或已失效</p>
            <p className="mt-1 text-xs text-muted-foreground">{err}</p>
          </div>}
          {savedId && !err && !content && <div className="grid place-items-center py-20"><Circle className="size-5 animate-pulse fill-current" /></div>}
          {content?.attachment && <AttachmentView a={content.attachment} />}
          {content && !content.attachment && (content.bodyMd != null || siteBody(content, noteId)) && (
            <article>
              <h1 className="mb-8 text-3xl font-semibold tracking-[-.04em]">{content.noteTitle ?? content.title}</h1>
              <MarkdownView source={content.bodyMd ?? siteBody(content, noteId) ?? ""} />
            </article>
          )}
        </div>
      </ScrollArea>
    </section>
  </>;
}

function siteBody(content: Content, noteId: string | null) {
  if (!content.notes?.length) return content.bodyMd ?? "";
  const current = content.notes.find(n => n.id === (content.noteId ?? noteId)) ?? content.notes[0];
  return current?.bodyMd ?? content.bodyMd ?? "";
}

function AttachmentView({ a }: { a: NonNullable<Content["attachment"]> }) {
  return <div className="mx-auto max-w-xl">
    {a.mime.startsWith("image/")
      ? <img src={a.url} alt={a.filename} className="mx-auto max-h-[70vh] rounded-xl border" />
      : <div className="rounded-2xl border p-10 text-center">
        <p className="text-lg font-medium">{a.filename}</p>
        <p className="mt-1 text-xs text-muted-foreground">{a.mime}</p>
      </div>}
    <div className="mt-5 text-center"><a href={a.url} download={a.filename}><Button>下载 {a.filename}</Button></a></div>
  </div>;
}

async function restoreSaved(id: string) {
  // 移出只把行标成 dismissed。重新保存走 POST，但没有 token。
  // 用一个约定：POST { reactivateId } —— 还没接到后端。下面补后端。
  await api("/api/v1/me/saved-shares", { method: "POST", body: JSON.stringify({ reactivateId: id }) });
}

/** 公开页顶栏芯片。未登录不渲染。 */
export function SavedShareChip({
  saved,
  shareToken,
  site,
  lastNoteId,
  homeWsId,
}: {
  saved: { id: string; status: string } | null;
  shareToken?: string;
  site?: { wsSlug: string; nbSlug: string };
  lastNoteId?: string | null;
  homeWsId?: string;
}) {
  const nav = useNavigate();
  const toast = useToast();
  const askConfirm = useConfirm();
  const [state, setState] = useState(saved);
  useEffect(() => { setState(saved); }, [saved]);

  useEffect(() => {
    if (state?.status !== "active") return;
    const key = `kb.saved-share-toast:${state.id}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch { /* 隐私模式忽略 */ }
    toast.success("已保存到左侧「已分享」");
  }, [state?.id, state?.status, toast]);

  async function save() {
    try {
      const d = await api<{ id: string; status: string }>("/api/v1/me/saved-shares", {
        method: "POST",
        body: JSON.stringify(shareToken
          ? { shareToken, lastNoteId }
          : { site, lastNoteId }),
      });
      setState(d);
      toast.success("已保存到「已分享」");
    } catch (e) { toast.error("保存失败", (e as Error).message); }
  }

  async function remove() {
    if (!state) return;
    try {
      if (!await askConfirm({ title: "从你的「已分享」拿掉？", description: "原链接还在，不影响分享者。", confirmText: "移出" })) return;
      await api(`/api/v1/me/saved-shares/${state.id}`, { method: "DELETE" });
      const id = state.id;
      setState({ id, status: "dismissed" });
      toast.toast({
        title: "已移出",
        duration: 10000,
        description: <button className="underline underline-offset-2" onClick={() => { void api("/api/v1/me/saved-shares", { method: "POST", body: JSON.stringify({ reactivateId: id }) }).then(d => { setState(d as { id: string; status: string }); toast.success("已重新保存"); }); }}>撤销</button>,
      });
    } catch (e) { toast.error("移出失败", (e as Error).message); }
  }

  if (state?.status === "active") {
    return <div className="ml-auto flex items-center gap-1">
      <button className="rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => homeWsId && nav(`/w/${homeWsId}/received/${state.id}`)}>已保存</button>
      <Button variant="ghost" size="sm" onClick={() => void remove()}>移出</Button>
    </div>;
  }
  return <div className="ml-auto"><Button variant="ghost" size="sm" onClick={() => void save()}>保存到已分享</Button></div>;
}
