import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft, ChevronDown, Copy, FileUp, FolderInput, History, MoreHorizontal, Network, PenTool, Pencil, Plus, RotateCcw, Search, Sparkles, Trash2,
} from "lucide-react";
import { drawioText, type BoardKind, type DrawioData, type MindMapData } from "@kb/shared";
import { api } from "../api";
import { AppNav, saveLastWorkspace } from "./app-nav";
import { NotificationBell } from "./notifications";
import type { MindMapEditorHandle } from "./mind-map-editor";
import type { DrawioBoardHandle } from "./drawio-board";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipProvider } from "./ui/tooltip";
import { useConfirm, usePrompt } from "./ui/confirm";
import { useToast } from "./ui/toast";
import { cn } from "../lib/utils";

// 编辑器（simple-mind-map / draw.io 外壳）只在打开时才需要，单独拆包，不拖慢笔记首屏。
const MindMapEditor = lazy(() => import("./mind-map-editor").then(m => ({ default: m.MindMapEditor })));
const MindMapPreview = lazy(() => import("./mind-map-editor").then(m => ({ default: m.MindMapPreview })));
const DrawioBoard = lazy(() => import("./drawio-board").then(m => ({ default: m.DrawioBoard })));

type Brief = { id: string; notebookId: string; kind: BoardKind; title: string; version: number; createdAt: string; updatedAt: string };
type NotebookRow = { id: string; title: string; canEdit: boolean };
type BoardData = MindMapData | DrawioData;

export const BOARD_KIND_LABEL: Record<BoardKind, string> = { mindmap: "思维导图", drawio: "画板" };
export function BoardIcon({ kind, className }: { kind: BoardKind; className?: string }) {
  return kind === "drawio" ? <PenTool className={className} /> : <Network className={className} />;
}

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
const when = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const errMsg = (e: unknown) => (e as Error).message || "请稍后再试";
const aiErr = (e: unknown) => (e as { code?: string }).code === "AI_NOT_CONFIGURED" ? "还没有可用的 AI，可以在「AI 与自动化」里设置，或联系站点管理员开放平台 AI。" : errMsg(e);

function Header({ wsId, children }: { wsId: string; children?: React.ReactNode }) {
  const nav = useNavigate();
  return <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-background">
    <div className="mx-auto flex h-14 w-full max-w-[1180px] items-center gap-2 px-4 sm:px-6">
      <button className="-mx-1 flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-muted" onClick={() => nav(`/w/${wsId}`)} aria-label="回到笔记">
        <span className="grid size-7 place-items-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">星</span>
      </button>
      <AppNav wsId={wsId} active="mindmaps" />
      <div className="ml-auto flex items-center gap-1">{children}<NotificationBell /></div>
    </div>
  </header>;
}

const selectCls = "h-9 rounded-lg border border-input bg-background px-3 text-sm";
function NotebookSelect({ notebooks, value, onChange }: { notebooks: NotebookRow[]; value: string; onChange: (v: string) => void }) {
  return <label className="grid gap-1.5 text-sm"><span className="text-xs font-medium text-muted-foreground">放在哪个笔记本</span>
    <select className={selectCls} value={value} onChange={e => onChange(e.target.value)}>{notebooks.map(nb => <option key={nb.id} value={nb.id}>{nb.title}</option>)}</select></label>;
}

/** 新建：类型 + 标题 + 放进哪个笔记本。 */
function CreateDialog({ open, kind, onOpenChange, notebooks, onCreate, drawioEnabled = true }: {
  open: boolean; kind: BoardKind; drawioEnabled?: boolean; onOpenChange: (v: boolean) => void; notebooks: NotebookRow[]; onCreate: (kind: BoardKind, title: string, notebookId: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [k, setK] = useState<BoardKind>(kind);
  const [notebookId, setNotebookId] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setTitle(""); setK(kind); setNotebookId(notebooks[0]?.id ?? ""); } }, [open, notebooks, kind]);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader><DialogTitle>新建</DialogTitle><DialogDescription>放在笔记本里：谁能改这个笔记本的笔记，谁就能改这张图。</DialogDescription></DialogHeader>
      <form className="grid gap-3" onSubmit={async e => {
        e.preventDefault();
        if (!title.trim() || !notebookId) return;
        setBusy(true);
        try { await onCreate(k, title.trim(), notebookId); onOpenChange(false); } catch { /* 已提示 */ } finally { setBusy(false); }
      }}>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="类型">
          {(drawioEnabled ? ["mindmap", "drawio"] as const : ["mindmap"] as const).map(x => <button key={x} type="button" role="radio" aria-checked={k === x} onClick={() => setK(x)}
            className={cn("rounded-xl border p-3 text-left transition", k === x ? "border-foreground/40 bg-muted" : "border-border hover:bg-muted/60")}>
            <BoardIcon kind={x} className="size-4" />
            <p className="mt-1.5 text-sm font-medium">{BOARD_KIND_LABEL[x]}</p>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{x === "mindmap" ? "发散、梳理层级，支持大纲、概要、关联线" : "流程图、架构图、泳道图，基于 draw.io"}</p>
          </button>)}
        </div>
        <label className="grid gap-1.5 text-sm"><span className="text-xs font-medium text-muted-foreground">标题</span>
          <Input autoFocus value={title} maxLength={200} placeholder={k === "drawio" ? "比如：下单流程" : "比如：季度规划"} onChange={e => setTitle(e.target.value)} /></label>
        <NotebookSelect notebooks={notebooks} value={notebookId} onChange={setNotebookId} />
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="submit" disabled={busy || !title.trim() || !notebookId}>{busy ? "正在创建…" : "创建"}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}

