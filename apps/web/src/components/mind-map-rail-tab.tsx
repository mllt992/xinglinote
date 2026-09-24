import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ListTree, Network, Plus, Sparkles } from "lucide-react";
import { api } from "../api";
import { mindMapPath } from "./mindmaps";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { useToast } from "./ui/toast";
import type { RailNote } from "./note-rail";

type Ref = { id: string; title: string; updatedAt: string; nodeId: string; workspaceId: string };

/** 笔记右侧栏「思维导图」：哪些导图引用了这篇，以及从这篇一键生成。 */
export function MindMapRailTab({ note, workspaceId }: { note: RailNote; workspaceId?: string }) {
  const nav = useNavigate();
  const toast = useToast();
  const [refs, setRefs] = useState<Ref[] | null>(null);
  const [busy, setBusy] = useState<"" | "outline" | "ai">("");

  useEffect(() => {
    let live = true;
    setRefs(null);
    api<{ mindMaps: Ref[] }>(`/api/v1/notes/${note.id}/mindmaps`)
      .then(d => { if (live) setRefs(d.mindMaps); })
      .catch(e => { if (live) { setRefs([]); toast.error("没能读取关联的思维导图", (e as Error).message); } });
    return () => { live = false; };
  }, [note.id, toast]);

  async function generate(mode: "outline" | "ai") {
    setBusy(mode);
    try {
      const d = await api<{ mindMap: { id: string }; workspaceId: string }>(`/api/v1/notes/${note.id}/mindmaps`, { method: "POST", body: JSON.stringify({ mode }) });
      toast.success("已生成思维导图", "放在这篇笔记所在的笔记本里，根节点关联回这篇笔记。");
      nav(mindMapPath(d.workspaceId, d.mindMap.id));
    } catch (e) {
      const code = (e as { code?: string }).code;
      toast.error("生成失败", code === "AI_NOT_CONFIGURED" ? "这个工作区还没配置 AI，可以先用「按标题结构生成」。" : (e as Error).message);
    } finally { setBusy(""); }
  }

  return <ScrollArea className="min-h-0 flex-1">
    <div className="space-y-3 p-3">
      {note.canEdit && <div className="rounded-xl border border-border p-3">
        <p className="text-sm font-medium">从这篇笔记生成</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">按标题层级（没有标题就按列表缩进）搭成导图；配置了 AI 的话，也可以让 AI 先提炼要点。</p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void generate("outline")}><ListTree />{busy === "outline" ? "正在生成…" : "按标题结构生成"}</Button>
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void generate("ai")}><Sparkles />{busy === "ai" ? "AI 正在提炼…" : "用 AI 提炼"}</Button>
        </div>
      </div>}
      <p className="px-1 text-[11px] text-muted-foreground">{refs ? `${refs.length} 张思维导图关联了这篇笔记` : "正在读取…"}</p>
      {refs && !refs.length && <div className="px-1 py-6 text-center">
        <Network className="mx-auto size-6 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">还没有导图关联这篇笔记</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">在思维导图里选中节点、点「关联笔记」选这篇，就会出现在这里。</p>
        {workspaceId && <Button className="mt-3" size="sm" variant="ghost" onClick={() => nav(mindMapPath(workspaceId))}><Plus />去思维导图</Button>}
      </div>}
      {refs?.map(m => <Link key={m.id} to={mindMapPath(m.workspaceId, m.id, m.nodeId)} className="flex items-center gap-2.5 rounded-xl border border-border p-3 hover:bg-muted">
        <Network className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{m.title}</span>
          <span className="block text-[11px] text-muted-foreground">{new Date(m.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 更新</span></span>
      </Link>)}
    </div>
  </ScrollArea>;
}
