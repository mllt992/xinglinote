import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { History, List, ListChecks, MessageSquare, Paperclip, PanelRight, Share2, Sparkles, Trash2, Upload, Workflow, X } from "lucide-react";
import { outlineOf, type DiagramBlock, type OutlineItem } from "@kb/shared/markdown";
import { useDebounced } from "../lib/use-debounced";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import { Tooltip } from "./ui/tooltip";
import { VersionsTab } from "./version-panel";
import { AiDiagramTab } from "./ai-diagram-tab";
import { AiWriteTab, type Selection } from "./ai-write-tab";
import { AiTasksTab } from "./ai-tasks-tab";
import { ReviewTab } from "./review-tab";

export const RAIL_TABS = ["outline", "links", "attachments", "versions", "review", "ai", "diagram", "tasks"] as const;
export type RailTab = (typeof RAIL_TABS)[number];

const TAB_META: Record<RailTab, { label: string; icon: ReactNode }> = {
  outline: { label: "大纲", icon: <List /> },
  links: { label: "反向链接", icon: <PanelRight /> },
  attachments: { label: "附件", icon: <Paperclip /> },
  versions: { label: "版本历史", icon: <History /> },
  review: { label: "评论与纠错", icon: <MessageSquare /> },
  ai: { label: "AI 写作", icon: <Sparkles /> },
  diagram: { label: "AI 画图", icon: <Workflow /> },
  tasks: { label: "提取待办", icon: <ListChecks /> },
};

const WIDTH_KEY = "kb.note-rail.width";
const TAB_KEY = "kb.note-rail.tab";
const MIN_WIDTH = 300;
const MAX_WIDTH = 720;

export function isRailTab(value: unknown): value is RailTab {
  return typeof value === "string" && (RAIL_TABS as readonly string[]).includes(value);
}

/** 上次开的是哪个页签；没开过就是 null（右栏默认收起）。 */
export function loadRailTab(): RailTab | null {
  try {
    const raw = localStorage.getItem(TAB_KEY);
    return isRailTab(raw) ? raw : null;
  } catch { return null; }
}

export function saveRailTab(tab: RailTab | null) {
  try {
    if (tab) localStorage.setItem(TAB_KEY, tab);
    else localStorage.removeItem(TAB_KEY);
  } catch { /* 隐私模式下写不进去就算了 */ }
}

function loadWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(n) && n >= MIN_WIDTH && n <= MAX_WIDTH ? n : 400;
  } catch { return 400; }
}

export type Backlink = { id: string; title: string; snippet: string };
export type Attachment = { id: string; filename: string; url: string; mime: string; bytes: number };

export type RailNote = {
  id: string;
  title: string;
  bodyMd: string;
  version: number;
  canEdit: boolean;
  tags?: string[];
};

function humanBytes(bytes: number): string {
  return bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

function Empty({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="py-16 text-center">
      <span className="mx-auto mb-3 grid size-8 place-items-center text-muted-foreground/40 [&_svg]:size-8">{icon}</span>
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{text}</p>
    </div>
  );
}

function OutlineTab({ source, activeLine, onJump }: { source: string; activeLine?: number; onJump: (slug: string, line: number) => void }) {
  const [filter, setFilter] = useState("");
  // `outlineOf` 是一次完整的 markdown-it parse。不挡着就是每敲一个字全篇重解析一遍
  // ——大纲一旦打开就记在 localStorage 里粘住，所以这对常用大纲的人是常态。
  const settled = useDebounced(source, 180);
  const items = useMemo(() => outlineOf(settled), [settled]);
  const minLevel = useMemo(() => items.reduce((m, i) => Math.min(m, i.level), 6), [items]);
  const shown = useMemo(() => {
    const q = filter.trim().toLocaleLowerCase();
    return q ? items.filter(i => i.text.toLocaleLowerCase().includes(q)) : items;
  }, [items, filter]);

  // 中文按字数估读速，比按词数靠谱。
  const chars = settled.replace(/\s/g, "").length;
  const minutes = Math.max(1, Math.round(chars / 400));

  /**
   * 光标落在哪一节。大纲以前是死的——能从大纲跳进正文，正文动了大纲却不动，
   * 写长文时不知道自己在哪一节。`activeLine` 是 1 基（编辑器的老习惯），
   * `item.line` 是 0 基（和 `data-line` 同一套），比的时候补上这一格。
   */
  const active = useMemo(() => {
    if (!activeLine) return null;
    let hit: OutlineItem | null = null;
    for (const item of items) {
      if (item.line + 1 > activeLine) break;
      hit = item;
    }
    return hit;
  }, [items, activeLine]);

  return (
    <>
      <div className="border-b border-border px-3 py-2">
        <p className="text-[11px] text-muted-foreground">{chars} 字 · 约 {minutes} 分钟读完 · {items.length} 个标题</p>
        {items.length > 8 && (
          <input
            className="mt-2 h-7 w-full rounded-lg border border-input bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="过滤标题…"
          />
        )}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2">
          {items.length === 0 ? (
            <Empty icon={<List />} title="这篇还没有标题" text="用 # 写几级标题，这里就会出现可点的大纲。" />
          ) : shown.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">没有匹配「{filter}」的标题。</p>
          ) : (
            shown.map((item, i) => (
              <button
                key={`${item.slug}-${i}`}
                onClick={() => onJump(item.slug, item.line)}
                style={{ paddingLeft: 8 + (item.level - minLevel) * 14 }}
                aria-current={item === active ? "location" : undefined}
                className={cn(
                  "block w-full truncate rounded-lg py-1.5 pr-2 text-left text-sm hover:bg-muted",
                  item.level === minLevel ? "font-medium" : "text-muted-foreground",
                  item === active && "bg-accent text-foreground shadow-[inset_2px_0_0_var(--primary)]",
                )}
                title={item.text}
              >
                {item.text}
              </button>
            ))
          )}
        </div>
      </ScrollArea>
    </>
  );
}