/** 一句话让 AI 生成导图。 */
function AiCreateDialog({ open, onOpenChange, notebooks, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; notebooks: NotebookRow[]; onDone: (id: string) => void }) {
  const toast = useToast();
  const [prompt, setPrompt] = useState("");
  const [notebookId, setNotebookId] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setPrompt(""); setNotebookId(notebooks[0]?.id ?? ""); } }, [open, notebooks]);
  return <Dialog open={open} onOpenChange={v => { if (!busy) onOpenChange(v); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>用 AI 生成思维导图</DialogTitle><DialogDescription>说说要画什么，AI 先搭好结构，你再接着改。</DialogDescription></DialogHeader>
      <form className="grid gap-3" onSubmit={async e => {
        e.preventDefault();
        if (prompt.trim().length < 2 || !notebookId) return;
        setBusy(true);
        try {
          const d = await api<{ mindMap: Brief }>(`/api/v1/notebooks/${notebookId}/mindmaps/ai`, { method: "POST", body: JSON.stringify({ prompt: prompt.trim() }) });
          toast.success("已生成", `「${d.mindMap.title}」`);
          onOpenChange(false);
          onDone(d.mindMap.id);
        } catch (err) { toast.error("AI 没能生成", aiErr(err)); } finally { setBusy(false); }
      }}>
        <Textarea autoFocus rows={4} maxLength={2000} value={prompt} placeholder="比如：给新人准备的前端工程化学习路线；或者：一场 200 人技术大会的筹备清单" onChange={e => setPrompt(e.target.value)} />
        <NotebookSelect notebooks={notebooks} value={notebookId} onChange={setNotebookId} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="submit" disabled={busy || prompt.trim().length < 2 || !notebookId}><Sparkles />{busy ? "AI 正在生成…" : "生成"}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}

/** 导入文件（Markdown / XMind / OPML / FreeMind / JSON）成一张新导图。 */
function ImportDialog({ open, onOpenChange, notebooks, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; notebooks: NotebookRow[]; onDone: (id: string) => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [notebookId, setNotebookId] = useState("");
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");
  useEffect(() => { if (open) { setFile(null); setNotebookId(notebooks[0]?.id ?? ""); } }, [open, notebooks]);
  useEffect(() => { if (open) void import("../lib/mind-map-io").then(m => setHint(m.IMPORT_HINT)); }, [open]);
  return <Dialog open={open} onOpenChange={v => { if (!busy) onOpenChange(v); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>导入思维导图</DialogTitle><DialogDescription>{hint || "正在准备…"}。导入后是一张新的导图。</DialogDescription></DialogHeader>
      <form className="grid gap-3" onSubmit={async e => {
        e.preventDefault();
        if (!file || !notebookId) return;
        setBusy(true);
        try {
          const io = await import("../lib/mind-map-io");
          const { data, title } = await io.importMindMapFile(file);
          const d = await api<{ mindMap: Brief }>(`/api/v1/notebooks/${notebookId}/mindmaps`, { method: "POST", body: JSON.stringify({ title: title || file.name, kind: "mindmap", data, source: "import" }) });
          toast.success("已导入", `「${d.mindMap.title}」`);
          onOpenChange(false);
          onDone(d.mindMap.id);
        } catch (err) { toast.error("导入失败", errMsg(err)); } finally { setBusy(false); }
      }}>
        <label className="grid gap-1.5 text-sm"><span className="text-xs font-medium text-muted-foreground">文件</span>
          <input type="file" accept=".md,.markdown,.txt,.xmind,.opml,.mm,.json,.smm" className="text-sm file:mr-3 file:rounded-lg file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-sm"
            onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
        <NotebookSelect notebooks={notebooks} value={notebookId} onChange={setNotebookId} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="submit" disabled={busy || !file || !notebookId}><FileUp />{busy ? "正在导入…" : "导入"}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}

function MoveDialog({ open, onOpenChange, notebooks, current, onMove }: { open: boolean; onOpenChange: (v: boolean) => void; notebooks: NotebookRow[]; current: string; onMove: (id: string) => Promise<void> }) {
  const [notebookId, setNotebookId] = useState(current);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setNotebookId(current); }, [open, current]);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader><DialogTitle>移到其他笔记本</DialogTitle><DialogDescription>移过去之后，看得见、改得了这张图的人按新笔记本的权限来。</DialogDescription></DialogHeader>
      <NotebookSelect notebooks={notebooks} value={notebookId} onChange={setNotebookId} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
        <Button disabled={busy || !notebookId || notebookId === current} onClick={async () => { setBusy(true); try { await onMove(notebookId); onOpenChange(false); } catch { /* 已提示 */ } finally { setBusy(false); } }}>{busy ? "正在移动…" : "移动"}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}

/** 列表页：按笔记本分组，能按类型筛选、按标题过滤。 */
export function MindMapsPage() {
  const { wsId = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [notebooks, setNotebooks] = useState<NotebookRow[]>([]);
  const [maps, setMaps] = useState<Brief[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [creating, setCreating] = useState<BoardKind | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [moving, setMoving] = useState<Brief | null>(null);
  const [filter, setFilter] = useState<"all" | BoardKind>("all");
  const [q, setQ] = useState("");
  const [drawioEnabled, setDrawioEnabled] = useState(true);

  useEffect(() => { if (wsId) saveLastWorkspace(wsId); }, [wsId]);
  const load = useCallback(async () => {
    setState(s => s === "ready" ? s : "loading");
    try {
      const d = await api<{ notebooks: NotebookRow[]; mindMaps: Brief[]; drawioEnabled?: boolean }>(`/api/v1/workspaces/${wsId}/mindmaps`);
      setNotebooks(d.notebooks); setMaps(d.mindMaps); setDrawioEnabled(d.drawioEnabled !== false); setState("ready");
    } catch (e) { setState("failed"); toast.error("没能加载思维导图", errMsg(e)); }
  }, [wsId, toast]);
  useEffect(() => { void load(); }, [load]);

  const editable = notebooks.filter(nb => nb.canEdit);
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return maps.filter(m => (filter === "all" || m.kind === filter) && (!k || m.title.toLowerCase().includes(k)));
  }, [maps, filter, q]);
  const groups = useMemo(() => notebooks.map(nb => ({ nb, maps: shown.filter(m => m.notebookId === nb.id) })).filter(g => g.maps.length), [notebooks, shown]);
  const counts = useMemo(() => ({ all: maps.length, mindmap: maps.filter(m => m.kind === "mindmap").length, drawio: maps.filter(m => m.kind === "drawio").length }), [maps]);

  async function rename(m: Brief) {
    const title = await prompt({ title: `重命名${BOARD_KIND_LABEL[m.kind]}`, label: "标题", defaultValue: m.title, confirmText: "保存" });
    if (title === null || !title.trim() || title.trim() === m.title) return;
    try {
      const d = await api<{ mindMap: Brief }>(`/api/v1/mindmaps/${m.id}`, { method: "PATCH", body: JSON.stringify({ title: title.trim(), expectedVersion: m.version }) });
      setMaps(list => list.map(x => x.id === m.id ? d.mindMap : x));
      toast.success("已重命名");
    } catch (e) { toast.error("重命名失败", errMsg(e)); }
  }
  async function duplicate(m: Brief) {
    try {
      const d = await api<{ mindMap: Brief }>(`/api/v1/mindmaps/${m.id}/duplicate`, { method: "POST", body: "{}" });
      setMaps(list => [d.mindMap, ...list]);
      toast.success("已复制", `「${d.mindMap.title}」`);
    } catch (e) { toast.error("复制失败", errMsg(e)); }
  }
  async function remove(m: Brief) {
    if (!await confirm({ title: `把「${m.title}」移到回收站？`, description: "30 天内可以在回收站恢复，之后会被彻底删除。关联的笔记不受影响。", confirmText: "移到回收站", destructive: true })) return;
    try {
      await api(`/api/v1/mindmaps/${m.id}`, { method: "DELETE" });
      setMaps(list => list.filter(x => x.id !== m.id));
      toast.success("已移到回收站", "30 天内可以在回收站恢复。");
    } catch (e) { toast.error("删除失败", errMsg(e)); }
  }

  return <div className="flex h-full min-h-0 flex-col bg-muted/25">
    <Header wsId={wsId}><Button variant="ghost" size="sm" onClick={() => nav(`/w/${wsId}`)}>笔记</Button></Header>
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1180px] px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-[-.035em]">思维导图与画板</h1>
            <p className="mt-1 text-sm text-muted-foreground">导图用来理思路，画板用来画流程和架构。都能关联笔记，点一下就跳过去。</p>
          </div>
          {editable.length > 0 && <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}><FileUp />导入</Button>
            <Button size="sm" variant="outline" onClick={() => setAiOpen(true)}><Sparkles />AI 生成</Button>
            <DropdownMenu><DropdownMenuTrigger asChild><Button size="sm"><Plus />新建<ChevronDown className="opacity-70" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setCreating("mindmap")}><Network />思维导图</DropdownMenuItem>
                {drawioEnabled && <DropdownMenuItem onSelect={() => setCreating("drawio")}><PenTool />draw.io 画板</DropdownMenuItem>}
              </DropdownMenuContent></DropdownMenu>
          </div>}
        </div>
        {state === "ready" && maps.length > 0 && <div className="mt-6 flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-border bg-background p-0.5" role="tablist" aria-label="按类型筛选">
            {([["all", "全部"], ["mindmap", "思维导图"], ["drawio", "画板"]] as const).map(([k, label]) =>
              <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}
                className={cn("rounded-md px-3 py-1 text-sm", filter === k ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}>{label}<span className="ml-1 text-xs text-muted-foreground">{counts[k]}</span></button>)}
          </div>
          <div className="relative ml-auto w-full sm:w-64"><Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input value={q} placeholder="按标题筛选" className="pl-8" aria-label="按标题筛选" onChange={e => setQ(e.target.value)} /></div>
        </div>}
        {state === "loading" ? <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <div key={i} className="h-28 animate-pulse rounded-xl border bg-muted/50" />)}</div>
          : state === "failed" ? <div className="mt-16 text-center"><p className="text-sm text-muted-foreground">没能加载思维导图。</p><Button className="mt-3" variant="outline" onClick={() => void load()}><RotateCcw />重试</Button></div>
          : !maps.length ? <div className="mx-auto mt-16 max-w-md text-center">
            <Network className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">还没有思维导图或画板</p>
            <p className="mt-1 text-sm text-muted-foreground">{notebooks.length
              ? "新建一张空白图、导入 XMind / Markdown，或者让 AI 先搭个架子。也可以在笔记右侧栏的「思维导图」里从笔记一键生成。"
              : "思维导图放在笔记本里。先去建一个笔记本吧。"}</p>
            {editable.length > 0 ? <div className="mt-4 flex justify-center gap-2"><Button onClick={() => setCreating("mindmap")}><Plus />新建思维导图</Button>{drawioEnabled && <Button variant="outline" onClick={() => setCreating("drawio")}><PenTool />新建画板</Button>}</div>
              : !notebooks.length && <Button className="mt-4" variant="outline" onClick={() => nav(`/w/${wsId}`)}>去笔记</Button>}
          </div>
          : !groups.length ? <p className="mt-16 text-center text-sm text-muted-foreground">没有符合条件的图。</p>
          : <div className="mt-6 space-y-7">{groups.map(({ nb, maps: list }) => <section key={nb.id}>
            <div className="mb-3 flex items-center gap-2"><h2 className="text-sm font-semibold">{nb.title}</h2><span className="text-xs text-muted-foreground">{list.length} 张</span></div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{list.map(m => <div key={m.id} className="group relative rounded-xl border border-border bg-background transition hover:border-foreground/20 hover:shadow-sm">
              <button className="block w-full p-4 text-left" onClick={() => nav(mindMapPath(wsId, m.id))}>
                <div className="flex items-center gap-2"><BoardIcon kind={m.kind} className="size-4 text-muted-foreground" /><Badge>{BOARD_KIND_LABEL[m.kind]}</Badge></div>
                <p className="mt-2 truncate pr-8 font-medium">{m.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{ago(m.updatedAt)}更新</p>
              </button>
              {nb.canEdit && <DropdownMenu><DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`「${m.title}」的更多操作`} className="absolute right-2 top-2 size-8 opacity-60 group-hover:opacity-100"><MoreHorizontal /></Button>
              </DropdownMenuTrigger><DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void rename(m)}><Pencil />重命名</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void duplicate(m)}><Copy />复制一份</DropdownMenuItem>
                {editable.length > 1 && <DropdownMenuItem onSelect={() => setMoving(m)}><FolderInput />移到其他笔记本</DropdownMenuItem>}
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive" onSelect={() => void remove(m)}><Trash2 />移到回收站</DropdownMenuItem>
              </DropdownMenuContent></DropdownMenu>}
            </div>)}</div>
          </section>)}</div>}
      </div>
    </main>
    <CreateDialog open={!!creating} kind={creating ?? "mindmap"} drawioEnabled={drawioEnabled} onOpenChange={v => { if (!v) setCreating(null); }} notebooks={editable} onCreate={async (kind, title, notebookId) => {
      try {
        const d = await api<{ mindMap: Brief }>(`/api/v1/notebooks/${notebookId}/mindmaps`, { method: "POST", body: JSON.stringify({ title, kind }) });
        nav(mindMapPath(wsId, d.mindMap.id));
      } catch (e) { toast.error("创建失败", errMsg(e)); throw e; }
    }} />
    <AiCreateDialog open={aiOpen} onOpenChange={setAiOpen} notebooks={editable} onDone={id => nav(mindMapPath(wsId, id))} />
    <ImportDialog open={importOpen} onOpenChange={setImportOpen} notebooks={editable} onDone={id => nav(mindMapPath(wsId, id))} />
    <MoveDialog open={!!moving} onOpenChange={v => { if (!v) setMoving(null); }} notebooks={editable} current={moving?.notebookId ?? ""} onMove={async notebookId => {
      if (!moving) return;
      try {
        const d = await api<{ mindMap: Brief }>(`/api/v1/mindmaps/${moving.id}`, { method: "PATCH", body: JSON.stringify({ notebookId, expectedVersion: moving.version }) });
        setMaps(list => list.map(x => x.id === moving.id ? d.mindMap : x));
        toast.success("已移动", `放进了「${notebooks.find(n => n.id === notebookId)?.title ?? "目标笔记本"}」`);
      } catch (e) { toast.error("移动失败", errMsg(e)); throw e; }
    }} />
  </div>;
}

