import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, History, RotateCcw } from "lucide-react";
import { collapseDiff, diffLines, diffStats, type DiffChunk } from "@kb/shared";
import { api } from "../api";
import { MarkdownView } from "../MarkdownView";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip } from "./ui/tooltip";
import { useConfirm } from "./ui/confirm";
import { useToast } from "./ui/toast";

export type NoteVersion = {
  id: string;
  version: number;
  title: string;
  bodyMd: string;
  source: string;
  createdAt: string;
};

const SOURCE_LABELS: Record<string, string> = {
  ui: "手动保存",
  edit: "手动保存",
  ai_accept: "采纳 AI 建议",
  correction: "接受纠错",
  restore: "版本恢复",
  import: "导入",
  mcp: "MCP 写入",
  task_toggle: "勾选任务",
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function timeLabel(iso: string): string {
  const t = new Date(iso);
  const diffMin = Math.round((Date.now() - t.getTime()) / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffMin < 60 * 24) return `${Math.round(diffMin / 60)} 小时前`;
  return t.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function DiffBody({ chunks, onExpand }: { chunks: DiffChunk[]; onExpand: (index: number) => void }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border font-mono text-[12px] leading-5">
      {chunks.map((chunk, i) =>
        chunk.kind === "gap" ? (
          <button
            key={i}
            onClick={() => onExpand(i)}
            className="flex w-full items-center justify-center gap-2 border-y border-border bg-muted/50 py-1.5 text-[11px] text-muted-foreground first:border-t-0 last:border-b-0 hover:bg-muted"
          >
            展开中间未改动的 {chunk.count} 行
          </button>
        ) : (
          chunk.lines.map((line, j) => (
            <div
              key={`${i}-${j}`}
              className={cn(
                "flex gap-2 px-2 py-px",
                line.op === "add" && "bg-green-500/10 text-green-700 dark:text-green-400",
                line.op === "del" && "bg-destructive/10 text-destructive",
              )}
            >
              <span className="w-9 shrink-0 select-none text-right text-muted-foreground/60">
                {line.op === "add" ? line.bLine : line.aLine}
              </span>
              <span className="w-3 shrink-0 select-none text-muted-foreground/70">
                {line.op === "add" ? "+" : line.op === "del" ? "−" : " "}
              </span>
              <span className="whitespace-pre-wrap break-words">{line.text || " "}</span>
            </div>
          ))
        ),
      )}
    </div>
  );
}

function VersionDetail({
  version,
  currentTitle,
  currentBody,
  canEdit,
  onBack,
  onRestore,
}: {
  version: NoteVersion;
  currentTitle: string;
  currentBody: string;
  canEdit: boolean;
  onBack: () => void;
  onRestore: () => void;
}) {
  const [tab, setTab] = useState<"diff" | "full">("diff");
  const [expanded, setExpanded] = useState<number[]>([]);

  const lines = useMemo(() => diffLines(version.bodyMd, currentBody), [version.bodyMd, currentBody]);
  const stats = useMemo(() => diffStats(lines), [lines]);
  const chunks = useMemo(() => {
    const base = collapseDiff(lines, 3);
    return base.map((chunk, i) => (chunk.kind === "gap" && expanded.includes(i) ? { kind: "lines" as const, lines: chunk.lines } : chunk));
  }, [lines, expanded]);

  useEffect(() => setExpanded([]), [version.id]);

  const titleChanged = version.title !== currentTitle;
  const unchanged = stats.added === 0 && stats.removed === 0 && !titleChanged;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button variant="ghost" size="icon" className="size-8" aria-label="返回版本列表" onClick={onBack}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">v{version.version} · {version.title || "未命名"}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {sourceLabel(version.source)} · {new Date(version.createdAt).toLocaleString("zh-CN")}
          </p>
        </div>
        {canEdit && (
          <Tooltip content="把这个版本的内容写回笔记，作为一个新版本">
            <Button variant="outline" size="sm" onClick={onRestore}><RotateCcw />恢复</Button>
          </Tooltip>
        )}
      </div>

      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        <div className="inline-flex rounded-lg bg-muted p-1">
          <button
            onClick={() => setTab("diff")}
            className={cn("rounded-md px-2.5 py-1 text-xs font-medium", tab === "diff" ? "bg-background shadow-sm" : "text-muted-foreground")}
          >
            与当前对比
          </button>
          <button
            onClick={() => setTab("full")}
            className={cn("rounded-md px-2.5 py-1 text-xs font-medium", tab === "full" ? "bg-background shadow-sm" : "text-muted-foreground")}
          >
            这个版本的内容
          </button>
        </div>
        {tab === "diff" && !unchanged && (
          <span className="ml-auto font-mono text-[11px]">
            <span className="text-destructive">−{stats.removed}</span>{" "}
            <span className="text-green-600 dark:text-green-400">+{stats.added}</span>
          </span>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3">
          {tab === "full" ? (
            <MarkdownView source={version.bodyMd} />
          ) : unchanged ? (
            <p className="py-16 text-center text-sm text-muted-foreground">这个版本和当前内容一模一样。</p>
          ) : (
            <>
              <p className="mb-2 text-[11px] text-muted-foreground">
                <span className="text-destructive">红色</span>是这个版本里有、现在没有的内容，
                <span className="text-green-600 dark:text-green-400">绿色</span>是现在才有的。
              </p>
              {titleChanged && (
                <div className="mb-3 rounded-xl border border-border p-2.5 text-xs">
                  <p className="mb-1 text-[11px] text-muted-foreground">标题</p>
                  <p className="text-destructive line-through">{version.title || "未命名"}</p>
                  <p className="text-green-600 dark:text-green-400">{currentTitle || "未命名"}</p>
                </div>
              )}
              <DiffBody chunks={chunks} onExpand={i => setExpanded(v => [...v, i])} />
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/** 版本历史页签：列表 ⇄ 详情两级，详情里能看 diff、看原文、恢复。 */
export function VersionsTab({
  note,
  onRestored,
}: {
  note: { id: string; title: string; bodyMd: string; version: number; canEdit: boolean };
  onRestored: (note: { id: string; title: string; bodyMd: string; version: number }) => void;
}) {
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const askConfirm = useConfirm();
  const toast = useToast();

  async function load(id: string) {
    setLoading(true);
    try {
      const d = await api<{ versions: NoteVersion[] }>(`/api/v1/notes/${id}/versions`);
      setVersions(d.versions);
    } catch (e) {
      toast.error("读取版本历史失败", (e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSelected(null);
    void load(note.id);
  }, [note.id]);

  const current = versions.find(v => v.id === selected) ?? null;

  async function restore(v: NoteVersion) {
    if (!await askConfirm({
      title: `恢复到 v${v.version}？`,
      description: "当前内容会先存成一个版本，再把这个版本写回笔记，随时可以再恢复回来。",
      confirmText: "恢复为新版本",
    })) return;
    try {
      const saved = await api<{ id: string; title: string; bodyMd: string; version: number }>(
        `/api/v1/notes/${note.id}/versions/${v.version}/restore`,
        { method: "POST" },
      );
      onRestored(saved);
      toast.success(`已恢复 v${v.version}`, `当前是 v${saved.version}`);
      setSelected(null);
      void load(note.id);
    } catch (e) {
      toast.error("恢复失败", (e as Error).message);
    }
  }

  if (current) {
    return (
      <VersionDetail
        version={current}
        currentTitle={note.title}
        currentBody={note.bodyMd}
        canEdit={note.canEdit}
        onBack={() => setSelected(null)}
        onRestore={() => void restore(current)}
      />
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-1.5 p-3">
        <p className="px-1 pb-1 text-[11px] text-muted-foreground">
          {loading ? "读取中…" : `${versions.length} 个版本 · 当前 v${note.version}`}
        </p>
        {versions.length === 0 ? (
          <div className="py-16 text-center">
            <History className="mx-auto mb-3 size-8 text-muted-foreground/40" />
            <p className="text-sm font-medium">{loading ? "读取中…" : "还没有历史版本"}</p>
            <p className="mt-1 text-xs text-muted-foreground">每次保存、采纳 AI 建议、接受纠错和恢复都会留下一个版本。</p>
          </div>
        ) : (
          versions.map(v => (
            <button
              key={v.id}
              onClick={() => setSelected(v.id)}
              className="block w-full rounded-xl border border-border p-3 text-left hover:bg-muted"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">v{v.version}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{v.title || "未命名"}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{timeLabel(v.createdAt)}</span>
              </div>
              <p className="mt-1 truncate text-[11px] text-muted-foreground">
                {sourceLabel(v.source)} · {v.bodyMd.length} 字
              </p>
            </button>
          ))
        )}
      </div>
    </ScrollArea>
  );
}
