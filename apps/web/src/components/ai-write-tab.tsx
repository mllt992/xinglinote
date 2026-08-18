import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, RefreshCw, Sparkles, Undo2, X } from "lucide-react";
import { applyHunks, collapseDiff, diffLines, hunksOf, type DiffLine } from "@kb/shared";
import { api } from "../api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { FormError } from "./ui/form-error";
import { useToast } from "./ui/toast";

const ACTIONS = [
  { key: "polish", label: "润色" },
  { key: "shorten", label: "缩短" },
  { key: "expand", label: "扩写" },
  { key: "translate", label: "翻译成中文" },
  { key: "continue", label: "续写" },
  { key: "custom", label: "自定义指令" },
] as const;

type Action = (typeof ACTIONS)[number]["key"];

export type AiWriteNote = { id: string; bodyMd: string; version: number; canEdit: boolean };

/** 选区：AI 只改这一段，其余正文原样保留。 */
export type Selection = { text: string; from: number; to: number } | null;

function HunkView({
  lines,
  hunkOf,
  accepted,
  onToggle,
}: {
  lines: DiffLine[];
  hunkOf: (index: number) => number | undefined;
  accepted: Set<number>;
  onToggle: (hunk: number) => void;
}) {
  const [expanded, setExpanded] = useState<number[]>([]);
  useEffect(() => setExpanded([]), [lines]);

  // 折叠未改动的大段，但保留每行在原数组里的下标，才能查到它属于哪一块。
  const offsets = useMemo(() => {
    const map = new Map<DiffLine, number>();
    lines.forEach((line, i) => map.set(line, i));
    return map;
  }, [lines]);
  const chunks = useMemo(() => collapseDiff(lines, 2), [lines]);

  // 每块只在第一行前面画一次采纳开关。每次渲染都重新数，不用留状态。
  const seenHunks = new Set<number>();
  return (
    <div className="overflow-hidden rounded-xl border border-border font-mono text-[12px] leading-5">
      {chunks.map((chunk, ci) => {
        if (chunk.kind === "gap" && !expanded.includes(ci)) {
          return (
            <button
              key={ci}
              onClick={() => setExpanded(v => [...v, ci])}
              className="flex w-full items-center justify-center border-y border-border bg-muted/50 py-1.5 text-[11px] text-muted-foreground first:border-t-0 hover:bg-muted"
            >
              展开未改动的 {chunk.count} 行
            </button>
          );
        }
        return chunk.lines.map(line => {
          const index = offsets.get(line) ?? -1;
          const hunk = line.op === "same" ? undefined : hunkOf(index);
          const head = hunk !== undefined && !seenHunks.has(hunk);
          if (head) seenHunks.add(hunk);
          const on = hunk !== undefined && accepted.has(hunk);
          return (
            <div key={index}>
              {head && (
                <button
                  onClick={() => onToggle(hunk)}
                  className="flex w-full items-center gap-2 border-y border-border bg-muted/40 px-2 py-1 text-left font-sans text-[11px] hover:bg-muted"
                >
                  <span className={cn("grid size-4 place-items-center rounded border", on ? "border-primary bg-primary text-primary-foreground" : "border-input")}>
                    {on && <Check className="size-3" />}
                  </span>
                  <span className={on ? "" : "text-muted-foreground"}>{on ? "采纳这处改动" : "保留原文"}</span>
                </button>
              )}
              <div
                className={cn(
                  "flex gap-2 px-2 py-px",
                  line.op === "add" && (on ? "bg-green-500/10 text-green-700 dark:text-green-400" : "bg-muted/40 text-muted-foreground line-through"),
                  line.op === "del" && (on ? "bg-destructive/10 text-destructive line-through" : "bg-muted/40 text-muted-foreground"),
                )}
              >
                <span className="w-3 shrink-0 select-none text-muted-foreground/70">
                  {line.op === "add" ? "+" : line.op === "del" ? "−" : " "}
                </span>
                <span className="whitespace-pre-wrap break-words">{line.text || " "}</span>
              </div>
            </div>
          );
        });
      })}
    </div>
  );
}

