import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import {
  ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, FilePlus2, FileText, Folder, FolderInput, FolderOpen, FolderPlus,
  GripVertical, Notebook, Pencil, Share2, Trash2,
} from "lucide-react";
import {
  buildNoteTree, flattenFolders, folderAncestorIds, folderDropZone, folderMoveExceedsDepth, folderTitlePath, isFolderDescendant,
  moveNoteId, placeId, sortNotes, type FolderDropZone, type NoteSortMode, type NoteTreeNode, type TreeFolder,
} from "@kb/shared";
import { api } from "../api";
import { copyPlainText } from "../lib/clipboard";
import { loadOpenFolders, saveOpenFolders } from "../lib/note-sort-pref";
import { cn } from "../lib/utils";
import type { TreeNote } from "./note-list";
import { Button } from "./ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from "./ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { FormError } from "./ui/form-error";
import { Tooltip } from "./ui/tooltip";
import { useToast } from "./ui/toast";

export const NOTE_MIME = "application/x-kb-note";
const FOLDER_MIME = "application/x-kb-folder";

export function MoveToFolderDialog({
  open,
  noteTitle,
  currentFolderId,
  folders,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  noteTitle: string;
  currentFolderId: string | null;
  folders: TreeFolder[];
  onOpenChange: (v: boolean) => void;
  onPick: (folderId: string | null) => void;
}) {
  const rows = useMemo(() => flattenFolders(folders, "name"), [folders]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>移动《{noteTitle || "未命名笔记"}》</DialogTitle>
          <DialogDescription>选一个目录，笔记会出现在它下面。也可以放回这本笔记本的根上。</DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-0.5 overflow-y-auto">
          <button
            type="button"
            disabled={currentFolderId === null}
            onClick={() => { onPick(null); onOpenChange(false); }}
            className={cn(
              "flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm",
              currentFolderId === null ? "bg-muted text-muted-foreground" : "hover:bg-muted",
            )}
          >
            <Folder className="size-4 shrink-0" />笔记本根目录
          </button>
          {rows.map(({ folder, depth }) => (
            <button
              key={folder.id}
              type="button"
              disabled={folder.id === currentFolderId}
              onClick={() => { onPick(folder.id); onOpenChange(false); }}
              style={{ paddingLeft: 10 + depth * 16 }}
              className={cn(
                "flex h-9 w-full items-center gap-2 rounded-lg pr-2.5 text-left text-sm",
                folder.id === currentFolderId ? "bg-muted text-muted-foreground" : "hover:bg-muted",
              )}
            >
              <Folder className="size-4 shrink-0" />
              <span className="truncate">{folder.title}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function MoveToNotebookDialog({
  open,
  noteTitle,
  currentNotebookId,
  notebooks,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  noteTitle: string;
  currentNotebookId?: string;
  notebooks: Array<{ id: string; title: string }>;
  onOpenChange: (v: boolean) => void;
  onPick: (notebookId: string, folderId: string | null) => void;
}) {
  const options = notebooks.filter((n) => n.id !== currentNotebookId);
  const firstId = options[0]?.id ?? "";
  const [target, setTarget] = useState("");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [folders, setFolders] = useState<TreeFolder[]>([]);
  const [canEdit, setCanEdit] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const rows = useMemo(() => flattenFolders(folders, "name"), [folders]);

  useEffect(() => {
    if (!open) return;
    setTarget(firstId);
    setFolderId(null);
    setFolders([]);
    setCanEdit(true);
    setErr("");
  }, [open, currentNotebookId, firstId]);

  useEffect(() => {
    if (!open || !target) { setFolders([]); setCanEdit(true); return; }
    let cancelled = false;
    setLoading(true);
    setErr("");
    api<{ folders: TreeFolder[]; canEdit?: boolean }>(`/api/v1/notebooks/${target}/tree`)
      .then((d) => {
        if (cancelled) return;
        setFolders(d.folders);
        setCanEdit(!!d.canEdit);
        setFolderId(null);
        if (!d.canEdit) setErr("你不能编辑这个笔记本");
      })
      .catch((e) => { if (!cancelled) setErr((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, target]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>移动《{noteTitle || "未命名笔记"}》</DialogTitle>
          <DialogDescription>选一个你能编辑的笔记本。默认放到它的根上，也可以指定一个目录。</DialogDescription>
        </DialogHeader>
        {options.length === 0
          ? <p className="rounded-xl border p-4 text-sm text-muted-foreground">这个工作区里没有其他笔记本。先新建一本，才能把笔记搬过去。</p>
          : <>
            <div className="grid gap-1.5">
              {options.map((n) => (
                <label key={n.id} className={cn("flex cursor-pointer items-center gap-3 rounded-xl border p-3", target === n.id ? "border-primary bg-primary/5" : "border-border")}>
                  <input type="radio" name="move-note-notebook" checked={target === n.id} onChange={() => setTarget(n.id)} />
                  <Notebook className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{n.title}</span>
                </label>
              ))}
            </div>
            {target && (
              <div className="max-h-52 space-y-0.5 overflow-y-auto rounded-xl border p-1.5">
                <button
                  type="button"
                  disabled={loading || !canEdit}
                  onClick={() => setFolderId(null)}
                  className={cn(
                    "flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm",
                    folderId === null ? "bg-muted" : "hover:bg-muted",
                    (loading || !canEdit) && "text-muted-foreground",
                  )}
                >
                  <Folder className="size-4 shrink-0" />笔记本根目录
                </button>
                {rows.map(({ folder, depth }) => (
                  <button
                    key={folder.id}
                    type="button"
                    disabled={loading || !canEdit}
                    onClick={() => setFolderId(folder.id)}
                    style={{ paddingLeft: 10 + depth * 16 }}
                    className={cn(
                      "flex h-9 w-full items-center gap-2 rounded-lg pr-2.5 text-left text-sm",
                      folderId === folder.id ? "bg-muted" : "hover:bg-muted",
                      (loading || !canEdit) && "text-muted-foreground",
                    )}
                  >
                    <Folder className="size-4 shrink-0" />
                    <span className="truncate">{folder.title}</span>
                  </button>
                ))}
              </div>
            )}
          </>}
        <FormError>{err}</FormError>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            disabled={!target || loading || !canEdit}
            onClick={() => { onPick(target, folderId); onOpenChange(false); }}
          >移动</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function NoteTree({
  folders,
  notes,
  noteId,
  wsId,
  notebookId,
  activeFolder,
  mode,
  canEdit,
  onSelectFolder,
  onReorder,
  onReorderFolders,
  onMoveNote,
  onMoveToNotebook,
  onMoveFolder,
  onPlaceFolder,
  onRenameNote,
  onDeleteNote,
  onRenameFolder,
  onDeleteFolder,
  onCreateNote,
  onCreateFolder,
  onShareFolder,
  onOpenNote,
}: {
  folders: TreeFolder[];
  notes: TreeNote[];
  noteId?: string;
  wsId?: string;
  notebookId?: string;
  activeFolder: string | null;
  mode: NoteSortMode;
  canEdit: boolean;
  onSelectFolder: (id: string | null) => void;
  onReorder: (noteIds: string[]) => void;
  onReorderFolders: (folderIds: string[]) => void;
  onMoveNote: (noteId: string, folderId: string | null) => void;
  onMoveToNotebook?: (note: TreeNote) => void;
  onMoveFolder: (folderId: string, parentId: string | null) => void;
  onPlaceFolder: (folderId: string, parentId: string | null, siblingIds: string[]) => void;
  onRenameNote?: (note: TreeNote) => void;
  onDeleteNote?: (note: TreeNote) => void;
  onRenameFolder?: (folder: TreeFolder) => void;
  onDeleteFolder?: (folder: TreeFolder) => void;
  onCreateNote: (folderId: string | null) => void;
  onCreateFolder: (parentId: string | null) => void;
  onShareFolder: (folder: TreeFolder) => void;
  onOpenNote?: (note: TreeNote) => void;
}) {
  const tree = useMemo(() => buildNoteTree(folders, notes, mode), [folders, notes, mode]);
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set(notebookId ? loadOpenFolders(notebookId) : []));
  const [dragNoteId, setDragNoteId] = useState<string | null>(null);
  const [dragFolderId, setDragFolderId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [moving, setMoving] = useState<TreeNote | null>(null);

  useEffect(() => {
    setOpenIds(new Set(notebookId ? loadOpenFolders(notebookId) : []));
  }, [notebookId]);

  useEffect(() => {
    if (!noteId) return;
    const note = notes.find((n) => n.id === noteId);
    if (!note?.folderId) return;
    const extra = folderAncestorIds(folders, note.folderId);
    setOpenIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of extra) {
        if (!next.has(id)) { next.add(id); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [noteId, notes, folders]);

  useEffect(() => {
    if (notebookId) saveOpenFolders(notebookId, [...openIds]);
  }, [notebookId, openIds]);

  const prevNotes = useRef(notes);
  const prevFolders = useRef(folders);
  useEffect(() => {
    const beforeNotes = new Map(prevNotes.current.map((n) => [n.id, n.folderId ?? null]));
    const beforeFolders = new Set(prevFolders.current.map((f) => f.id));
    prevNotes.current = notes;
    prevFolders.current = folders;
    const reveal: string[] = [];
    for (const n of notes) {
      if ((n.folderId ?? null) !== (beforeNotes.get(n.id) ?? null) && n.folderId) reveal.push(n.folderId);
    }
    for (const f of folders) {
      if (!beforeFolders.has(f.id) && f.parentId) reveal.push(f.parentId);
    }
    if (!reveal.length) return;
    setOpenIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of reveal) {
        for (const ancestor of folderAncestorIds(folders, id)) {
          if (!next.has(ancestor)) { next.add(ancestor); changed = true; }
        }
      }
      return changed ? next : prev;
    });
  }, [notes, folders]);

  function toggle(id: string) {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function expand(id: string) {
    setOpenIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  function readDrag(e: DragEvent) {
    const note = e.dataTransfer.getData(NOTE_MIME) || (dragNoteId ?? "");
    const folder = e.dataTransfer.getData(FOLDER_MIME) || (dragFolderId ?? "");
    return { note: note || null, folder: folder || null };
  }

  function dropOnRoot(e: DragEvent) {
    e.preventDefault();
    const drag = readDrag(e);
    setOverKey(null);
    setDragNoteId(null);
    setDragFolderId(null);
    if (drag.note) {
      const src = notes.find((n) => n.id === drag.note);
      if (src && src.folderId) onMoveNote(src.id, null);
      return;
    }
    if (drag.folder) {
      const src = folders.find((f) => f.id === drag.folder);
      if (src?.parentId && !folderMoveExceedsDepth(folders, src.id, null)) onMoveFolder(src.id, null);
    }
  }

  function siblingFolderIds(parentId: string | null): string[] {
    const folderMode = mode === "created" ? "custom" : mode;
    return sortNotes(
      folders
        .filter((f) => (f.parentId ?? null) === parentId)
        .map((f) => ({ id: f.id, title: f.title, sortKey: f.sortKey ?? 0 })),
      folderMode,
    ).map((f) => f.id);
  }

  function zoneFromEvent(e: DragEvent): FolderDropZone {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    return folderDropZone((e.clientY - rect.top) / (rect.height || 1));
  }

  function dropOnFolder(e: DragEvent, folderId: string) {
    e.preventDefault();
    e.stopPropagation();
    const drag = readDrag(e);
    const zone = drag.note || mode === "name" ? "into" : zoneFromEvent(e);
    setOverKey(null);
    setDragNoteId(null);
    setDragFolderId(null);
    if (drag.note) {
      const src = notes.find((n) => n.id === drag.note);
      if (src && src.folderId !== folderId) onMoveNote(src.id, folderId);
      expand(folderId);
      return;
    }
    if (!drag.folder || drag.folder === folderId) return;
    if (zone === "into") {
      if (!isFolderDescendant(folders, drag.folder, folderId) && !folderMoveExceedsDepth(folders, drag.folder, folderId)) {
        onMoveFolder(drag.folder, folderId);
        expand(folderId);
      }
      return;
    }
    const src = folders.find((f) => f.id === drag.folder);
    const target = folders.find((f) => f.id === folderId);
    if (!src || !target) return;
    const newParent = target.parentId ?? null;
    if (isFolderDescendant(folders, src.id, target.id)) return;
    if (folderMoveExceedsDepth(folders, src.id, newParent)) return;
    const next = placeId(siblingFolderIds(newParent), src.id, target.id, zone);
    if (!next) return;
    onPlaceFolder(src.id, newParent, next);
  }

  function shiftFolder(folderId: string, dir: -1 | 1) {
    const src = folders.find((f) => f.id === folderId);
    if (!src) return;
    const ids = siblingFolderIds(src.parentId ?? null);
    const i = ids.indexOf(folderId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const next = ids.slice();
    const swap = next[i]!;
    next[i] = next[j]!;
    next[j] = swap;
    onReorderFolders(next);
  }

  function dropOnNote(e: DragEvent, target: TreeNote) {
    e.preventDefault();
    e.stopPropagation();
    const drag = readDrag(e);
    setOverKey(null);
    setDragNoteId(null);
    setDragFolderId(null);
    if (!drag.note || drag.note === target.id) return;
    const src = notes.find((n) => n.id === drag.note);
    if (!src) return;
    if ((src.folderId ?? null) !== (target.folderId ?? null)) {
      onMoveNote(src.id, target.folderId);
      return;
    }
    if (mode !== "custom" || !canEdit) return;
    const siblings = sortNotes(notes.filter((n) => (n.folderId ?? null) === (target.folderId ?? null)), mode);
    const next = moveNoteId(siblings.map((n) => n.id), src.id, target.id);
    if (next) onReorder(next);
  }

  function allowDrop(e: DragEvent, key: string) {
    if (!canEdit || (!dragNoteId && !dragFolderId)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setOverKey(key);
  }

  const dragging = canEdit && (!!dragNoteId || !!dragFolderId);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={() => onSelectFolder(null)}
            onDragOver={(e) => allowDrop(e, "root")}
            onDrop={dropOnRoot}
            className={cn(
              "mb-1 flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-sm",
              activeFolder === null ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/70",
              overKey === "root" && dragging && "ring-1 ring-foreground/25",
            )}
          >
            <Folder className="size-4" />全部笔记
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={!canEdit} onSelect={() => onCreateNote(null)}><FilePlus2 />新建笔记</ContextMenuItem>
          <ContextMenuItem disabled={!canEdit} onSelect={() => onCreateFolder(null)}><FolderPlus />新建目录</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <div className="space-y-0.5">
        {tree.map((node) => (
          <TreeRow
            key={`${node.kind}:${node.id}`}
            node={node}
            depth={0}
            folders={folders}
            openIds={openIds}
            noteId={noteId}
            wsId={wsId}
            activeFolder={activeFolder}
            canEdit={canEdit}
            custom={mode === "custom"}
            folderOrder={mode !== "name"}
            dragNoteId={dragNoteId}
            dragFolderId={dragFolderId}
            overKey={overKey}
            onToggle={toggle}
            onSelectFolder={onSelectFolder}
            onDragNote={setDragNoteId}
            onDragFolder={setDragFolderId}
            onAllowDrop={allowDrop}
            onDropFolder={dropOnFolder}
            onDropNote={dropOnNote}
            onDragEnd={() => { setDragNoteId(null); setDragFolderId(null); setOverKey(null); }}
            onRenameNote={onRenameNote}
            onDeleteNote={onDeleteNote}
            onRenameFolder={onRenameFolder}
            onDeleteFolder={onDeleteFolder}
            onCreateNote={onCreateNote}
            onCreateFolder={(id) => { onSelectFolder(id); expand(id); onCreateFolder(id); }}
            onShareFolder={onShareFolder}
            onOpenNote={onOpenNote}
            onMoveNote={setMoving}
            onMoveToNotebook={onMoveToNotebook}
            onShiftFolder={shiftFolder}
          />
        ))}
      </div>

      {canEdit && (folders.length > 0 || notes.length > 1) && (
        <p className="mt-2 px-2.5 text-[11px] text-muted-foreground">
          {mode === "name"
            ? "拖笔记或文件夹到目录上即可移入"
            : mode === "custom"
              ? "拖笔记或文件夹调整同级顺序；拖到目录中间则移入"
              : "拖文件夹到边缘可调序，拖到中间则移入；拖笔记到目录上即可移入"}
        </p>
      )}

      <MoveToFolderDialog
        open={!!moving}
        noteTitle={moving?.title ?? ""}
        currentFolderId={moving?.folderId ?? null}
        folders={folders}
        onOpenChange={(v) => { if (!v) setMoving(null); }}
        onPick={(folderId) => { if (moving) onMoveNote(moving.id, folderId); }}
      />
    </>
  );
}

function TreeRow({
  node,
  depth,
  folders,
  openIds,
  noteId,
  wsId,
  activeFolder,
  canEdit,
  custom,
  folderOrder,
  dragNoteId,
  dragFolderId,
  overKey,
  onToggle,
  onSelectFolder,
  onDragNote,
  onDragFolder,
  onAllowDrop,
  onDropFolder,
  onDropNote,
  onDragEnd,
  onRenameNote,
  onDeleteNote,
  onRenameFolder,
  onDeleteFolder,
  onCreateNote,
  onCreateFolder,
  onShareFolder,
  onMoveNote,
  onMoveToNotebook,
  onShiftFolder,
  onOpenNote,
}: {
  node: NoteTreeNode;
  depth: number;
  folders: TreeFolder[];
  openIds: Set<string>;
  noteId?: string;
  wsId?: string;
  activeFolder: string | null;
  canEdit: boolean;
  custom: boolean;
  folderOrder: boolean;
  dragNoteId: string | null;
  dragFolderId: string | null;
  overKey: string | null;
  onToggle: (id: string) => void;
  onSelectFolder: (id: string) => void;
  onDragNote: (id: string | null) => void;
  onDragFolder: (id: string | null) => void;
  onAllowDrop: (e: DragEvent, key: string) => void;
  onDropFolder: (e: DragEvent, folderId: string) => void;
  onDropNote: (e: DragEvent, note: TreeNote) => void;
  onDragEnd: () => void;
  onRenameNote?: (note: TreeNote) => void;
  onDeleteNote?: (note: TreeNote) => void;
  onRenameFolder?: (folder: TreeFolder) => void;
  onDeleteFolder?: (folder: TreeFolder) => void;
  onCreateNote: (folderId: string | null) => void;
  onCreateFolder: (parentId: string) => void;
  onShareFolder: (folder: TreeFolder) => void;
  onMoveNote: (note: TreeNote) => void;
  onMoveToNotebook?: (note: TreeNote) => void;
  onShiftFolder: (folderId: string, dir: -1 | 1) => void;
  onOpenNote?: (note: TreeNote) => void;
}) {
  const toast = useToast();
  const pad = { paddingLeft: 8 + depth * 16 };

  async function copyFolderName(folder: TreeFolder) {
    const ok = await copyPlainText(folder.title);
    if (ok) toast.success("已复制文件夹名称", folder.title);
    else toast.error("复制失败", "浏览器拒绝写入剪贴板。");
  }

  async function copyFolderPath(folder: TreeFolder) {
    const path = folderTitlePath(folders, folder.id) || folder.title;
    const ok = await copyPlainText(path);
    if (ok) toast.success("已复制文件夹路径", path);
    else toast.error("复制失败", "浏览器拒绝写入剪贴板。");
  }

  if (node.kind === "folder") {
    const open = openIds.has(node.id);
    const overPrefix = `folder:${node.id}:`;
    const overZone = overKey?.startsWith(overPrefix) ? overKey.slice(overPrefix.length) : null;
    const dragging = dragFolderId === node.id;
    return (
      <div>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              draggable={canEdit}
              onDragStart={(e) => {
                if (!canEdit) return;
                onDragFolder(node.id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData(FOLDER_MIME, node.id);
                e.dataTransfer.setData("text/plain", node.id);
              }}
              onDragOver={(e) => {
                if (dragNoteId || !folderOrder) {
                  onAllowDrop(e, `folder:${node.id}:into`);
                  return;
                }
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const zone = folderDropZone((e.clientY - rect.top) / (rect.height || 1));
                onAllowDrop(e, `folder:${node.id}:${zone}`);
              }}
              onDrop={(e) => onDropFolder(e, node.id)}
              onDragEnd={onDragEnd}
              style={pad}
              className={cn(
                "group relative mb-0.5 flex h-8 items-center gap-0.5 rounded-lg pr-1 text-sm",
                activeFolder === node.id ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/70",
                overZone === "into" && "ring-1 ring-foreground/25",
                overZone === "before" && "before:absolute before:inset-x-2 before:-top-px before:h-0.5 before:rounded-full before:bg-foreground/50",
                overZone === "after" && "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-foreground/50",
                dragging && "opacity-50",
              )}
            >
              <button
                type="button"
                aria-label={open ? `折叠 ${node.folder.title}` : `展开 ${node.folder.title}`}
                aria-expanded={open}
                onClick={(e) => { e.stopPropagation(); onToggle(node.id); }}
                className="grid size-7 shrink-0 place-items-center rounded-md hover:bg-foreground/5"
              >
                {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => { onSelectFolder(node.id); onToggle(node.id); }}
                className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
              >
                {open ? <FolderOpen className="size-4 shrink-0" /> : <Folder className="size-4 shrink-0" />}
                <span className="truncate">{node.folder.title}</span>
              </button>
              <Tooltip content="复制名称">
                <Button variant="ghost" size="icon" className="size-7 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" aria-label="复制文件夹名称" onClick={() => void copyFolderName(node.folder)}>
                  <Copy className="size-3.5" />
                </Button>
              </Tooltip>
              <Tooltip content="分享此目录">
                <Button variant="ghost" size="icon" className="size-7 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" onClick={() => onShareFolder(node.folder)}>
                  <Share2 className="size-3.5" />
                </Button>
              </Tooltip>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuLabel>{node.folder.title}</ContextMenuLabel>
            <ContextMenuItem onSelect={() => void copyFolderName(node.folder)}><Copy />复制名称</ContextMenuItem>
            <ContextMenuItem onSelect={() => void copyFolderPath(node.folder)}><Copy />复制路径</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={!canEdit} onSelect={() => onCreateNote(node.id)}><FilePlus2 />在此新建笔记</ContextMenuItem>
            <ContextMenuItem disabled={!canEdit} onSelect={() => onCreateFolder(node.id)}><FolderPlus />新建子目录</ContextMenuItem>
            <ContextMenuItem disabled={!canEdit || !folderOrder} onSelect={() => onShiftFolder(node.id, -1)}><ArrowUp />上移</ContextMenuItem>
            <ContextMenuItem disabled={!canEdit || !folderOrder} onSelect={() => onShiftFolder(node.id, 1)}><ArrowDown />下移</ContextMenuItem>
            <ContextMenuItem disabled={!onRenameFolder} onSelect={() => onRenameFolder?.(node.folder)}><Pencil />重命名</ContextMenuItem>
            <ContextMenuItem onSelect={() => onShareFolder(node.folder)}><Share2 />分享此目录</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem className="text-destructive" disabled={!onDeleteFolder} onSelect={() => onDeleteFolder?.(node.folder)}><Trash2 />移到回收站</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {open && node.children.map((child) => (
          <TreeRow
            key={`${child.kind}:${child.id}`}
            node={child}
            depth={depth + 1}
            folders={folders}
            openIds={openIds}
            noteId={noteId}
            wsId={wsId}
            activeFolder={activeFolder}
            canEdit={canEdit}
            custom={custom}
            folderOrder={folderOrder}
            dragNoteId={dragNoteId}
            dragFolderId={dragFolderId}
            overKey={overKey}
            onToggle={onToggle}
            onSelectFolder={onSelectFolder}
            onDragNote={onDragNote}
            onDragFolder={onDragFolder}
            onAllowDrop={onAllowDrop}
            onDropFolder={onDropFolder}
            onDropNote={onDropNote}
            onDragEnd={onDragEnd}
            onRenameNote={onRenameNote}
            onDeleteNote={onDeleteNote}
            onRenameFolder={onRenameFolder}
            onDeleteFolder={onDeleteFolder}
            onCreateNote={onCreateNote}
            onCreateFolder={onCreateFolder}
            onShareFolder={onShareFolder}
            onMoveNote={onMoveNote}
            onMoveToNotebook={onMoveToNotebook}
            onShiftFolder={onShiftFolder}
            onOpenNote={onOpenNote}
          />
        ))}
      </div>
    );
  }

  const n = node.note;
  const active = n.id === noteId;
  const over = overKey === `note:${n.id}`;
  return (
    <div
      draggable={canEdit}
      onDragStart={(e) => {
        if (!canEdit) return;
        onDragNote(n.id);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(NOTE_MIME, n.id);
        e.dataTransfer.setData("text/plain", n.id);
      }}
      onDragOver={(e) => onAllowDrop(e, `note:${n.id}`)}
      onDrop={(e) => onDropNote(e, n)}
      onDragEnd={onDragEnd}
      style={pad}
      className={cn(over && "rounded-lg ring-1 ring-foreground/25")}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Link
            to={`/w/${wsId}/n/${n.id}`}
            draggable={false}
            onClick={() => onOpenNote?.(n)}
            className={cn(
              "group flex h-8 items-center gap-2 rounded-lg px-2 text-sm transition",
              active ? "bg-primary text-primary-foreground shadow-sm" : "hover:bg-muted",
              dragNoteId === n.id && "opacity-50",
            )}
          >
            {canEdit && custom
              ? <GripVertical className={cn("size-3.5 shrink-0 cursor-grab", active ? "text-primary-foreground/70" : "text-muted-foreground")} />
              : <FileText className={cn("size-3.5 shrink-0", active ? "text-primary-foreground/70" : "text-muted-foreground")} />}
            <span className="truncate leading-5">{n.title || "未命名"}</span>
          </Link>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>{n.title || "未命名笔记"}</ContextMenuLabel>
          <ContextMenuItem disabled={!onRenameNote} onSelect={() => onRenameNote?.(n)}><Pencil />重命名</ContextMenuItem>
          <ContextMenuItem disabled={!canEdit} onSelect={() => onMoveNote(n)}><FolderInput />移动到目录…</ContextMenuItem>
          {onMoveToNotebook && <ContextMenuItem disabled={!canEdit} onSelect={() => onMoveToNotebook(n)}><Notebook />移动到其他笔记本…</ContextMenuItem>}
          <ContextMenuSeparator />
          <ContextMenuItem className="text-destructive" disabled={!onDeleteNote} onSelect={() => onDeleteNote?.(n)}><Trash2 />移到回收站</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
