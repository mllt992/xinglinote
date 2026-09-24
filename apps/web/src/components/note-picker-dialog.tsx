import { useEffect, useRef, useState } from "react";
import { FileText, Search } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { useToast } from "./ui/toast";

export type PickedNote = { id: string; title: string; workspaceId: string; notebookId: string };

/** 选一篇笔记：空查询给最近打开的，输入后按标题搜本工作区。 */
export function NotePickerDialog({ open, onOpenChange, workspaceId, title = "关联笔记", description, onPick }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  title?: string;
  description?: string;
  onPick: (note: PickedNote) => void;
}) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<PickedNote[]>([]);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const toast = useToast();

  useEffect(() => { if (open) { setQ(""); setActive(0); } }, [open]);
  useEffect(() => {
    if (!open) return;
    const my = ++seq.current;
    const query = q.trim();
    setBusy(true);
    const timer = window.setTimeout(() => {
      const load = query
        ? api<{ hits: PickedNote[] }>(`/api/v1/search?q=${encodeURIComponent(query)}&workspaceId=${workspaceId}&titleOnly=1&limit=20`).then(d => d.hits)
        : api<{ notes: PickedNote[] }>("/api/v1/me/recent").then(d => d.notes.filter(n => n.workspaceId === workspaceId));
      load.then(list => { if (my === seq.current) { setItems(list); setActive(0); } })
        .catch(e => { if (my === seq.current) { setItems([]); toast.error("没能读取笔记列表", (e as Error).message); } })
        .finally(() => { if (my === seq.current) setBusy(false); });
    }, query ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [q, open, workspaceId, toast]);

  const pick = (note: PickedNote | undefined) => { if (note) { onPick(note); onOpenChange(false); } };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description ?? "选一篇本工作区的笔记，点节点上的链接图标就能跳过去。"}</DialogDescription>
      </DialogHeader>
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
        <Input autoFocus className="pl-9" value={q} placeholder="按标题搜索笔记"
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive(i => Math.min(items.length - 1, i + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); pick(items[active]); }
          }} />
      </label>
      <div className="max-h-72 min-h-24 overflow-y-auto">
        {!busy && !items.length && <p className="py-8 text-center text-sm text-muted-foreground">{q.trim() ? "没有找到标题匹配的笔记" : "最近没有打开过这个工作区的笔记，输入标题搜索吧"}</p>}
        {!q.trim() && items.length > 0 && <p className="px-1 pb-1 text-[11px] text-muted-foreground">最近打开</p>}
        {items.map((note, i) => <button key={note.id} type="button" onClick={() => pick(note)} onMouseEnter={() => setActive(i)}
          className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm", i === active ? "bg-muted" : "hover:bg-muted/60")}>
          <FileText className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{note.title || "未命名"}</span>
        </button>)}
      </div>
    </DialogContent>
  </Dialog>;
}
