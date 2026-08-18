import { useEffect, useRef, useState } from "react";
import { Bot, Check, PenLine, RefreshCw, Sparkles, Wrench, X } from "lucide-react";
import { diagramFence, type DiagramBlock } from "@kb/shared/markdown";
import { api } from "../api";
import { renderDiagram } from "../lib/mermaid-hydrate";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { FormError } from "./ui/form-error";
import { useToast } from "./ui/toast";
import type { RailNote } from "./note-rail";

const KINDS = [
  { key: "auto", label: "自动" },
  { key: "flowchart", label: "流程图" },
  { key: "sequence", label: "时序图" },
  { key: "class", label: "类图" },
  { key: "state", label: "状态图" },
  { key: "er", label: "实体关系" },
  { key: "mindmap", label: "思维导图" },
  { key: "gantt", label: "甘特图" },
] as const;

/**
 * AI 画图。模型只吐 mermaid 源码，这里当场渲染一遍再给人看——**渲染通过才算数**，
 * 这是选 mermaid 而不是 draw.io XML 的主要理由：图能不能用，插进正文前就知道。
 *
 * 落进正文的永远是一段 ` ```mermaid ` 代码块，源码仍然是唯一事实源（设计 17 §2）。
 */
export function AiDiagramTab({
  note,
  workspaceId,
  getTarget,
  onInsert,
}: {
  note: RailNote;
  workspaceId?: string;
  /** 光标所在的那张图，没有就是 null。点生成时抓一次。 */
  getTarget: () => DiagramBlock | null;
  /** 落图：`target` 有值就替换那一段，没有就插到光标处。 */
  onInsert: (fence: string, target: DiagramBlock | null) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]["key"]>("auto");
  const [source, setSource] = useState("");
  const [target, setTarget] = useState<DiagramBlock | null>(null);
  const [svg, setSvg] = useState("");
  const [drawError, setDrawError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  const toast = useToast();

  // 换笔记就清空，免得把上一篇的图插到这一篇。
  useEffect(() => { setSource(""); setSvg(""); setDrawError(""); setError(""); setTarget(null); }, [note.id]);
  useEffect(() => () => abort.current?.abort(), []);

  // 拿到源码就当场画一遍：画得出来才让插。
  useEffect(() => {
    if (!source) { setSvg(""); setDrawError(""); return; }
    let live = true;
    renderDiagram(source)
      .then(out => { if (live) { setSvg(out); setDrawError(""); } })
      .catch((e: unknown) => { if (live) { setSvg(""); setDrawError(e instanceof Error ? e.message : "这张图画不出来"); } });
    return () => { live = false; };
  }, [source]);

  async function generate(fixError?: string) {
    if (!note.canEdit || !prompt.trim()) { setError("先说一句要画什么，比如「用户下单到发货的流程」。"); return; }
    // 改图时以「上一版生成的源码」为准；还没生成过就用光标所在的那张图。
    const spot = fixError ? target : getTarget();
    const current = fixError ? source : spot?.source;

    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    setError("");
    try {
      const d = await api<{ source: string }>("/api/v1/ai/diagram", {
        method: "POST",
        signal: ctrl.signal,
        body: JSON.stringify({
          noteId: note.id,
          prompt: prompt.trim(),
          kind,
          ...(current ? { current } : {}),
          ...(fixError ? { fixError } : {}),
        }),
      });
      setTarget(spot);
      setSource(d.source);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      if (abort.current === ctrl) { abort.current = null; setBusy(false); }
    }
  }

  function insert() {
    onInsert(diagramFence(source), target);
    toast.success(target ? "已替换这张图" : "已插入到笔记", "接着可以在正文里手改，它就是一段 mermaid 源码");
    setSource("");
  }

  if (!workspaceId) return <p className="p-6 text-sm text-muted-foreground">先打开一个工作区里的笔记。</p>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-border p-3">
        <div className="flex flex-wrap gap-1">
          {KINDS.map(k => (
            <button
              key={k.key}
              onClick={() => setKind(k.key)}
              className={cn(
                "rounded-lg border px-2 py-1 text-xs",
                kind === k.key ? "border-primary bg-primary/10 font-medium" : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              {k.label}
            </button>
          ))}
        </div>
        <textarea
          className="h-16 w-full resize-none rounded-lg border border-input bg-transparent p-2 text-xs outline-none placeholder:text-muted-foreground"
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="要画什么？例如：用户下单到发货的流程，含库存不足的分支"
        />
        <p className="text-[11px] text-muted-foreground">
          光标停在一张图里再生成，就是在那张图上改。画出来的是 mermaid 代码块，能直接手改，导出到 Obsidian 也还是这张图。
        </p>
        <div className="flex gap-2">
          <Button size="sm" disabled={busy || !note.canEdit} onClick={() => void generate()}>
            {busy ? <RefreshCw className="animate-spin" /> : <Bot />}
            {busy ? "生成中…" : source ? "重新生成" : "生成图"}
          </Button>
          {busy && <Button size="sm" variant="ghost" onClick={() => abort.current?.abort()}><X />中断</Button>}
        </div>
        <FormError>{error}</FormError>
      </div>

      {!source ? (
        <div className="grid flex-1 place-items-center p-6 text-center">
          <div>
            <Sparkles className="mx-auto mb-3 size-8 text-muted-foreground/40" />
            <p className="text-sm font-medium">还没有图</p>
            <p className="mt-1 text-xs text-muted-foreground">描述一下要画的东西，这里会先画出来给你看，满意了再插进正文。</p>
          </div>
        </div>
      ) : (
        <>
          <div className="border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
            {target ? "会替换光标所在的那张图" : "会插到光标处"} · 插入前先在这里画一遍
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-3 p-3">
              {drawError ? (
                <div className="rounded-xl border border-destructive/50 bg-destructive/5 p-3">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-destructive"><PenLine className="size-3.5" />这张图画不出来</p>
                  <p className="mt-1 break-words text-[11px] text-muted-foreground">{drawError}</p>
                  <Button size="sm" variant="secondary" className="mt-2 h-7 text-[11px]" disabled={busy} onClick={() => void generate(drawError)}>
                    <Wrench className="size-3.5" />把报错发回去让 AI 修
                  </Button>
                </div>
              ) : (
                // mermaid 以 securityLevel: "strict" 渲染，输出的 SVG 由它自己过一遍 DOMPurify。
                <div className="overflow-x-auto rounded-xl border border-border p-3 text-center [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
              )}
              <pre className="overflow-x-auto rounded-xl border border-border bg-muted/40 p-3 font-mono text-[11px] leading-5">{source}</pre>
            </div>
          </ScrollArea>
          <div className="flex gap-2 border-t border-border p-3">
            <Button variant="ghost" size="sm" onClick={() => setSource("")}><X />丢弃</Button>
            <Button className="flex-1" size="sm" disabled={!!drawError || !note.canEdit} onClick={insert}>
              <Check />{target ? "替换这张图" : "插入到笔记"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