type VersionRow = { id: string; version: number; title: string; source: string; editorName: string; createdAt: string; updatedAt: string };
const SOURCE_LABEL: Record<string, string> = { edit: "编辑", mcp: "MCP / 外部工具", restore: "恢复历史版本", import: "导入", ai: "AI 生成", create: "新建", migrate: "升级迁移" };

/** 版本历史：左边列表，右边预览，确认后恢复（恢复本身也记成新的一版）。 */
function VersionsDialog({ open, onOpenChange, mapId, kind, canEdit, beforeRestore, onRestored }: {
  open: boolean; onOpenChange: (v: boolean) => void; mapId: string; kind: BoardKind; canEdit: boolean;
  beforeRestore: () => Promise<number | null>; onRestored: (map: Brief & { data: BoardData }) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<VersionRow[] | null>(null);
  const [current, setCurrent] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ version: number; data: BoardData } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setRows(null); setPicked(null); setPreview(null);
    api<{ current: number; versions: VersionRow[] }>(`/api/v1/mindmaps/${mapId}/versions`)
      .then(d => { if (!live) return; setRows(d.versions); setCurrent(d.current); setPicked(d.versions[0]?.version ?? null); })
      .catch(e => { if (live) { setRows([]); toast.error("没能读取版本历史", errMsg(e)); } });
    return () => { live = false; };
  }, [open, mapId, toast]);
  useEffect(() => {
    if (picked === null) return;
    let live = true;
    setPreview(null);
    api<{ version: number; data: BoardData }>(`/api/v1/mindmaps/${mapId}/versions/${picked}`)
      .then(d => { if (live) setPreview(d); })
      .catch(e => { if (live) toast.error("没能读取这个版本", errMsg(e)); });
    return () => { live = false; };
  }, [picked, mapId, toast]);
  const row = rows?.find(r => r.version === picked);
  async function restore() {
    if (!row) return;
    if (!await confirm({ title: `恢复到 ${when(row.updatedAt)} 的版本？`, description: "当前内容不会丢：恢复会记成新的一版，随时可以再恢复回来。", confirmText: "恢复" })) return;
    setBusy(true);
    try {
      const expected = await beforeRestore();
      if (expected === null) return;
      const d = await api<{ mindMap: Brief & { data: BoardData } }>(`/api/v1/mindmaps/${mapId}/versions/${row.version}/restore`, { method: "POST", body: JSON.stringify({ expectedVersion: expected }) });
      toast.success("已恢复", `回到了 ${when(row.updatedAt)} 的版本`);
      onOpenChange(false);
      onRestored(d.mindMap);
    } catch (e) { toast.error("恢复失败", errMsg(e)); } finally { setBusy(false); }
  }
  const drawioLabels = preview && kind === "drawio" ? drawioText((preview.data as DrawioData).xml).split("\n").filter(Boolean) : [];
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex h-[82vh] max-w-5xl flex-col gap-3">
      <DialogHeader><DialogTitle>版本历史</DialogTitle><DialogDescription>自动保存会把 5 分钟内的连续修改合成一版；恢复、导入、AI 生成总是单独成一版。保留最近 100 版，更早的每天留一版，最多 90 天。</DialogDescription></DialogHeader>
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="w-60 shrink-0 overflow-y-auto rounded-xl border border-border p-1" role="listbox" aria-label="版本列表">
          {!rows ? <p className="p-3 text-sm text-muted-foreground">正在读取…</p> : !rows.length ? <p className="p-3 text-sm text-muted-foreground">还没有历史版本。</p>
            : rows.map(r => <button key={r.id} type="button" role="option" aria-selected={picked === r.version} onClick={() => setPicked(r.version)}
              className={cn("block w-full rounded-lg px-2.5 py-2 text-left", picked === r.version ? "bg-muted" : "hover:bg-muted/60")}>
              <span className="flex items-center gap-1.5 text-sm font-medium">{when(r.updatedAt)}{r.version === current && <Badge>当前</Badge>}</span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">{r.editorName} · {SOURCE_LABEL[r.source] ?? r.source}</span>
            </button>)}
        </div>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border">
          <div className="min-h-0 flex-1">
            {!preview ? <div className="grid h-full place-items-center text-sm text-muted-foreground">{picked === null ? "选一个版本看看" : "正在读取…"}</div>
              : kind === "mindmap" ? <Suspense fallback={<div className="grid h-full place-items-center text-sm text-muted-foreground">正在渲染…</div>}><MindMapPreview data={preview.data as MindMapData} /></Suspense>
              : <div className="h-full overflow-y-auto p-4 text-sm">
                <p className="text-xs text-muted-foreground">画板版本以文字摘要预览（{drawioLabels.length} 处文字），恢复后可在画板里查看完整图形。</p>
                <ul className="mt-2 list-disc space-y-0.5 pl-5">{drawioLabels.slice(0, 300).map((t, i) => <li key={i}>{t}</li>)}</ul>
                {!drawioLabels.length && <p className="mt-2 text-muted-foreground">这个版本的画板是空的。</p>}
              </div>}
          </div>
          {row && <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
            <p className="truncate text-xs text-muted-foreground">「{row.title}」· {row.editorName} · {SOURCE_LABEL[row.source] ?? row.source}</p>
            {canEdit && row.version !== current && <Button size="sm" disabled={busy || !preview} onClick={() => void restore()}><RotateCcw />{busy ? "正在恢复…" : "恢复这个版本"}</Button>}
          </div>}
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}

