import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, FilePlus2, Notebook, Search, Sparkles, Trash2, X } from "lucide-react";
import { MarkdownView } from "../MarkdownView";
import { api } from "../api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { FormError } from "./ui/form-error";
import { ScrollArea } from "./ui/scroll-area";
import { Textarea } from "./ui/textarea";
import { Tooltip } from "./ui/tooltip";
import { useToast } from "./ui/toast";

type Citation = { noteId: string; title: string; excerpt: string };
type Turn = {
  id: string;
  question: string;
  answer: string;
  citations: Citation[];
  grounded?: boolean;
  at: number;
  scope: "workspace" | "notebook";
};

const WIDTH_KEY = "kb.ask.width";
const TURNS_KEY = (wsId: string) => `kb.ask.turns.${wsId}`;
const MIN_WIDTH = 320;
const MAX_WIDTH = 560;

function loadWidth() {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(n) && n >= MIN_WIDTH && n <= MAX_WIDTH ? n : 380;
  } catch { return 380; }
}

function loadTurns(wsId: string): Turn[] {
  try {
    const raw = localStorage.getItem(TURNS_KEY(wsId));
    const parsed = raw ? JSON.parse(raw) as Turn[] : [];
    return Array.isArray(parsed) ? parsed.slice(-20) : [];
  } catch { return []; }
}

function saveTurns(wsId: string, turns: Turn[]) {
  try { localStorage.setItem(TURNS_KEY(wsId), JSON.stringify(turns.slice(-20))); } catch { /* 隐私模式忽略 */ }
}

