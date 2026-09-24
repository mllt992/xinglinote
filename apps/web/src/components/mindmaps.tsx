import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Crosshair, Download, FileJson, GitBranchPlus, Link2, Link2Off, ListTree, MoreHorizontal, Network, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import type { MindMapData } from "@kb/shared";
import { api } from "../api";
import { AppNav, saveLastWorkspace } from "./app-nav";
import { NotificationBell } from "./notifications";
import type { MindMapEditorHandle } from "./mind-map-editor";
import { NotePickerDialog } from "./note-picker-dialog";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Tooltip, TooltipProvider } from "./ui/tooltip";
import { useConfirm, usePrompt } from "./ui/confirm";
import { useToast } from "./ui/toast";

// mind-elixir 只在打开导图时才需要，单独拆包，不拖慢笔记首屏。
const MindMapEditor = lazy(() => import("./mind-map-editor").then(m => ({ default: m.MindMapEditor })));

type Brief = { id: string; notebookId: string; title: string; version: number; createdAt: string; updatedAt: string };
type NotebookRow = { id: string; title: string; canEdit: boolean };

export function mindMapPath(wsId: string, id?: string, nodeId?: string) {
  return `/w/${wsId}/mindmaps${id ? `/${id}` : ""}${nodeId ? `?node=${encodeURIComponent(nodeId)}` : ""}`;
}

function ago(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "思维导图";

function Header({ wsId, children }: { wsId: string; children?: React.ReactNode }) {
  const nav = useNavigate();
  return <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-background">
    <div className="mx-auto flex h-14 w-full max-w-[1180px] items-center gap-2 px-4 sm:px-6">
      <button className="-mx-1 flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-muted" onClick={() => nav(`/w/${wsId}`)}>
        <span className="grid size-7 place-items-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">星</span>
      </button>
      <AppNav wsId={wsId} active="mindmaps" />
      <div className="ml-auto flex items-center gap-1">{children}<NotificationBell /></div>
    </div>
  </header>;
}

/** 新建：标题 + 放进哪个笔记本。 */
function CreateDialog({ open, onOpenChange, notebooks, onCreate }: {
  open: boolean; onOpenChange: (v: boolean) => void; notebooks: NotebookRow[]; onCreate: (title: string, notebookId: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [notebookId, setNotebookId] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setTitle(""); setNotebookId(notebooks[0]?.id ?? ""); } }, [open, notebooks]);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader><DialogTitle>新建思维导图</DialogTitle><DialogDescription>导图放在笔记本里，谁能改这个笔记本的笔记，谁就能改这张图。</DialogDescription></DialogHeader>
      <form className="grid gap-3" onSubmit={async e => {
        e.preventDefault();
        if (!title.trim() || !notebookId) return;
        setBusy(true);
        try { await onCreate(title.trim(), notebookId); onOpenChange(false); } finally { setBusy(false); }
      }}>
        <label className="grid gap-1.5 text-sm"><span className="text-xs font-medium text-muted-foreground">标题</span>
          <Input autoFocus value={title} maxLength={200} placeholder="比如：季度规划" onChange={e => setTitle(e.target.value)} /></label>
        <label className="grid gap-1.5 text-sm"><span className="text-xs font-medium text-muted-foreground">放在哪个笔记本</span>
          <select className="h-9 rounded-lg border border-input bg-background px-3 text-sm" value={notebookId} onChange={e => setNotebookId(e.target.value)}>
            {notebooks.map(nb => <option key={nb.id} value={nb.id}>{nb.title}</option>)}
          </select></label>
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="submit" disabled={busy || !title.trim() || !notebookId}>{busy ? "正在创建…" : "创建"}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}

