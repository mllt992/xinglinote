import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpDown, Check, FilePlus2, GripVertical, Pencil, Trash2 } from "lucide-react";
import { moveNoteId, NOTE_SORT_LABELS, NOTE_SORT_MODES, sortNotes, type NoteSortMode } from "@kb/shared";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from "./ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Tooltip } from "./ui/tooltip";

export type TreeNote = {
  id: string;
  title: string;
  folderId: string | null;
  createdAt?: string;
  sortKey?: number;
};

export function NoteSortMenu({ mode, onChange }: { mode: NoteSortMode; onChange: (mode: NoteSortMode) => void }) {
  return (
    <DropdownMenu>
      <Tooltip content={`排序：${NOTE_SORT_LABELS[mode]}`}>
        <span className="inline-flex">
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label="笔记排序">
              <ArrowUpDown />
            </Button>
          </DropdownMenuTrigger>
        </span>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-44">
        <p className="px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">笔记排序</p>
        {NOTE_SORT_MODES.map((item) => (
          <DropdownMenuItem key={item} onSelect={() => onChange(item)}>
            {NOTE_SORT_LABELS[item]}
            {mode === item && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function NoteList({
  notes,
  folderId,
  noteId,
  wsId,
  mode,
  canReorder,
  onReorder,
  onRename,
  onDelete,
}: {
  notes: TreeNote[];
  folderId: string | null;
  noteId?: string;
  wsId?: string;
  mode: NoteSortMode;
  canReorder: boolean;
  onReorder: (noteIds: string[]) => void;
  /** 只读时不传，右键菜单里的改名 / 删除会置灰。 */
  onRename?: (note: TreeNote) => void;
  onDelete?: (note: TreeNote) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const visible = useMemo(
    () => sortNotes(notes.filter((n) => folderId === null || n.folderId === folderId), mode),
    [notes, folderId, mode],
  );
  const dragging = mode === "custom" && canReorder;

  function dropOn(targetId: string) {
    if (!dragId) return;
    const next = moveNoteId(visible.map((n) => n.id), dragId, targetId);
    setDragId(null);
    setOverId(null);
    if (next) onReorder(next);
  }

  return (
    <>
      {dragging && visible.length > 1 && (
        <p className="mb-1.5 px-2.5 text-[11px] text-muted-foreground">拖动笔记调整顺序</p>
      )}
      <div className="space-y-0.5">
        {visible.map((n) => (
          <div
            key={n.id}
            draggable={dragging}
            onDragStart={(e) => {
              if (!dragging) return;
              setDragId(n.id);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", n.id);
            }}
            onDragOver={(e) => {
              if (!dragging || !dragId || dragId === n.id) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setOverId(n.id);
            }}
            onDrop={(e) => {
              e.preventDefault();
              dropOn(n.id);
            }}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            className={cn(overId === n.id && dragId !== n.id && "rounded-lg ring-1 ring-foreground/25")}
          >
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <Link
                  to={`/w/${wsId}/n/${n.id}`}
                  draggable={false}
                  className={cn(
                    "group flex min-h-10 items-start gap-2.5 rounded-lg px-2.5 py-2 text-sm transition",
                    n.id === noteId ? "bg-primary text-primary-foreground shadow-sm" : "hover:bg-muted",
                    dragId === n.id && "opacity-50",
                  )}
                >
                  {dragging
                    ? <GripVertical className={cn("mt-0.5 size-3.5 shrink-0 cursor-grab", n.id === noteId ? "text-primary-foreground/70" : "text-muted-foreground")} />
                    : <FilePlus2 className={cn("mt-0.5 size-3.5 shrink-0", n.id === noteId ? "text-primary-foreground/70" : "text-muted-foreground")} />}
                  <span className="line-clamp-2 leading-5">{n.title}</span>
                </Link>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuLabel>{n.title || "未命名笔记"}</ContextMenuLabel>
                <ContextMenuItem disabled={!onRename} onSelect={() => onRename?.(n)}><Pencil />重命名</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem className="text-destructive" disabled={!onDelete} onSelect={() => onDelete?.(n)}><Trash2 />移到回收站</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </div>
        ))}
      </div>
    </>
  );
}
