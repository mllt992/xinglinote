import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Archive, FileText, Folder, Notebook, RotateCcw, Trash2 } from "lucide-react";
import { api } from "../api";
import { EmptyState, Row, SectionCard, SettingsShell } from "./settings-shell";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useConfirm } from "./ui/confirm";
import { useToast } from "./ui/toast";

type Kind = "note" | "folder" | "notebook";
type Item = { id: string; title: string; path: string; trashedAt: string; trashedByName: string; purgeAt: string | null };
type TrashData = { notes: Item[]; folders: Item[]; notebooks: Item[] };

const GROUPS: Array<{ kind: Kind; label: string; icon: typeof FileText; key: keyof TrashData }> = [
  { kind: "note", label: "笔记", icon: FileText, key: "notes" },
  { kind: "folder", label: "目录", icon: Folder, key: "folders" },
  { kind: "notebook", label: "笔记本", icon: Notebook, key: "notebooks" },
];

const daysLeft = (purgeAt: string | null) => purgeAt ? Math.max(0, Math.ceil((new Date(purgeAt).getTime() - Date.now()) / 86400000)) : null;

/**
 * 回收站。原来套的是只有一个「返回工作区」的 PageShell，现在和工作区设置同一个壳、同一套卡片。
 * 「还剩几天」以前混在一长串灰字里，最该看见的信息反而最不显眼；现在提出来做徽章，≤3 天转成警示色。
 */
export function TrashPage() {
  const { wsId = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const askConfirm = useConfirm();
  const [data, setData] = useState<TrashData>({ notes: [], folders: [], notebooks: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => { setData(await api<TrashData>(`/api/v1/workspaces/${wsId}/trash`)); }, [wsId]);
  const reload = useCallback(() => {
    setLoading(true);
    load().then(() => setError("")).catch(e => setError((e as Error).message)).finally(() => setLoading(false));
  }, [load]);
  useEffect(() => { reload(); }, [reload]);

  const total = data.notes.length + data.folders.length + data.notebooks.length;

  async function restore(kind: Kind, item: Item) {
    try {
      const r = await api<{ renamed?: boolean; movedToRoot?: boolean; title?: string }>(`/api/v1/trash/${kind}/${item.id}/restore`, { method: "POST" });
      toast.success("已恢复", r.renamed ? `原位置已有同名内容，改名为《${r.title}》。`
        : r.movedToRoot ? "原目录还在回收站里，已放到笔记本根目录。" : undefined);
      void load();
    } catch (e) { toast.error("恢复失败", (e as Error).message); }
  }

  async function purge(kind: Kind, item: Item) {
    const yes = await askConfirm({
      title: `立即销毁《${item.title}》？`,
      description: "连同附件、版本历史和评论一起物理删除，不进回收站也不可恢复。",
      confirmText: "永久销毁", destructive: true,
    });
    if (!yes) return;
    try { await api(`/api/v1/trash/${kind}/${item.id}`, { method: "DELETE" }); toast.success(`已彻底销毁《${item.title}》`); void load(); }
    catch (e) { toast.error("销毁失败", (e as Error).message); }
  }

  return <SettingsShell wsId={wsId} current="trash" counts={{ trash: total }} loading={loading} error={error} onRetry={reload}>
    {total === 0
      ? <SectionCard title="回收站" desc="删除的笔记、目录和笔记本会先到这里。">
        <EmptyState icon={<Archive className="size-5" />} title="回收站是空的" text="30 天内删掉的东西都能在这里找回来。"
          action={<Button variant="outline" onClick={() => nav(`/w/${wsId}`)}>回到笔记</Button>} />
      </SectionCard>
      : <div className="space-y-4">
        {GROUPS.map(g => {
          const items = data[g.key];
          if (!items.length) return null;
          const Icon = g.icon;
          return <SectionCard key={g.kind} icon={<Icon className="size-4" />} title={g.label}
            desc={`${items.length} 项${g.kind === "note" ? "" : "；恢复时会一并恢复同一删除批次的子内容"}`}>
            {items.map((n, i) => {
              const left = daysLeft(n.purgeAt);
              return <Row key={n.id} first={i === 0}
                icon={<Trash2 className="size-4" />}
                title={n.title}
                desc={`${n.path} · ${n.trashedByName} 删除于 ${new Date(n.trashedAt).toLocaleString()}`}
                actions={<>
                  {left !== null && <Badge className={left <= 3 ? "border-destructive/40 text-destructive" : undefined}>{left} 天后销毁</Badge>}
                  <Button variant="outline" size="sm" onClick={() => void restore(g.kind, n)}><RotateCcw />恢复</Button>
                  <Button variant="ghost" size="icon" className="text-destructive" aria-label={`立即销毁 ${n.title}`} onClick={() => void purge(g.kind, n)}><Trash2 /></Button>
                </>} />;
            })}
          </SectionCard>;
        })}
      </div>}
  </SettingsShell>;
}