export function MindMapsPage() {
  const { wsId = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [notebooks, setNotebooks] = useState<NotebookRow[]>([]);
  const [maps, setMaps] = useState<Brief[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [creating, setCreating] = useState(false);

  useEffect(() => { if (wsId) saveLastWorkspace(wsId); }, [wsId]);
  const load = useCallback(async () => {
    setState(s => s === "ready" ? s : "loading");
    try {
      const d = await api<{ notebooks: NotebookRow[]; mindMaps: Brief[] }>(`/api/v1/workspaces/${wsId}/mindmaps`);
      setNotebooks(d.notebooks); setMaps(d.mindMaps); setState("ready");
    } catch (e) { setState("failed"); toast.error("思维导图加载失败", (e as Error).message); }
  }, [wsId, toast]);
  useEffect(() => { void load(); }, [load]);

  const editable = notebooks.filter(nb => nb.canEdit);
  const groups = useMemo(() => notebooks.map(nb => ({ nb, maps: maps.filter(m => m.notebookId === nb.id) })).filter(g => g.maps.length), [notebooks, maps]);

  async function rename(m: Brief) {
    const title = await prompt({ title: "重命名思维导图", label: "标题", defaultValue: m.title, confirmText: "保存" });
    if (title === null || !title.trim() || title.trim() === m.title) return;
    try {
      const d = await api<{ mindMap: Brief }>(`/api/v1/mindmaps/${m.id}`, { method: "PATCH", body: JSON.stringify({ title: title.trim(), expectedVersion: m.version }) });
      setMaps(list => list.map(x => x.id === m.id ? d.mindMap : x));
      toast.success("已重命名");
    } catch (e) { toast.error("重命名失败", (e as Error).message); }
  }
  async function remove(m: Brief) {
    if (!await confirm({ title: `删除「${m.title}」？`, description: "思维导图会被直接删除，不进回收站，删了找不回来。关联的笔记本身不受影响。", confirmText: "删除", destructive: true })) return;
    try {
      await api(`/api/v1/mindmaps/${m.id}`, { method: "DELETE" });
      setMaps(list => list.filter(x => x.id !== m.id));
      toast.success("已删除");
    } catch (e) { toast.error("删除失败", (e as Error).message); }
  }

  return <div className="flex h-full min-h-0 flex-col bg-muted/25">
    <Header wsId={wsId}><Button variant="ghost" size="sm" onClick={() => nav(`/w/${wsId}`)}>笔记</Button></Header>
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1180px] px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-[-.035em]">思维导图</h1>
            <p className="mt-1 text-sm text-muted-foreground">把想法摊开来理。节点可以关联笔记，点一下就跳过去。</p>
          </div>
          {editable.length > 0 && <Button size="sm" onClick={() => setCreating(true)}><Plus />新建导图</Button>}
        </div>
        {state === "loading" ? <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <div key={i} className="h-28 animate-pulse rounded-xl border bg-muted/50" />)}</div>
          : state === "failed" ? <div className="mt-16 text-center"><p className="text-sm text-muted-foreground">没能加载思维导图。</p><Button className="mt-3" variant="outline" onClick={() => void load()}><RotateCcw />重试</Button></div>
          : !groups.length ? <div className="mx-auto mt-16 max-w-md text-center">
            <Network className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">还没有思维导图</p>
            <p className="mt-1 text-sm text-muted-foreground">{notebooks.length
              ? "新建一张空白导图，或者在笔记右侧栏的「思维导图」里，从笔记的标题结构一键生成。"
              : "思维导图放在笔记本里。先去建一个笔记本吧。"}</p>
            {editable.length > 0 ? <Button className="mt-4" onClick={() => setCreating(true)}><Plus />新建第一张导图</Button>
              : !notebooks.length && <Button className="mt-4" variant="outline" onClick={() => nav(`/w/${wsId}`)}>去笔记</Button>}
          </div>
          : <div className="mt-6 space-y-7">{groups.map(({ nb, maps: list }) => <section key={nb.id}>
            <div className="mb-3 flex items-center gap-2"><h2 className="text-sm font-semibold">{nb.title}</h2><span className="text-xs text-muted-foreground">{list.length} 张</span></div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{list.map(m => <div key={m.id} className="group relative rounded-xl border border-border bg-background transition hover:border-foreground/20 hover:shadow-sm">
              <button className="block w-full p-4 text-left" onClick={() => nav(mindMapPath(wsId, m.id))}>
                <Network className="size-4 text-muted-foreground" />
                <p className="mt-2 truncate pr-8 font-medium">{m.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{ago(m.updatedAt)}更新</p>
              </button>
              {nb.canEdit && <DropdownMenu><DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`「${m.title}」的更多操作`} className="absolute right-2 top-2 size-8 opacity-60 group-hover:opacity-100"><MoreHorizontal /></Button>
              </DropdownMenuTrigger><DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void rename(m)}><Pencil />重命名</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive" onSelect={() => void remove(m)}><Trash2 />删除</DropdownMenuItem>
              </DropdownMenuContent></DropdownMenu>}
            </div>)}</div>
          </section>)}</div>}
      </div>
    </main>
    <CreateDialog open={creating} onOpenChange={setCreating} notebooks={editable} onCreate={async (title, notebookId) => {
      try {
        const d = await api<{ mindMap: Brief }>(`/api/v1/notebooks/${notebookId}/mindmaps`, { method: "POST", body: JSON.stringify({ title }) });
        nav(mindMapPath(wsId, d.mindMap.id));
      } catch (e) { toast.error("创建失败", (e as Error).message); throw e; }
    }} />
  </div>;
}

