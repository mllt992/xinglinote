import { Columns2, GripVertical, LoaderCircle, X } from "lucide-react";
import { MarkdownView } from "../MarkdownView";
import { MAX_NOTE_PANES, NOTE_TAB_MIME, readDraggedNoteTab, type WorkbenchTab } from "../lib/note-workbench";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from "./ui/context-menu";
import { Tooltip } from "./ui/tooltip";

function dragId(event: React.DragEvent): string {
  return readDraggedNoteTab(event.dataTransfer);
}

export function NoteTabBar({ tabs, activeId, paneIds, onFocus, onClose, onCloseMany, onAddPane, onRemovePane, onReorder }: {
  tabs: WorkbenchTab[];
  activeId?: string;
  paneIds: string[];
  onFocus: (tab: WorkbenchTab) => void;
  onClose: (id: string) => void;
  onCloseMany: (ids: string[]) => void;
  onAddPane: (id: string) => void;
  onRemovePane: (id: string) => void;
  onReorder: (sourceId: string, targetId: string) => void;
}) {
  if (!tabs.length) return null;
  const full = paneIds.length >= MAX_NOTE_PANES;
  return (
    <div className="flex h-10 shrink-0 items-stretch border-b border-border bg-muted/25" role="tablist" aria-label="打开的笔记">
      <div className="flex min-w-0 flex-1 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          const inPane = paneIds.includes(tab.id);
          const at = tabs.findIndex((item) => item.id === tab.id);
          const title = tab.title || "未命名笔记";
          const paneAction = inPane ? "移出并列" : full ? "最多并列三篇" : "加入并列查看";
          return (
            <ContextMenu key={tab.id}>
              <ContextMenuTrigger asChild>
                <div
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(NOTE_TAB_MIME, tab.id);
                event.dataTransfer.setData("text/plain", tab.id);
              }}
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
              onDrop={(event) => { event.preventDefault(); const source = dragId(event); if (source) onReorder(source, tab.id); }}
              className={cn(
                "group relative flex min-w-36 max-w-60 shrink-0 items-center border-r border-border",
                active ? "bg-background text-foreground" : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
              )}
            >
              {active && <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" />}
              <GripVertical className="ml-1 size-3.5 shrink-0 cursor-grab opacity-35 group-hover:opacity-70" aria-hidden="true" />
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title={title}
                className="min-w-0 flex-1 truncate px-1.5 text-left text-xs font-medium"
                onClick={() => onFocus(tab)}
                onAuxClick={(event) => { if (event.button === 1) onClose(tab.id); }}
              >
                {title}
              </button>
              <Tooltip content={inPane ? (active ? "当前编辑窗格" : "移出并列") : full ? "最多并列三篇" : "加入并列查看"}>
                <span className="inline-flex">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn("size-7 shrink-0", inPane && "text-primary")}
                    aria-label={`${inPane ? "移出" : "加入"}并列查看：${title}`}
                    aria-pressed={inPane}
                    disabled={active || (!inPane && full)}
                    onClick={() => inPane ? onRemovePane(tab.id) : onAddPane(tab.id)}
                  >
                    <Columns2 className="size-3.5" />
                  </Button>
                </span>
              </Tooltip>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="mr-1 size-7 shrink-0 opacity-55 hover:opacity-100"
                aria-label={`关闭：${title}`}
                onClick={() => onClose(tab.id)}
              >
                <X className="size-3.5" />
              </Button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuLabel>{title}</ContextMenuLabel>
                <ContextMenuItem onSelect={() => onFocus(tab)}>切换到此标签</ContextMenuItem>
                <ContextMenuItem
                  disabled={active || (!inPane && full)}
                  onSelect={() => inPane ? onRemovePane(tab.id) : onAddPane(tab.id)}
                >
                  <Columns2 />{active && inPane ? "当前编辑窗格" : paneAction}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => onClose(tab.id)}><X />关闭</ContextMenuItem>
                <ContextMenuItem disabled={tabs.length <= 1} onSelect={() => onCloseMany(tabs.filter((item) => item.id !== tab.id).map((item) => item.id))}>关闭其他标签</ContextMenuItem>
                <ContextMenuItem disabled={at >= tabs.length - 1} onSelect={() => onCloseMany(tabs.slice(at + 1).map((item) => item.id))}>关闭右侧标签</ContextMenuItem>
                <ContextMenuItem onSelect={() => onCloseMany(tabs.map((item) => item.id))}>关闭全部标签</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
      <div
        className={cn(
          "hidden w-36 shrink-0 items-center justify-center gap-1.5 border-l border-dashed border-border px-2 text-[11px] text-muted-foreground lg:flex",
          full && "opacity-45",
        )}
        onDragOver={(event) => { if (!full) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
        onDrop={(event) => { if (full) return; event.preventDefault(); const id = dragId(event); if (id) onAddPane(id); }}
      >
        <Columns2 className="size-3.5" />拖到这里并列
      </div>
    </div>
  );
}

export function NotePreviewPane({ note, notebookTitle, loading, onFocus }: {
  note?: { id: string; title: string; bodyMd: string };
  notebookTitle?: string;
  loading?: boolean;
  onFocus: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <button type="button" onClick={onFocus} className="min-w-0 flex-1 text-left" title="切换到这篇并编辑">
          <span className="block truncate text-[11px] text-muted-foreground">{notebookTitle ?? "笔记"}</span>
          <span className="block truncate text-sm font-semibold">{note?.title || "正在加载…"}</span>
        </button>
        <Tooltip content="切换到这篇并编辑">
          <Button type="button" variant="ghost" size="sm" onClick={onFocus}>编辑</Button>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-6">
        {loading || !note
          ? <div className="grid h-full place-items-center text-muted-foreground"><LoaderCircle className="size-5 animate-spin" /></div>
          : <div className="editor-measure mx-auto" data-wide="1"><MarkdownView source={note.bodyMd} /></div>}
      </div>
    </div>
  );
}
