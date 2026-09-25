import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { BookOpen, Download, Maximize, MoreHorizontal, Send, Sparkles, Undo2, X } from "lucide-react";
import type { DrawioData } from "@kb/shared";
import { api } from "../api";
import { downloadBlob, fileSafe } from "../lib/mind-map-io";
import { cn } from "../lib/utils";
import { NotePickerDialog } from "./note-picker-dialog";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Textarea } from "./ui/textarea";
import { Tooltip } from "./ui/tooltip";
import { useConfirm } from "./ui/confirm";
import { useToast } from "./ui/toast";

/**
 * draw.io 画板（设计 25 §画板）。编辑器跑在跨源 iframe 里（默认 embed.diagrams.net，可自托管），
 * 通过官方 embed 协议（proto=json 的 postMessage）交换 XML：
 * init → 我们发 load；用户每改一次它发 autosave（带完整 XML），我们交给外层防抖保存。
 * 图形内容只在浏览器里处理，不经过 diagrams.net 的服务器。
 */

export type DrawioBoardHandle = { getData: () => DrawioData };
type Props = {
  data: DrawioData;
  title: string;
  mapId: string;
  workspaceId: string;
  editable: boolean;
  drawioUrl: string;
  leading: React.ReactNode;
  menu: React.ReactNode;
  onChange: (data: DrawioData) => void;
  onOpenNote: (noteId: string) => void;
  onSaveNow: () => void;
  /** 下一次保存单独记一版并标上来源（导入 / AI），不和普通编辑合并。 */
  onSourceHint?: (source: "import" | "ai") => void;
};
type ChatMsg = { role: "user" | "assistant"; content: string };
type Panel = null | "ai" | "notes";

