import { useMemo, useState } from "react";
import { Download, GripVertical, Lock, Notebook, Pencil, Trash2, Upload } from "lucide-react";
import { moveNoteId, sortNotes, type NoteSortMode } from "@kb/shared";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from "./ui/context-menu";

export type NotebookItem = {
  id: string;
  title: string;
  visibility?: "open" | "private" | "restricted";
  createdBy?: string;
  /** 自定义顺序。服务端给的是整数排名，前端只负责比大小。 */
  sortKey?: number;
  createdAt?: string;
};

/**
 * 侧栏的笔记本列表。排序规则复用笔记那一套（`sortNotes`）——
 * 「创建时间 / 名称 / 自定义」三档对两种列表是同一个心智，不该各写一套。
 *
 * 自定义模式下才可拖。拖动改的是**整个工作区**的侧栏顺序，所以只给管理员，
 * 和「谁能建、谁能删笔记本」同一条线。
 */
export function NotebookList({
  notebooks,
  activeId,
  mode,
  canReorder,
  canDelete,
  canManage,
  onPick,
  onReorder,
  onRename,
  onAccess,
  onImport,
  onExport,
  onDelete,
}: {
  notebooks: NotebookItem[];
  activeId?: string;
  mode: NoteSortMode;
  canReorder: boolean;
  canDelete: boolean;
  canManage: (nb: NotebookItem) => boolean;
  onPick: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onRename: (nb: NotebookItem) => void;
  onAccess: (nb: NotebookItem) => void;
  onImport: (nb: NotebookItem) => void;
  onExport: (nb: NotebookItem) => void;
  onDelete: (nb: NotebookItem) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const visible = useMemo(() => sortNotes(notebooks, mode), [notebooks, mode]);
  const dragging = mode === "custom" && canReorder && visible.length > 1;

  function dropOn(targetId: string) {
    if (!dragId) return;
    const next = moveNoteId(visible.map(n => n.id), dragId, targetId);
    setDragId(null);
    setOverId(null);
    if (next) onReorder(next);
  }

  return (
    <div className="space-y-1">
      {visible.map(n => (
        <ContextMenu key={n.id}>
          <ContextMenuTrigger asChild>
            <div
              draggable={dragging}
              onDragStart={e => {
                if (!dragging) return;
                setDragId(n.id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", n.id);
              }}
              onDragOver={e => {
                if (!dragging || !dragId || dragId === n.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOverId(n.id);
              }}
              onDrop={e => { e.preventDefault(); dropOn(n.id); }}
              onDragEnd={() => { setDragId(null); setOverId(null); }}
              className={cn(
                "group flex h-9 items-center rounded-lg transition",
                n.id === activeId ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                overId === n.id && dragId !== n.id && "ring-1 ring-foreground/25",
                dragId === n.id && "opacity-50",
              )}
            >
              <button onClick={() => onPick(n.id)} className="flex h-9 min-w-0 flex-1 items-center gap-2.5 px-2.5 text-left text-sm">
                {dragging
                  ? <GripVertical className="size-4 shrink-0 cursor-grab" />
                  : <Notebook className="size-4 shrink-0" />}
                <span className="sidebar-copy truncate">{n.title}</span>
              </button>
              {canDelete && (
                <Tooltip content="删除笔记本">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`删除笔记本 ${n.title}`}
                    className={cn(
                      "mr-0.5 size-7 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                      n.id === activeId ? "text-background hover:bg-background/15 hover:text-background" : "hover:text-destructive",
                    )}
                    onClick={() => onDelete(n)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </Tooltip>
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuLabel>{n.title}</ContextMenuLabel>
            <ContextMenuItem disabled={!canManage(n)} onSelect={() => onRename(n)}><Pencil />重命名</ContextMenuItem>
            <ContextMenuItem disabled={!canManage(n)} onSelect={() => onAccess(n)}><Lock />访问权限</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onImport(n)}><Upload />导入 Markdown 或 zip</ContextMenuItem>
            <ContextMenuItem onSelect={() => onExport(n)}><Download />导出这个笔记本</ContextMenuItem>
            {canDelete && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem className="text-destructive" onSelect={() => onDelete(n)}><Trash2 />删除笔记本</ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
      ))}
      {dragging && <p className="px-2.5 pt-1 text-[11px] text-muted-foreground">拖动笔记本调整顺序</p>}
    </div>
  );
}