export function AiWriteTab({
  note,
  workspaceId,
  getSelection,
  onApply,
}: {
  note: AiWriteNote;
  workspaceId?: string;
  /** 打开面板时抓一次编辑器选区。 */
  getSelection: () => Selection;
  /** 把合并后的正文写回笔记；baseVersion 用于版本冲突检查。 */
  onApply: (bodyMd: string, baseVersion: number) => Promise<void>;
}) {
  const [action, setAction] = useState<Action>("polish");
  const [instruction, setInstruction] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [source, setSource] = useState("");
  const [proposal, setProposal] = useState("");
  const [baseVersion, setBaseVersion] = useState(note.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  const abort = useRef<AbortController | null>(null);
  const toast = useToast();

  // 换笔记就清空，免得把上一篇的建议应用到这一篇。
  useEffect(() => { setProposal(""); setError(""); setSelection(null); }, [note.id]);
  useEffect(() => () => abort.current?.abort(), []);

  const lines = useMemo(() => (proposal ? diffLines(source, proposal) : []), [source, proposal]);
  const hunks = useMemo(() => hunksOf(lines), [lines]);
  const owner = useMemo(() => {
    const map = new Map<number, number>();
    for (const h of hunks) for (let i = h.start; i < h.end; i++) map.set(i, h.index);
    return map;
  }, [hunks]);

  const merged = useMemo(() => (proposal ? applyHunks(lines, accepted) : ""), [lines, accepted, proposal]);
  const changed = accepted.size > 0;

  async function generate() {
    if (!note.canEdit) return;
    const picked = getSelection();
    const text = picked?.text.trim() ? picked.text : note.bodyMd;
    if (!text.trim()) { setError("笔记还是空的，没东西可改。"); return; }
    if (action === "custom" && !instruction.trim()) { setError("先写一句指令，比如「改成面向新人的说明」。"); return; }

    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    setError("");
    try {
      const d = await api<{ text: string; baseVersion: number }>("/api/v1/ai/write", {
        method: "POST",
        signal: ctrl.signal,
        body: JSON.stringify({
          noteId: note.id,
          expectedVersion: note.version,
          action,
          text,
          ...(action === "custom" ? { instruction: instruction.trim() } : {}),
        }),
      });
      setSelection(picked);
      setSource(text);
      setProposal(d.text);
      setBaseVersion(d.baseVersion);
      // 默认全采纳，用户再挑要退回哪几处。
      setAccepted(new Set(hunksOf(diffLines(text, d.text)).map(h => h.index)));
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      if (abort.current === ctrl) { abort.current = null; setBusy(false); }
    }
  }

  async function apply() {
    // 改的是选区就只换那一段，其余正文一个字节都不动。
    const next = selection
      ? note.bodyMd.slice(0, selection.from) + merged + note.bodyMd.slice(selection.to)
      : source.endsWith("\n") && merged ? `${merged}\n` : merged;
    try {
      await onApply(next, baseVersion);
      setProposal("");
      toast.success("已应用 AI 建议", `采纳了 ${accepted.size} 处改动`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!workspaceId) return <p className="p-6 text-sm text-muted-foreground">先打开一个工作区里的笔记。</p>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-border p-3">
        <div className="flex flex-wrap gap-1">
          {ACTIONS.map(a => (
            <button
              key={a.key}
              onClick={() => setAction(a.key)}
              className={cn(
                "rounded-lg border px-2 py-1 text-xs",
                action === a.key ? "border-primary bg-primary/10 font-medium" : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              {a.label}
            </button>
          ))}
        </div>
        {action === "custom" && (
          <input
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground"
            value={instruction}
            onChange={e => setInstruction(e.target.value)}
            placeholder="例如：改写成面向新人的说明，保留代码块"
          />
        )}
        <p className="text-[11px] text-muted-foreground">
          在编辑器里选中一段再生成，就只改那一段；没选就整篇。AI 不直接落库，采纳时才写。
        </p>
        <div className="flex gap-2">
          <Button size="sm" disabled={busy || !note.canEdit} onClick={() => void generate()}>
            {busy ? <RefreshCw className="animate-spin" /> : <Bot />}
            {busy ? "生成中…" : proposal ? "重新生成" : "生成建议"}
          </Button>
          {busy && <Button size="sm" variant="ghost" onClick={() => abort.current?.abort()}><X />中断</Button>}
        </div>
        <FormError>{error}</FormError>
      </div>

      {!proposal ? (
        <div className="grid flex-1 place-items-center p-6 text-center">
          <div>
            <Sparkles className="mx-auto mb-3 size-8 text-muted-foreground/40" />
            <p className="text-sm font-medium">还没有建议</p>
            <p className="mt-1 text-xs text-muted-foreground">生成后这里会逐块显示改动，你可以一处一处地挑。</p>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[11px]">
            <span className="text-muted-foreground">
              {selection ? "只改选中的一段" : "整篇"} · {hunks.length} 处改动，已采纳 {accepted.size} 处
            </span>
            <div className="ml-auto flex gap-1">
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setAccepted(new Set(hunks.map(h => h.index)))}>全采纳</Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setAccepted(new Set())}>全退回</Button>
            </div>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-3">
              {hunks.length === 0
                ? <p className="py-10 text-center text-sm text-muted-foreground">AI 给的和原文一样，没有可改的地方。</p>
                : <HunkView lines={lines} hunkOf={i => owner.get(i)} accepted={accepted} onToggle={h => setAccepted(v => {
                    const next = new Set(v);
                    if (next.has(h)) next.delete(h); else next.add(h);
                    return next;
                  })} />}
            </div>
          </ScrollArea>
          <div className="flex gap-2 border-t border-border p-3">
            <Button variant="ghost" size="sm" onClick={() => setProposal("")}><Undo2 />丢弃建议</Button>
            <Button className="flex-1" size="sm" disabled={!changed} onClick={() => void apply()}>
              <Check />应用 {accepted.size} 处改动
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