type Loaded = { mindMap: Brief & { data: BoardData }; notebook: { id: string; title: string }; workspaceId: string; canEdit: boolean; drawioUrl: string };
type SaveState = "saved" | "dirty" | "saving" | "conflict" | "failed";
const SAVE_LABEL: Record<SaveState, string> = { saved: "已保存", dirty: "有改动未保存", saving: "正在保存…", conflict: "未保存：别人刚改过这张图", failed: "保存失败，稍后自动重试" };

/**
 * 自动保存：约 0.8 秒防抖，带版本号防覆盖。导图和画板共用：调用方把最新数据交给 schedule。
 * 卸载 / 离开页面时把没存的立刻发出去（keepalive 保证页面关了请求也能到）。
 */
function useBoardSaver(loaded: Loaded | null, getLatest: () => BoardData | null) {
  const toast = useToast();
  const [state, setState] = useState<SaveState>("saved");
  const version = useRef(0);
  const lastSaved = useRef("");
  const pending = useRef<BoardData | null>(null);
  const timer = useRef<number | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const blocked = useRef(false);
  const source = useRef<"edit" | "import" | "ai">("edit");
  const latest = useRef(getLatest);
  latest.current = getLatest;

  const reset = useCallback((l: Loaded) => {
    version.current = l.mindMap.version;
    lastSaved.current = JSON.stringify(l.mindMap.data);
    pending.current = null;
    blocked.current = false;
    source.current = "edit";
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    setState("saved");
  }, []);

  const save = useCallback(async (): Promise<void> => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    if (inFlight.current) { await inFlight.current; }
    const data = latest.current() ?? pending.current;
    if (!data || !loaded?.canEdit || blocked.current) return;
    const body = JSON.stringify(data);
    if (body === lastSaved.current) { setState("saved"); return; }
    setState("saving");
    const run = (async () => {
      try {
        const d = await api<{ mindMap: Brief }>(`/api/v1/mindmaps/${loaded.mindMap.id}`, { method: "PATCH", keepalive: body.length < 60_000, body: JSON.stringify({ data, expectedVersion: version.current, source: source.current }) });
        source.current = "edit";
        version.current = d.mindMap.version;
        lastSaved.current = body;
        setState("saved");
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "CONFLICT_VERSION") { blocked.current = true; setState("conflict"); toast.error("没保存上", "这张图刚被别人改过。点「重新加载」拿最新版本（你这次的改动会丢失，但之前保存的版本都在版本历史里）。"); }
        else if (code === "VALIDATION" || code === "PAYLOAD_TOO_LARGE" || code === "FORBIDDEN" || code === "NOT_FOUND") { blocked.current = true; setState("failed"); toast.error("保存失败", errMsg(e)); }
        else { setState("failed"); toast.error("保存失败", `${errMsg(e)}。稍后会自动重试。`); timer.current = window.setTimeout(() => void saveRef.current(), 5000); }
      }
    })();
    inFlight.current = run;
    await run;
    inFlight.current = null;
    // 保存期间又改了：接着存。
    const again = latest.current() ?? pending.current;
    if (!blocked.current && again && JSON.stringify(again) !== lastSaved.current) {
      setState("dirty");
      timer.current = window.setTimeout(() => void saveRef.current(), 800);
    }
  }, [loaded, toast]);
  const saveRef = useRef(save);
  saveRef.current = save;

  const schedule = useCallback((data?: BoardData | null) => {
    if (!loaded?.canEdit || blocked.current) return;
    const snap = data ?? latest.current();
    if (snap) pending.current = snap;
    if (pending.current && JSON.stringify(pending.current) === lastSaved.current) { setState(s => s === "saving" ? s : "saved"); return; }
    setState(s => s === "saving" ? s : "dirty");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void saveRef.current(), 800);
  }, [loaded]);

  useEffect(() => {
    const flush = () => { if (timer.current) void saveRef.current(); };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, []);

  /** 导入 / AI 改动：下一次保存单独成版（服务端不会把它并进 5 分钟内的普通编辑）。 */
  const hint = useCallback((s: "import" | "ai") => { source.current = s; }, []);

  /** 先把没存的存掉，返回当前服务端版本号；冲突 / 失败返回 null。 */
  const settle = useCallback(async (): Promise<number | null> => {
    await saveRef.current();
    return blocked.current ? null : version.current;
  }, []);
  const dirty = () => !!timer.current || !!inFlight.current;

  return { state, version, reset, schedule, save, settle, hint, dirty, blocked };
}