function LinksTab({
  note,
  backlinks,
  wsId,
  onSearchTag,
  onChangeTags,
}: {
  note: RailNote;
  backlinks: Backlink[];
  wsId?: string;
  onSearchTag: (tag: string) => void;
  onChangeTags: (tags: string[]) => void;
}) {
  const tags = note.tags ?? [];
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-2 p-3">
        <p className="px-1 text-[11px] text-muted-foreground">{backlinks.length} 个页面提到了这里</p>
        {backlinks.length === 0 ? (
          <Empty icon={<PanelRight />} title="还没有反向链接" text="其他笔记用 [[标题]] 链到这里后会显示。" />
        ) : (
          backlinks.map(b => (
            <Link key={b.id} to={`/w/${wsId}/n/${b.id}`} className="block rounded-xl border border-border p-3 hover:bg-muted">
              <p className="text-sm font-medium">{b.title}</p>
              <p className="mt-1.5 line-clamp-3 text-xs leading-5 text-muted-foreground">{b.snippet}</p>
            </Link>
          ))
        )}

        <Separator className="my-4" />
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[.12em] text-muted-foreground">标签</p>
        <div className="flex flex-wrap gap-1.5">
          {tags.map(t => (
            <span key={t} className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[11px]">
              <button className="hover:underline" onClick={() => onSearchTag(t)}>{t}</button>
              {note.canEdit && (
                <button
                  aria-label={`删除标签 ${t}`}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => onChangeTags(tags.filter(x => x !== t))}
                >×</button>
              )}
            </span>
          ))}
          {note.canEdit && (
            <input
              className="h-6 w-24 rounded-full border border-dashed bg-transparent px-2 text-[11px] outline-none placeholder:text-muted-foreground"
              placeholder="加标签…"
              onKeyDown={e => {
                if (e.key !== "Enter") return;
                const v = e.currentTarget.value.trim();
                e.currentTarget.value = "";
                if (v && !tags.includes(v)) onChangeTags([...tags, v]);
              }}
            />
          )}
        </div>
      </div>
    </ScrollArea>
  );
}

