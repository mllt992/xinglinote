import { cn } from "../lib/utils";

export type PublicFolder = { id: string; title: string; parentId: string | null };
export type PublicNoteItem = { id: string; title: string; folderId: string | null };

/** 目录 / 整本分享左侧只读树：目录分享从被分享的那一层往下，整本从本根开始。 */
export function PublicShareTree({
  kind, folders, notes, activeId, onPick,
}: {
  kind: "folder" | "notebook";
  folders: PublicFolder[];
  notes: PublicNoteItem[];
  activeId?: string | null;
  onPick: (id: string) => void;
}) {
  const ids = new Set(folders.map(f => f.id));
  const root = folders.find(f => !f.parentId || !ids.has(f.parentId));
  const folderShareRoot = kind === "folder" ? (root?.id ?? null) : null;

  function Branch({ parentId, depth }: { parentId: string | null; depth: number }) {
    const dirs = folders.filter(f => (f.parentId ?? null) === parentId).sort((a, b) => a.title.localeCompare(b.title, "zh"));
    const items = notes.filter(n => (n.folderId ?? null) === parentId).sort((a, b) => a.title.localeCompare(b.title, "zh"));
    return <>
      {dirs.map(f => <div key={f.id}>
        <p className="mb-1 mt-2 truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground" style={{ paddingLeft: 12 + depth * 12 }}>{f.title}</p>
        <Branch parentId={f.id} depth={depth + 1} />
      </div>)}
      {items.map(n => <button key={n.id} type="button" onClick={() => onPick(n.id)}
        className={cn("mb-1 w-full rounded-lg py-2.5 pr-3 text-left text-sm", n.id === activeId ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
        style={{ paddingLeft: 12 + depth * 12 }}>{n.title}</button>)}
    </>;
  }

  return <Branch parentId={folderShareRoot} depth={0} />;
}