function dataUrlToBlob(url: string) {
  const [head, body = ""] = url.split(",", 2);
  const mime = /data:([^;]+)/.exec(head ?? "")?.[1] ?? "application/octet-stream";
  const bin = /;base64/.test(head ?? "") ? atob(body) : decodeURIComponent(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export const DrawioBoard = forwardRef<DrawioBoardHandle, Props>(function DrawioBoard(props, ref) {
  const { data, title, mapId, workspaceId, editable, drawioUrl, leading, menu } = props;
  const toast = useToast();
  const confirm = useConfirm();
  const frame = useRef<HTMLIFrameElement | null>(null);
  const shell = useRef<HTMLDivElement | null>(null);
  const xml = useRef(data.xml);
  const noteIds = useRef<string[]>(data.noteIds);
  const handlers = useRef(props);
  handlers.current = props;
  const exportWaiters = useRef<Array<(d: string | null) => void>>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [panel, setPanel] = useState<Panel>(null);
  const [links, setLinks] = useState<string[]>(data.noteIds);
  const [picking, setPicking] = useState(false);
  const origin = (() => { try { return new URL(drawioUrl, window.location.href).origin; } catch { return ""; } })();

  const getData = useCallback((): DrawioData => ({ format: "drawio", xml: xml.current, noteIds: noteIds.current }), []);
  useImperativeHandle(ref, () => ({ getData }), [getData]);

  const post = useCallback((msg: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage(JSON.stringify(msg), origin || "*");
  }, [origin]);

  const src = (() => {
    const dark = document.documentElement.dataset.mode === "dark";
    const q = new URLSearchParams({ embed: "1", proto: "json", spin: "1", lang: "zh", ui: "kennedy", dark: dark ? "1" : "0", libraries: "1", noSaveBtn: "1", noExitBtn: "1", saveAndExit: "0" });
    if (!editable) q.set("chrome", "0");
    return `${drawioUrl}/?${q.toString()}`;
  })();

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || (origin && e.origin !== origin) || typeof e.data !== "string") return;
      let msg: { event?: string; xml?: string; data?: string; format?: string; message?: string };
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.event === "init") {
        post({ action: "load", xml: xml.current, autosave: editable ? 1 : 0, title });
        setStatus("ready");
      } else if ((msg.event === "autosave" || msg.event === "save") && typeof msg.xml === "string" && editable) {
        xml.current = msg.xml;
        handlers.current.onChange(getData());
        if (msg.event === "save") handlers.current.onSaveNow();
      } else if (msg.event === "export") {
        const w = exportWaiters.current.shift();
        w?.(typeof msg.data === "string" ? msg.data : null);
      }
    };
    window.addEventListener("message", onMessage);
    const t = window.setTimeout(() => setStatus(s => {
      if (s === "loading") toast.error("画板编辑器没加载出来", "draw.io 编辑器地址连不上。内网部署请让管理员自托管 draw.io 并配置 DRAWIO_URL。");
      return s === "loading" ? "failed" : s;
    }), 25_000);
    return () => { window.removeEventListener("message", onMessage); window.clearTimeout(t); };
  }, [origin, post, editable, title, getData, toast]);

  const exportAs = async (format: "png" | "svg" | "xml") => {
    const name = fileSafe(title);
    if (format === "xml") {
      downloadBlob(new Blob([xml.current || "<mxfile/>"], { type: "application/xml" }), `${name}.drawio`);
      toast.success("已导出", `${name}.drawio`);
      return;
    }
    if (status !== "ready") { toast.error("编辑器还没准备好", "稍等片刻再导出。"); return; }
    const result = await new Promise<string | null>(resolve => {
      exportWaiters.current.push(resolve);
      post({ action: "export", format, spinKey: "export", background: format === "png" ? "#ffffff" : undefined, border: 10, scale: format === "png" ? 2 : 1 });
      window.setTimeout(() => { const i = exportWaiters.current.indexOf(resolve); if (i >= 0) { exportWaiters.current.splice(i, 1); resolve(null); } }, 30_000);
    });
    if (!result) { toast.error("导出失败", "编辑器没有返回图片，稍后再试。"); return; }
    downloadBlob(dataUrlToBlob(result), `${name}.${format}`);
    toast.success("已导出", `${name}.${format}`);
  };

  const toggleFullscreen = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await shell.current?.requestFullscreen(); }
    catch { toast.error("没能进入全屏", "浏览器拒绝了全屏请求。"); }
  };

  /** AI 生成的新图：整份替换，旧 XML 留在撤销栈里。 */
  const applyXml = useCallback((next: string) => {
    xml.current = next;
    handlers.current.onSourceHint?.("ai");
    post({ action: "load", xml: next, autosave: 1, title });
    handlers.current.onChange(getData());
  }, [post, title, getData]);

  const setNoteLinks = (next: string[]) => {
    noteIds.current = next;
    setLinks(next);
    handlers.current.onChange(getData());
  };

  const tool = (label: string, icon: React.ReactNode, onClick: () => void, opts: { active?: boolean; disabled?: boolean } = {}) =>
    <Tooltip content={label}><Button variant="ghost" size="icon" className={cn("size-8 shrink-0", opts.active && "bg-muted")} aria-label={label} aria-pressed={opts.active} disabled={opts.disabled} onClick={onClick}>{icon}</Button></Tooltip>;

  return <div ref={shell} className="flex h-full min-h-0 flex-col bg-background">
    <div className="flex min-h-12 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1.5 sm:px-3" role="toolbar" aria-label="画板工具栏">
      {leading}
      <div className="ml-auto flex items-center gap-0.5">
        {editable && <Button variant={panel === "ai" ? "secondary" : "ghost"} size="sm" className="h-8" onClick={() => setPanel(p => p === "ai" ? null : "ai")}><Sparkles />AI 画图</Button>}
        <Button variant={panel === "notes" ? "secondary" : "ghost"} size="sm" className="h-8" onClick={() => setPanel(p => p === "notes" ? null : "notes")}><BookOpen />关联笔记{links.length > 0 && <span className="text-xs text-muted-foreground">{links.length}</span>}</Button>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-8" aria-label="导出"><Download /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void exportAs("png")}>图片（PNG）</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void exportAs("svg")}>矢量图（SVG）</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void exportAs("xml")}>draw.io 文件（.drawio）</DropdownMenuItem>
          </DropdownMenuContent></DropdownMenu>
        {tool("全屏", <Maximize />, () => void toggleFullscreen())}
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-8" aria-label="更多操作"><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">{menu}</DropdownMenuContent></DropdownMenu>
      </div>
    </div>
    <div className="relative flex min-h-0 flex-1">
      <div className="relative min-w-0 flex-1">
        {drawioUrl ? <iframe ref={frame} src={src} title="draw.io 画板编辑器" className="absolute inset-0 size-full border-0 bg-background" referrerPolicy="no-referrer"
          allow="clipboard-read; clipboard-write" data-testid="drawio-frame" />
          : <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">这个站点没有启用画板编辑器（DRAWIO_URL=off）。画板内容还在，管理员启用后就能继续编辑。</div>}
        {drawioUrl && status !== "ready" && <div className="pointer-events-none absolute inset-0 grid place-items-center bg-background/80 text-sm text-muted-foreground">
          {status === "loading" ? "正在打开 draw.io 编辑器…" : "draw.io 编辑器没加载出来，请检查网络或 DRAWIO_URL 配置后刷新页面。"}</div>}
      </div>
      {panel === "ai" && editable && <AiChatPanel mapId={mapId} getXml={() => xml.current} applyXml={applyXml} onClose={() => setPanel(null)} ready={status === "ready"} />}
      {panel === "notes" && <NoteLinksPanel ids={links} editable={editable} onOpen={id => props.onOpenNote(id)} onAdd={() => setPicking(true)} onClose={() => setPanel(null)}
        onRemove={async id => { if (await confirm({ title: "取消关联这篇笔记？", description: "只是去掉关联，笔记本身不受影响。", confirmText: "取消关联" })) setNoteLinks(links.filter(x => x !== id)); }} />}
    </div>
    <NotePickerDialog open={picking} onOpenChange={setPicking} workspaceId={workspaceId} description="关联后，这篇笔记的右侧栏「思维导图」里会列出这张画板。"
      onPick={note => {
        if (links.includes(note.id.toLowerCase())) { toast.error("已经关联过了", `「${note.title || "未命名"}」`); return; }
        setNoteLinks([...links, note.id.toLowerCase()]);
        toast.success("已关联", `「${note.title || "未命名"}」`);
      }} />
  </div>;
});