export function AskSidebar({
  workspaceId,
  notebookId,
  notebookTitle,
  overlay,
  onClose,
  onOpenNote,
}: {
  workspaceId?: string;
  notebookId?: string;
  notebookTitle?: string;
  overlay?: boolean;
  onClose: () => void;
  onOpenNote: (id: string) => void;
}) {
  const nav = useNavigate();
  const toast = useToast();
  const [width, setWidth] = useState(loadWidth);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scope, setScope] = useState<"workspace" | "notebook">("workspace");
  const [turns, setTurns] = useState<Turn[]>(() => workspaceId ? loadTurns(workspaceId) : []);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const host = useRef<HTMLElement | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const box = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* 忽略 */ }
  }, [width]);

  useEffect(() => {
    if (!workspaceId) return;
    setTurns(loadTurns(workspaceId));
    setConfigured(null);
    api<{ providers: Array<{ enabled: boolean }> }>(`/api/v1/workspaces/${workspaceId}/ai/provider`)
      .then(d => setConfigured(d.providers.some(p => p.enabled)))
      .catch(() => setConfigured(null));
  }, [workspaceId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [turns, busy]);

  useEffect(() => {
    if (!overlay) box.current?.focus();
    const t = window.setTimeout(() => box.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [overlay]);

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

  async function ask() {
    if (!workspaceId || !q.trim() || busy) return;
    if (scope === "notebook" && !notebookId) {
      setError("先在左侧选一个笔记本，才能只问当前本。");
      return;
    }
    const question = q.trim();
    setBusy(true);
    setError("");
    setQ("");
    try {
      const data = await api<{ answer: string; citations: Citation[]; grounded?: boolean }>("/api/v1/ai/ask", {
        method: "POST",
        body: JSON.stringify({
          workspaceId,
          question,
          notebookId: scope === "notebook" ? notebookId : undefined,
          history: turns.slice(-3).map(t => ({ question: t.question, answer: t.answer.slice(0, 240) })),
        }),
      });
      const next: Turn[] = [...turns, {
        id: crypto.randomUUID(),
        question,
        answer: data.answer,
        citations: data.citations ?? [],
        grounded: data.grounded,
        at: Date.now(),
        scope,
      }];
      setTurns(next);
      saveTurns(workspaceId, next);
    } catch (e) {
      const err = e as Error & { code?: string };
      setError(err.message);
      if (err.code === "AI_NOT_CONFIGURED") setConfigured(false);
      setQ(question);
    } finally {
      setBusy(false);
    }
  }

  function clearTurns() {
    if (!workspaceId) return;
    setTurns([]);
    saveTurns(workspaceId, []);
  }

  async function saveAsNote(turn: Turn) {
    if (!notebookId || !workspaceId) {
      setError("先选一个笔记本，才能把回答沉淀成笔记。");
      return;
    }
    setSavingId(turn.id);
    setError("");
    try {
      const created = await api<{ id: string; version: number; title: string }>("/api/v1/notes", {
        method: "POST",
        body: JSON.stringify({ notebookId, title: turn.question.slice(0, 80) || "问答记录" }),
      });
      const cites = turn.citations.length
        ? `\n\n## 引用\n${turn.citations.map((c, i) => `- [#${i + 1}] [[${c.title}]]`).join("\n")}`
        : "";
      const bodyMd = `> 问知识库 · ${turn.scope === "notebook" ? "当前笔记本" : "当前工作区"}\n\n${turn.answer}${cites}`;
      await api(`/api/v1/notes/${created.id}`, {
        method: "PATCH",
        body: JSON.stringify({ expectedVersion: created.version, title: created.title, bodyMd, source: "ai_accept" }),
      });
      toast.success("已沉淀为笔记");
      onOpenNote(created.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingId(null);
    }
  }

  const panel = (
    <aside
      ref={host}
      style={{ width: overlay ? undefined : width }}
      className={cn(
        "ask-sidebar relative flex min-h-0 shrink-0 flex-col border-l border-border bg-background",
        overlay && "fixed inset-y-0 right-0 top-14 z-50 w-[min(100vw,380px)] shadow-2xl",
      )}
    >
      {!overlay && (
        <div
          onPointerDown={startResize}
          onDoubleClick={() => setWidth(380)}
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整问答栏宽度"
          className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-primary/20"
        />
      )}
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-3">
        <Sparkles className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">问知识库</p>
          <p className="truncate text-[11px] text-muted-foreground">笔记优先，换算和常识可直接答</p>
        </div>
        {turns.length > 0 && (
          <Tooltip content="清空这轮会话">
            <Button variant="ghost" size="icon" className="size-8" aria-label="清空会话" onClick={clearTurns}><Trash2 /></Button>
          </Tooltip>
        )}
        <Button variant="ghost" size="icon" className="size-8" aria-label="关闭问答栏" onClick={onClose}><X /></Button>
      </div>

      <div className="flex shrink-0 gap-1 border-b border-border px-3 py-2">
        <Button
          type="button"
          size="sm"
          variant={scope === "workspace" ? "secondary" : "ghost"}
          onClick={() => setScope("workspace")}
        >
          <Search />当前工作区
        </Button>
        <Button
          type="button"
          size="sm"
          variant={scope === "notebook" ? "secondary" : "ghost"}
          disabled={!notebookId}
          onClick={() => setScope("notebook")}
        >
          <Notebook />{notebookTitle ? `本：${notebookTitle}` : "当前笔记本"}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {configured === false && (
            <div className="rounded-xl border border-border bg-muted/40 p-4">
              <p className="flex items-center gap-2 text-sm font-medium"><Bot className="size-4" />还没接模型</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">问答、语义检索都要先给这个工作区配一个 OpenAI 兼容模型。</p>
              <Button size="sm" className="mt-3" onClick={() => workspaceId && nav(`/w/${workspaceId}/settings/integrations`)}>去配置 AI</Button>
            </div>
          )}

          {configured !== false && turns.length === 0 && !busy && (
            <div className="py-10 text-center">
              <span className="mx-auto mb-3 grid size-8 place-items-center text-muted-foreground/40"><Sparkles className="size-8" /></span>
              <p className="text-sm font-medium">用这个问题问你的库</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">库内事实只根据已开启 AI 可读的笔记；换算、计算、常识不必翻库。</p>
            </div>
          )}

          {turns.map(turn => (
            <article key={turn.id} className="space-y-2">
              <div className="ml-6 rounded-xl bg-primary px-3 py-2 text-sm text-primary-foreground">{turn.question}</div>
              <div className="rounded-xl bg-muted/50 px-3 py-2.5">
                <MarkdownView source={turn.answer} className="feed-md" />
              </div>
              {turn.grounded === false && turn.citations.length === 0 && (
                <p className="text-[11px] text-muted-foreground">未引用笔记，这是模型自己的回答。</p>
              )}
              {turn.citations.length > 0 && (
                <div className="space-y-1.5">
                  {turn.citations.map((c, i) => (
                    <button
                      key={c.noteId + i}
                      type="button"
                      className="block w-full rounded-xl border border-border p-2.5 text-left hover:bg-muted"
                      onClick={() => onOpenNote(c.noteId)}
                    >
                      <p className="truncate text-xs font-medium">[#{i + 1}] {c.title}</p>
                      <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{c.excerpt}</p>
                    </button>
                  ))}
                </div>
              )}
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!notebookId || savingId === turn.id}
                  onClick={() => void saveAsNote(turn)}
                >
                  <FilePlus2 />{savingId === turn.id ? "写入中…" : "沉淀为笔记"}
                </Button>
              </div>
            </article>
          ))}

          {busy && (
            <div className="rounded-xl bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground">正在生成回答…</div>
          )}
          <div ref={bottom} />
        </div>
      </ScrollArea>

      <form
        className="shrink-0 space-y-2 border-t border-border p-3"
        onSubmit={e => { e.preventDefault(); void ask(); }}
      >
        <FormError>{error}</FormError>
        <Textarea
          ref={box}
          value={q}
          rows={3}
          disabled={busy || configured === false}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask();
            }
          }}
          placeholder={configured === false ? "先配置 AI 提供商" : "提问，例如：这个项目的发布流程是什么？"}
          className="min-h-[4.5rem] resize-none"
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">Enter 发送 · Shift+Enter 换行</p>
          <Button type="submit" disabled={busy || !q.trim() || configured === false}>{busy ? "生成中…" : "提问"}</Button>
        </div>
      </form>
    </aside>
  );

  if (!overlay) return panel;
  return (
    <>
      <button type="button" aria-label="收起问答栏" className="fixed inset-x-0 bottom-0 top-14 z-40 bg-foreground/40" onClick={onClose} />
      {panel}
    </>
  );
}