function AttachmentsTab({
  note,
  atts,
  onUpload,
  onShare,
  onDelete,
  onInsert,
}: {
  note: RailNote;
  atts: Attachment[];
  onUpload: () => void;
  onShare: (a: Attachment) => void;
  onDelete: (a: Attachment) => void;
  onInsert: (a: Attachment) => void;
}) {
  // 正文里没被引用的附件很容易被忘掉，单独标出来。
  const orphans = useMemo(
    () => new Set(atts.filter(a => !note.bodyMd.includes(a.url)).map(a => a.id)),
    [atts, note.bodyMd],
  );
  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <p className="flex-1 text-[11px] text-muted-foreground">
          {atts.length} 个附件{orphans.size > 0 && ` · ${orphans.size} 个没被正文引用`}
        </p>
        {note.canEdit && <Button size="sm" variant="outline" onClick={onUpload}><Upload />上传</Button>}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-3">
          {atts.length === 0 ? (
            <Empty icon={<Paperclip />} title="还没有附件" text="点上传，或者直接把文件拖进编辑器、粘贴进来。" />
          ) : atts.map(a => (
            <div key={a.id} className="rounded-xl border border-border p-2.5">
              <div className="flex items-center gap-2">
                {a.mime.startsWith("image/")
                  ? <img src={a.url} alt="" className="size-9 shrink-0 rounded-lg object-cover" />
                  : <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted"><Paperclip className="size-4 text-muted-foreground" /></span>}
                <div className="min-w-0 flex-1">
                  <a href={a.url} target="_blank" rel="noreferrer" className="block truncate text-xs font-medium hover:underline">{a.filename}</a>
                  <p className="text-[11px] text-muted-foreground">
                    {humanBytes(a.bytes)}
                    {orphans.has(a.id) && <span className="ml-1.5 text-amber-600 dark:text-amber-400">未被引用</span>}
                  </p>
                </div>
                <Tooltip content="分享此附件">
                  <Button variant="ghost" size="icon" className="size-7" onClick={() => onShare(a)}><Share2 /></Button>
                </Tooltip>
                {note.canEdit && (
                  <Button variant="ghost" size="icon" className="size-7" aria-label={`删除附件 ${a.filename}`} onClick={() => onDelete(a)}><Trash2 /></Button>
                )}
              </div>
              {note.canEdit && orphans.has(a.id) && (
                <Button size="sm" variant="ghost" className="mt-1 h-7 w-full justify-start px-1 text-[11px]" onClick={() => onInsert(a)}>
                  插入到正文末尾
                </Button>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>
    </>
  );
}

export function NoteRail({
  note,
  tab,
  onTab,
  onClose,
  backlinks,
  atts,
  wsId,
  onJump,
  activeLine,
  onSearchTag,
  onChangeTags,
  onUpload,
  onShareAttachment,
  onDeleteAttachment,
  onInsertAttachment,
  onRestored,
  workspaceId,
  getSelection,
  getDiagramTarget,
  onInsertDiagram,
  onApplyAi,
  onReviewApplied,
  onLocate,
}: {
  note: RailNote;
  tab: RailTab;
  onTab: (tab: RailTab) => void;
  onClose: () => void;
  backlinks: Backlink[];
  atts: Attachment[];
  wsId?: string;
  onJump: (slug: string, line: number) => void;
  /** 光标所在行（1 基）。大纲拿它高亮当前小节。 */
  activeLine?: number;
  onSearchTag: (tag: string) => void;
  onChangeTags: (tags: string[]) => void;
  onUpload: () => void;
  onShareAttachment: (a: Attachment) => void;
  onDeleteAttachment: (a: Attachment) => void;
  onInsertAttachment: (a: Attachment) => void;
  onRestored: (note: { id: string; title: string; bodyMd: string; version: number }) => void;
  workspaceId?: string;
  getSelection: () => Selection;
  /** 光标所在的 mermaid 图块，供 AI 画图判断是「改图」还是「新图」。 */
  getDiagramTarget: () => DiagramBlock | null;
  onInsertDiagram: (fence: string, target: DiagramBlock | null) => void;
  onApplyAi: (bodyMd: string, baseVersion: number) => Promise<void>;
  onReviewApplied: () => void;
  onLocate: (excerpt: string) => void;
}) {
  const [width, setWidth] = useState(loadWidth);
  const host = useRef<HTMLElement | null>(null);

  useEffect(() => {
    try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* 忽略 */ }
  }, [width]);

  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const right = host.current?.getBoundingClientRect().right ?? 0;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, right - ev.clientX)));
    const stop = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
  }

  const counts: Partial<Record<RailTab, number>> = { links: backlinks.length, attachments: atts.length };

  return (
    <aside
      ref={host}
      style={{ width }}
      className="note-rail relative flex min-h-0 shrink-0 flex-col border-l border-border bg-background"
    >
      <div
        onPointerDown={startResize}
        onDoubleClick={() => setWidth(400)}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整右栏宽度"
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-primary/20"
      />
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-2">
        {RAIL_TABS.map(key => (
          <Tooltip key={key} content={TAB_META[key].label}>
            <Button
              variant={tab === key ? "secondary" : "ghost"}
              size="icon"
              aria-label={TAB_META[key].label}
              aria-pressed={tab === key}
              className="relative size-9"
              onClick={() => onTab(key)}
            >
              {TAB_META[key].icon}
              {!!counts[key] && (
                <span className="absolute right-1 top-1 min-w-3 rounded-full bg-muted px-1 text-[9px] leading-3 text-muted-foreground">
                  {counts[key]}
                </span>
              )}
            </Button>
          </Tooltip>
        ))}
        <span className="ml-1 min-w-0 flex-1 truncate text-sm font-semibold">{TAB_META[tab].label}</span>
        <Button variant="ghost" size="icon" aria-label="关闭右栏" onClick={onClose}><X /></Button>
      </div>

      {tab === "outline" && <OutlineTab source={note.bodyMd} activeLine={activeLine} onJump={onJump} />}
      {tab === "links" && <LinksTab note={note} backlinks={backlinks} wsId={wsId} onSearchTag={onSearchTag} onChangeTags={onChangeTags} />}
      {tab === "attachments" && (
        <AttachmentsTab note={note} atts={atts} onUpload={onUpload} onShare={onShareAttachment} onDelete={onDeleteAttachment} onInsert={onInsertAttachment} />
      )}
      {tab === "versions" && <VersionsTab note={note} onRestored={onRestored} />}
      {tab === "review" && <ReviewTab note={note} onLocate={onLocate} onApplied={onReviewApplied} />}
      {tab === "ai" && <AiWriteTab note={note} workspaceId={workspaceId} getSelection={getSelection} onApply={onApplyAi} />}
      {tab === "diagram" && <AiDiagramTab note={note} workspaceId={workspaceId} getTarget={getDiagramTarget} onInsert={onInsertDiagram} />}
      {tab === "tasks" && <AiTasksTab note={note} workspaceId={workspaceId} />}
    </aside>
  );
}