/** 编辑页：思维导图 / 画板共用外壳（标题、保存状态、版本历史、复制、移动、删除）。 */
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
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [moveTargets, setMoveTargets] = useState<NotebookRow[] | null>(null);
  const [mountKey, setMountKey] = useState(0);
  const editor = useRef<MindMapEditorHandle | null>(null);
  const board = useRef<DrawioBoardHandle | null>(null);
  const saver = useBoardSaver(loaded, () => loaded?.mindMap.kind === "drawio" ? board.current?.getData() ?? null : editor.current?.getData() ?? null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const d = await api<Loaded>(`/api/v1/mindmaps/${mindMapId}`);
      saver.reset(d);
      setLoaded(d);
      setMountKey(k => k + 1);
    } catch (e) { setFailed(true); toast.error("打不开这张图", errMsg(e)); }
  }, [mindMapId, toast]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (wsId) saveLastWorkspace(wsId); }, [wsId]);
  useEffect(() => {
    if (loaded && focusNodeId && loaded.mindMap.kind === "mindmap") { const t = window.setTimeout(() => editor.current?.focusNode(focusNodeId), 300); return () => window.clearTimeout(t); }
  }, [loaded, focusNodeId, mountKey]);
  useEffect(() => { if (loaded) document.title = `${loaded.mindMap.title} · ${BOARD_KIND_LABEL[loaded.mindMap.kind]}`; }, [loaded]);

  const kind = loaded?.mindMap.kind ?? "mindmap";
  const label = BOARD_KIND_LABEL[kind];
  const canEdit = !!loaded?.canEdit;

  async function openNote(noteId: string) {
    try {
      const note = await api<{ id: string; workspaceId: string }>(`/api/v1/notes/${noteId}`);
      if (saver.dirty()) await saver.save();
      nav(`/w/${note.workspaceId}/n/${note.id}`);
    } catch { toast.error("打不开关联的笔记", "笔记可能已被删除，或者你没有查看权限。"); }
  }

  async function rename() {
    if (!loaded || !canEdit) return;
    const title = await prompt({ title: `重命名${label}`, label: "标题", defaultValue: loaded.mindMap.title, confirmText: "保存" });
    if (title === null || !title.trim() || title.trim() === loaded.mindMap.title) return;
    const expected = await saver.settle();
    if (expected === null) return;
    try {
      const d = await api<{ mindMap: Brief }>(`/api/v1/mindmaps/${loaded.mindMap.id}`, { method: "PATCH", body: JSON.stringify({ title: title.trim(), expectedVersion: expected }) });
      saver.version.current = d.mindMap.version;
      setLoaded(l => l && { ...l, mindMap: { ...l.mindMap, title: d.mindMap.title } });
      toast.success("已重命名");
    } catch (e) { toast.error("重命名失败", errMsg(e)); }
  }
  async function duplicate() {
    if (!loaded) return;
    if (saver.dirty()) await saver.save();
    try {
      const d = await api<{ mindMap: Brief }>(`/api/v1/mindmaps/${loaded.mindMap.id}/duplicate`, { method: "POST", body: "{}" });
      toast.success("已复制", `正在打开「${d.mindMap.title}」`);
      nav(mindMapPath(wsId, d.mindMap.id));
    } catch (e) { toast.error("复制失败", errMsg(e)); }
  }
  async function openMove() {
    try {
      const d = await api<{ notebooks: NotebookRow[] }>(`/api/v1/workspaces/${loaded?.workspaceId ?? wsId}/mindmaps`);
      setMoveTargets(d.notebooks.filter(n => n.canEdit));
    } catch (e) { toast.error("没能读取笔记本", errMsg(e)); }
  }
  async function remove() {
    if (!loaded) return;
    if (!await confirm({ title: `把「${loaded.mindMap.title}」移到回收站？`, description: "30 天内可以在回收站恢复，之后会被彻底删除。关联的笔记不受影响。", confirmText: "移到回收站", destructive: true })) return;
    try {
      await saver.save();
      saver.blocked.current = true;
      await api(`/api/v1/mindmaps/${loaded.mindMap.id}`, { method: "DELETE" });
      toast.success("已移到回收站", "30 天内可以在回收站恢复。");
      nav(mindMapPath(wsId));
    } catch (e) { saver.blocked.current = false; toast.error("删除失败", errMsg(e)); }
  }

  const leading = <>
    <Tooltip content="返回列表"><Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label="返回列表" onClick={() => nav(mindMapPath(wsId))}><ArrowLeft /></Button></Tooltip>
    <div className="min-w-0 max-w-[32vw] shrink">
      <button className="block max-w-full truncate text-sm font-semibold hover:underline disabled:no-underline" disabled={!canEdit} onClick={() => void rename()} title={canEdit ? "点击重命名" : undefined}>{loaded?.mindMap.title ?? label}</button>
      {loaded && <p className="truncate text-[11px] text-muted-foreground">{label} · {loaded.notebook.title}{canEdit ? "" : " · 只读"}</p>}
    </div>
    {loaded && canEdit && <span className="ml-1 hidden shrink-0 text-xs text-muted-foreground md:inline" aria-live="polite" data-testid="save-state">{SAVE_LABEL[saver.state]}</span>}
    {saver.state === "conflict" && <Button size="sm" variant="outline" className="ml-1 shrink-0" onClick={() => { setLoaded(null); void load(); }}><RotateCcw />重新加载</Button>}
  </>;
  const menu = <>
    <DropdownMenuItem onSelect={() => setVersionsOpen(true)}><History />版本历史</DropdownMenuItem>
    {canEdit && <DropdownMenuItem onSelect={() => void duplicate()}><Copy />复制一份</DropdownMenuItem>}
    {canEdit && <DropdownMenuItem onSelect={() => void openMove()}><FolderInput />移到其他笔记本</DropdownMenuItem>}
    {canEdit && <DropdownMenuItem className="text-destructive" onSelect={() => void remove()}><Trash2 />移到回收站</DropdownMenuItem>}
  </>;
  const opening = <div className="grid h-full place-items-center text-sm text-muted-foreground">正在打开…</div>;

  return <TooltipProvider delayDuration={300}><div className="flex h-full min-h-0 flex-col bg-background">
    <Header wsId={wsId} />
    <main className="relative min-h-0 flex-1">
      {loaded ? <Suspense fallback={opening}>
        {loaded.mindMap.kind === "drawio"
          ? <DrawioBoard key={`${loaded.mindMap.id}:${mountKey}`} ref={board} data={loaded.mindMap.data as DrawioData} title={loaded.mindMap.title} mapId={loaded.mindMap.id}
            workspaceId={loaded.workspaceId} editable={canEdit} drawioUrl={loaded.drawioUrl} leading={leading} menu={menu} onChange={d => saver.schedule(d)} onSourceHint={s => saver.hint(s)} onOpenNote={id => void openNote(id)} onSaveNow={() => void saver.save()} />
          : <MindMapEditor key={`${loaded.mindMap.id}:${mountKey}`} ref={editor} data={loaded.mindMap.data as MindMapData} title={loaded.mindMap.title} mapId={loaded.mindMap.id}
            workspaceId={loaded.workspaceId} editable={canEdit} leading={leading} menu={menu} onChange={() => saver.schedule()} onSourceHint={s => saver.hint(s)} onOpenNote={id => void openNote(id)} onSaveNow={() => void saver.save()} />}
      </Suspense>
        : failed ? <div className="grid h-full place-items-center"><div className="text-center"><p className="text-sm text-muted-foreground">这张图打不开：可能已被删除，或者你没有查看权限。</p>
          <div className="mt-3 flex justify-center gap-2"><Button variant="outline" onClick={() => void load()}><RotateCcw />重试</Button><Button variant="ghost" onClick={() => nav(mindMapPath(wsId))}>回到列表</Button></div></div></div>
        : opening}
    </main>
    {loaded && <VersionsDialog open={versionsOpen} onOpenChange={setVersionsOpen} mapId={loaded.mindMap.id} kind={loaded.mindMap.kind} canEdit={canEdit}
      beforeRestore={() => saver.settle()} onRestored={map => {
        const next: Loaded = { ...loaded, mindMap: { ...loaded.mindMap, ...map } };
        saver.reset(next);
        setLoaded(next);
        setMountKey(k => k + 1);
      }} />}
    {loaded && <MoveDialog open={!!moveTargets} onOpenChange={v => { if (!v) setMoveTargets(null); }} notebooks={moveTargets ?? []} current={loaded.notebook.id} onMove={async notebookId => {
      const expected = await saver.settle();
      if (expected === null) throw new Error("conflict");
      try {
        const d = await api<{ mindMap: Brief }>(`/api/v1/mindmaps/${loaded.mindMap.id}`, { method: "PATCH", body: JSON.stringify({ notebookId, expectedVersion: expected }) });
        saver.version.current = d.mindMap.version;
        const nb = moveTargets?.find(n => n.id === notebookId);
        setLoaded(l => l && { ...l, notebook: { id: notebookId, title: nb?.title ?? l.notebook.title }, mindMap: { ...l.mindMap, notebookId } });
        toast.success("已移动", `放进了「${nb?.title ?? "目标笔记本"}」`);
      } catch (e) { toast.error("移动失败", errMsg(e)); throw e; }
    }} />}
  </div></TooltipProvider>;
}