function NoteLinksPanel({ ids, editable, onOpen, onAdd, onRemove, onClose }: {
  ids: string[]; editable: boolean; onOpen: (id: string) => void; onAdd: () => void; onRemove: (id: string) => void; onClose: () => void;
}) {
  const [titles, setTitles] = useState<Record<string, string | null>>({});
  useEffect(() => {
    let live = true;
    const missing = ids.filter(id => !(id in titles));
    if (!missing.length) return;
    void Promise.all(missing.map(id => api<{ title: string }>(`/api/v1/notes/${id}`).then(n => [id, n.title || "未命名"] as const).catch(() => [id, null] as const)))
      .then(rows => { if (live) setTitles(t => ({ ...t, ...Object.fromEntries(rows) })); });
    return () => { live = false; };
  }, [ids]);
  return <aside className="flex w-72 shrink-0 flex-col border-l border-border bg-background" aria-label="关联笔记">
    <div className="flex h-11 items-center justify-between border-b border-border px-3"><p className="text-sm font-semibold">关联笔记</p><Button size="icon" variant="ghost" className="size-7" aria-label="关闭" onClick={onClose}><X /></Button></div>
    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
      {!ids.length && <p className="px-2 py-6 text-center text-xs leading-5 text-muted-foreground">还没有关联笔记。关联后，在笔记的右侧栏里能直接跳到这张画板。</p>}
      {ids.map(id => <div key={id} className="group flex items-center gap-1 rounded-lg hover:bg-muted">
        <button type="button" className="min-w-0 flex-1 truncate px-2.5 py-2 text-left text-sm disabled:text-muted-foreground" disabled={titles[id] === null} onClick={() => onOpen(id)}>
          {id in titles ? titles[id] ?? "（没有权限或已删除）" : "正在读取…"}</button>
        {editable && <Button size="icon" variant="ghost" className="size-7 opacity-60 group-hover:opacity-100" aria-label="取消关联" onClick={() => onRemove(id)}><X /></Button>}
      </div>)}
    </div>
    {editable && <div className="border-t border-border p-2"><Button size="sm" variant="outline" className="w-full" onClick={onAdd}><BookOpen />关联一篇笔记</Button></div>}
  </aside>;
}