type Loaded = { mindMap: Brief & { data: MindMapData }; notebook: { id: string; title: string }; workspaceId: string; canEdit: boolean };
type SaveState = "saved" | "dirty" | "saving" | "conflict" | "failed";
const SAVE_LABEL: Record<SaveState, string> = { saved: "已保存", dirty: "有改动未保存", saving: "正在保存…", conflict: "未保存：别人刚改过这张图", failed: "保存失败，稍后自动重试" };

/** 编辑页：约 0.8 秒防抖自动保存，带版本号防覆盖。 */
export function MindMapPage() {
  const { wsId = "", mindMapId = "" } = useParams();
  const [params] = useSearchParams();
  const focusNodeId = params.get("node");
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<ReturnType<MindMapEditorHandle["selectedNode"]>>(null);
  const editor = useRef<MindMapEditorHandle | null>(null);
  const version = useRef(0);
  const lastSaved = useRef("");
  const timer = useRef<number | null>(null);
  const inFlight = useRef(false);
  const blocked = useRef(false);
  // 最近一次改动的快照：卸载时编辑器 ref 可能已经被清掉，离开页面补存靠它。
  const pending = useRef<MindMapData | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const d = await api<Loaded>(`/api/v1/mindmaps/${mindMapId}`);
      version.current = d.mindMap.version;
      lastSaved.current = JSON.stringify(d.mindMap.data);
      pending.current = null;
      blocked.current = false;
      setSaveState("saved");
      setLoaded(d);
    } catch (e) { setFailed(true); toast.error("打不开这张思维导图", (e as Error).message); }
  }, [mindMapId, toast]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (wsId) saveLastWorkspace(wsId); }, [wsId]);

  const save = useCallback(async () => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    const data = editor.current?.getData() ?? pending.current;
    if (!data || !loaded?.canEdit || blocked.current || inFlight.current) return;
    const body = JSON.stringify(data);
    if (body === lastSaved.current) { setSaveState("saved"); return; }
    inFlight.current = true;
    setSaveState("saving");
    try {
      const d = await api<{ mindMap: Brief }>(`/api/v1/mindmaps/${loaded.mindMap.id}`, { method: "PATCH", keepalive: body.length < 60_000, body: JSON.stringify({ data, expectedVersion: version.current }) });
      version.current = d.mindMap.version;
      lastSaved.current = body;
      setSaveState("saved");
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "CONFLICT_VERSION") { blocked.current = true; setSaveState("conflict"); toast.error("没保存上", "这张导图刚被别人改过。点「重新加载」拿最新版本（你这次的改动会丢失）。"); }
      else if (code === "VALIDATION" || code === "PAYLOAD_TOO_LARGE" || code === "FORBIDDEN" || code === "NOT_FOUND") { blocked.current = true; setSaveState("failed"); toast.error("保存失败", (e as Error).message); }
      else { setSaveState("failed"); toast.error("保存失败", `${(e as Error).message}。稍后会自动重试。`); timer.current = window.setTimeout(() => void saveRef.current(), 5000); }
    } finally {
      inFlight.current = false;
    }
    // 保存期间又改了：接着存。
    if (!blocked.current && editor.current && JSON.stringify(editor.current.getData()) !== lastSaved.current) {
      setSaveState("dirty");
      timer.current = window.setTimeout(() => void saveRef.current(), 800);
    }
  }, [loaded, toast]);
  const saveRef = useRef(save);
  saveRef.current = save;

  const schedule = useCallback(() => {
    if (!loaded?.canEdit || blocked.current) return;
    const ed = editor.current;
    if (ed) pending.current = ed.getData();
    if (pending.current && JSON.stringify(pending.current) === lastSaved.current) return;
    setSaveState(s => s === "saving" ? s : "dirty");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void saveRef.current(), 800);
  }, [loaded]);

  // 离开页面前把没存的立刻发出去（keepalive 保证页面关了请求也能到）。
  useEffect(() => {
    const flush = () => { if (timer.current) void save(); };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, [save]);

  useEffect(() => {
    if (loaded && focusNodeId) window.setTimeout(() => editor.current?.focusNode(focusNodeId), 50);
  }, [loaded, focusNodeId]);

  async function openNote(noteId: string) {
    try {
      const note = await api<{ id: string; workspaceId: string }>(`/api/v1/notes/${noteId}`);
      if (timer.current) await save();
      nav(`/w/${note.workspaceId}/n/${note.id}`);
    } catch { toast.error("打不开关联的笔记", "笔记可能已被删除，或者你没有查看权限。"); }
  }

  async function rename() {
    if (!loaded) return;
    const title = await prompt({ title: "重命名思维导图", label: "标题", defaultValue: loaded.mindMap.title, confirmText: "保存" });
    if (title === null || !title.trim() || title.trim() === loaded.mindMap.title) return;
    if (timer.current || inFlight.current) await save();
    try {
      const d = await api<{ mindMap: Brief }>(`/api/v1/mindmaps/${loaded.mindMap.id}`, { method: "PATCH", body: JSON.stringify({ title: title.trim(), expectedVersion: version.current }) });
      version.current = d.mindMap.version;
      setLoaded(l => l && { ...l, mindMap: { ...l.mindMap, title: d.mindMap.title } });
      toast.success("已重命名");
    } catch (e) { toast.error("重命名失败", (e as Error).message); }
  }

  async function remove() {
    if (!loaded) return;
    if (!await confirm({ title: `删除「${loaded.mindMap.title}」？`, description: "思维导图会被直接删除，不进回收站，删了找不回来。关联的笔记本身不受影响。", confirmText: "删除", destructive: true })) return;
    try {
      blocked.current = true;
      if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
      await api(`/api/v1/mindmaps/${loaded.mindMap.id}`, { method: "DELETE" });
      toast.success("已删除");
      nav(mindMapPath(wsId));
    } catch (e) { blocked.current = false; toast.error("删除失败", (e as Error).message); }
  }

  async function exportPng() {
    try {
      const blob = await editor.current?.exportPng();
      if (!blob) throw new Error("浏览器没能生成图片");
      download(blob, `${fileSafe(loaded?.mindMap.title ?? "")}.png`);
    } catch (e) { toast.error("导出 PNG 失败", (e as Error).message); }
  }
  function exportJson() {
    const data = editor.current?.getData();
    if (!data || !loaded) return;
    download(new Blob([JSON.stringify({ format: "xinglinote-mindmap", version: 1, title: loaded.mindMap.title, data }, null, 2)], { type: "application/json" }), `${fileSafe(loaded.mindMap.title)}.json`);
  }

  const canEdit = !!loaded?.canEdit;
  const needNode = !selected;
  const tool = (label: string, icon: React.ReactNode, onClick: () => void, disabled = false) =>
    <Tooltip content={label}><Button variant="ghost" size="icon" className="size-8" aria-label={label} disabled={disabled} onClick={onClick}>{icon}</Button></Tooltip>;

  return <TooltipProvider delayDuration={300}><div className="flex h-full min-h-0 flex-col bg-background">
    <Header wsId={wsId} />
    <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-1.5 sm:px-4">
      <Tooltip content="返回思维导图列表"><Button variant="ghost" size="icon" className="size-8" aria-label="返回思维导图列表" onClick={() => nav(mindMapPath(wsId))}><ArrowLeft /></Button></Tooltip>
      <div className="min-w-0 max-w-[40vw]">
        <button className="block max-w-full truncate text-sm font-semibold hover:underline disabled:no-underline" disabled={!canEdit} onClick={() => void rename()} title={canEdit ? "点击重命名" : undefined}>{loaded?.mindMap.title ?? "思维导图"}</button>
        {loaded && <p className="truncate text-[11px] text-muted-foreground">{loaded.notebook.title}{canEdit ? "" : " · 只读"}</p>}
      </div>
      {loaded && canEdit && <span className="ml-2 hidden text-xs text-muted-foreground sm:inline" aria-live="polite">{SAVE_LABEL[saveState]}</span>}
      {saveState === "conflict" && <Button size="sm" variant="outline" className="ml-1" onClick={() => { setLoaded(null); void load(); }}><RotateCcw />重新加载</Button>}
      <div className="ml-auto flex flex-wrap items-center gap-0.5">
        {canEdit && <>
          {tool("添加子节点（Tab）", <ListTree />, () => editor.current?.addChild(), needNode)}
          {tool("添加同级节点（Enter）", <GitBranchPlus />, () => editor.current?.addSibling(), needNode || !!selected?.isRoot)}
          {tool("删除节点（Delete）", <Trash2 />, () => editor.current?.removeSelected(), needNode || !!selected?.isRoot)}
          <span className="mx-1 h-5 w-px bg-border" />
          {selected?.noteId
            ? tool("取消关联笔记", <Link2Off />, () => { editor.current?.setSelectedNoteLink(null); setSelected(editor.current?.selectedNode() ?? null); })
            : tool("关联笔记", <Link2 />, () => setPicking(true), needNode)}
          <span className="mx-1 h-5 w-px bg-border" />
        </>}
        {tool("适应画布并居中", <Crosshair />, () => editor.current?.center(), !loaded)}
        {tool("导出 PNG", <Download />, () => void exportPng(), !loaded)}
        {tool("导出 JSON", <FileJson />, exportJson, !loaded)}
        {canEdit && tool("删除这张导图", <Trash2 className="text-destructive" />, () => void remove())}
      </div>
    </div>
    <main className="relative min-h-0 flex-1">
      {loaded ? <Suspense fallback={<div className="grid h-full place-items-center text-sm text-muted-foreground">正在打开…</div>}><MindMapEditor key={loaded.mindMap.id + ":" + loaded.mindMap.version} ref={editor} data={loaded.mindMap.data} editable={canEdit}
        onChange={schedule} onOpenNote={id => void openNote(id)} onSelect={() => setSelected(editor.current?.selectedNode() ?? null)} /></Suspense>
        : failed ? <div className="grid h-full place-items-center"><div className="text-center"><p className="text-sm text-muted-foreground">这张思维导图打不开：可能已被删除，或者你没有查看权限。</p>
          <div className="mt-3 flex justify-center gap-2"><Button variant="outline" onClick={() => void load()}><RotateCcw />重试</Button><Button variant="ghost" onClick={() => nav(mindMapPath(wsId))}>回到列表</Button></div></div></div>
        : <div className="grid h-full place-items-center text-sm text-muted-foreground">正在打开…</div>}
      {canEdit && loaded && <p className="pointer-events-none absolute bottom-3 left-3 hidden text-[11px] text-muted-foreground md:block">选中节点后：Tab 加子节点 · Enter 加同级 · 双击改文字 · 拖动节点调整位置 · 滚轮缩放 · 拖动空白处平移</p>}
    </main>
    {loaded && <NotePickerDialog open={picking} onOpenChange={setPicking} workspaceId={loaded.workspaceId}
      description={selected ? `给节点「${selected.topic || "未命名"}」关联一篇笔记，点节点上的链接图标就能跳过去。` : undefined}
      onPick={note => {
        if (editor.current?.setSelectedNoteLink(note.id)) { setSelected(editor.current.selectedNode()); toast.success("已关联", `节点现在指向「${note.title || "未命名"}」`); }
        else toast.error("没有选中节点", "先点一下要关联的节点。");
      }} />}
  </div></TooltipProvider>;
}