const SUGGESTIONS = ["画一个用户注册登录的流程图，包含邮箱验证和失败分支", "画一张三层 Web 应用架构图：前端、API、数据库和缓存", "把现在的图改成从左到右排列，并统一配色"];

function AiChatPanel({ mapId, getXml, applyXml, onClose, ready }: { mapId: string; getXml: () => string; applyXml: (xml: string) => void; onClose: () => void; ready: boolean }) {
  const toast = useToast();
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const undo = useRef<string[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [msgs, busy]);
  const send = async (content: string) => {
    const c = content.trim();
    if (!c || busy) return;
    if (!ready) { toast.error("编辑器还没准备好", "等画板加载完再试。"); return; }
    const next = [...msgs, { role: "user" as const, content: c }];
    setMsgs(next);
    setText("");
    setBusy(true);
    try {
      const before = getXml();
      const d = await api<{ xml: string; reply: string }>(`/api/v1/mindmaps/${mapId}/ai/drawio`, { method: "POST", body: JSON.stringify({ messages: next.slice(-10), xml: before.length <= 400_000 ? before : "" }) });
      undo.current.push(before);
      setUndoCount(undo.current.length);
      applyXml(d.xml);
      setMsgs(m => [...m, { role: "assistant", content: d.reply || "已按要求更新画板。" }]);
    } catch (e) {
      const code = (e as { code?: string }).code;
      toast.error("AI 没能画出来", code === "AI_NOT_CONFIGURED" ? "还没有可用的 AI，可以在「AI 与自动化」里设置。" : (e as Error).message);
      setMsgs(m => m.slice(0, -1));
      setText(c);
    } finally { setBusy(false); }
  };
  return <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-background" aria-label="AI 画图">
    <div className="flex h-11 items-center justify-between border-b border-border px-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold"><Sparkles className="size-4" />AI 画图</p>
      <div className="flex items-center gap-0.5">
        <Tooltip content="撤销上一次 AI 修改"><Button size="icon" variant="ghost" className="size-7" aria-label="撤销上一次 AI 修改" disabled={!undoCount || busy} onClick={() => {
          const prev = undo.current.pop();
          setUndoCount(undo.current.length);
          if (prev !== undefined) { applyXml(prev); toast.success("已撤销 AI 修改"); }
        }}><Undo2 /></Button></Tooltip>
        <Button size="icon" variant="ghost" className="size-7" aria-label="关闭" onClick={onClose}><X /></Button>
      </div>
    </div>
    <div ref={list} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
      {!msgs.length && <div className="space-y-2">
        <p className="text-xs leading-5 text-muted-foreground">用一句话描述想要的图，或者让 AI 改现在这张（它能看到当前画板）。每次修改都能撤销，也会进版本历史。</p>
        {SUGGESTIONS.map(s => <button key={s} type="button" className="block w-full rounded-lg border border-border px-2.5 py-2 text-left text-xs leading-5 hover:bg-muted" onClick={() => void send(s)}>{s}</button>)}
      </div>}
      {msgs.map((m, i) => <div key={i} className={cn("max-w-[92%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-6", m.role === "user" ? "ml-auto bg-primary text-primary-foreground" : "bg-muted")}>{m.content}</div>)}
      {busy && <div className="w-fit rounded-xl bg-muted px-3 py-2 text-sm text-muted-foreground">AI 正在画…（复杂的图可能要一两分钟）</div>}
    </div>
    <form className="border-t border-border p-2" onSubmit={e => { e.preventDefault(); void send(text); }}>
      <Textarea rows={3} value={text} maxLength={4000} placeholder="比如：加一个支付失败后重试的分支" className="min-h-0 resize-none"
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(text); } }} onChange={e => setText(e.target.value)} />
      <div className="mt-1.5 flex items-center justify-between"><span className="text-[11px] text-muted-foreground">Enter 发送 · Shift + Enter 换行</span>
        <Button size="sm" type="submit" disabled={busy || !text.trim()}><Send />发送</Button></div>
    </form>
  </aside>;
}
