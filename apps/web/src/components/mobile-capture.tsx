import { useEffect, useRef, useState } from "react";
import { CheckSquare, FileText, PenLine } from "lucide-react";
import { api } from "../api";
import { appendCapturedNote, captureDraftKey, captureTaskBody, captureWallToIso, readCaptureDraft, type CaptureDraft, type CaptureKind } from "../lib/mobile-capture";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { FormError } from "./ui/form-error";
import { Textarea } from "./ui/textarea";
import { useToast } from "./ui/toast";

type CaptureProps = { wsId: string; date: string; timezone: string; canEdit: boolean; onCreated: () => void; onOpenNote: (id: string) => void };
const emptyDraft = (notebookId = ""): CaptureDraft => ({ id: crypto.randomUUID(), text: "", kind: "task", notebookId });

/** 固定在页面底部的速记区，用户身份确认前不读取任何本地正文。 */
export function MobileCapture(props: CaptureProps) {
  const [userId, setUserId] = useState("");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let stopped = false;
    api<{ id: string }>("/api/v1/me").then(me => { if (!stopped) { setUserId(me.id); setError(""); } }).catch(() => { if (!stopped) setError("速记暂时不可用，请重试"); });
    return () => { stopped = true; };
  }, [retry]);
  if (!props.canEdit) return null;
  if (!userId) return <div className="shrink-0 border-t border-border p-3 text-sm text-muted-foreground">{error ? <div className="flex items-center justify-between gap-2"><FormError>{error}</FormError><Button className="min-h-11" variant="outline" onClick={() => setRetry(x => x + 1)}>重试</Button></div> : "正在准备速记…"}</div>;
  return <CaptureComposer key={`${userId}:${props.wsId}`} {...props} userId={userId} />;
}

function CaptureComposer({ wsId, date, timezone, onCreated, onOpenNote, userId }: CaptureProps & { userId: string }) {
  const toast = useToast();
  const key = captureDraftKey(userId, wsId);
  const [draft, setDraft] = useState<CaptureDraft>(() => {
    try { return readCaptureDraft(localStorage.getItem(key)) ?? emptyDraft(); } catch { return emptyDraft(); }
  });
  const draftRef = useRef(draft);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [notebooks, setNotebooks] = useState<Array<{ id: string; title: string }>>([]);
  const [notebooksLoading, setNotebooksLoading] = useState(false);

  function update(next: CaptureDraft) {
    draftRef.current = next;
    setDraft(next);
    try {
      if (next.text) localStorage.setItem(key, JSON.stringify(next)); else localStorage.removeItem(key);
      setStorageError(false);
    } catch { setStorageError(true); }
  }

  useEffect(() => {
    if (!noteOpen) return;
    let stopped = false;
    setNotebooksLoading(true);
    api<{ notebooks: Array<{ id: string; title: string }> }>(`/api/v1/workspaces/${wsId}/notebooks`).then(result => {
      if (stopped) return;
      setNotebooks(result.notebooks);
      if (!draftRef.current.notebookId && result.notebooks[0]) update({ ...draftRef.current, notebookId: result.notebooks[0].id });
    }).catch(e => { if (!stopped) setError((e as Error).message); }).finally(() => { if (!stopped) setNotebooksLoading(false); });
    return () => { stopped = true; };
  }, [noteOpen, wsId]);

  // 缓存受限时至少阻止无意刷新；网络失败从不清空输入。
  useEffect(() => {
    if (!draft.text) return;
    const warn = (event: BeforeUnloadEvent) => { if (saving.current || storageError) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft.text, storageError]);

  async function save(kind: CaptureKind) {
    if (saving.current || !draftRef.current.text.trim()) return;
    if (kind === "note" && !draftRef.current.notebookId) { setError("请选择一本笔记本"); return; }
    saving.current = true;
    setBusy(true);
    setError("");
    let current = { ...draftRef.current, kind, noteId: draftRef.current.kind === kind ? draftRef.current.noteId : undefined };
    update(current);
    try {
      let noteId = current.noteId;
      if (kind === "task") {
        const dueAt = captureWallToIso(new Date(`${date}T23:59:00Z`), timezone);
        await api(`/api/v1/workspaces/${wsId}/calendar/items`, { method: "POST", body: JSON.stringify(captureTaskBody(current.text, dueAt, timezone)) });
      } else {
        if (!noteId) {
          if (kind === "journal") {
            const result = await api<{ noteId: string }>(`/api/v1/workspaces/${wsId}/calendar/diary`, { method: "POST", body: JSON.stringify({ date }) });
            noteId = result.noteId;
          } else {
            const result = await api<{ id: string }>("/api/v1/notes", { method: "POST", body: JSON.stringify({ notebookId: current.notebookId, title: current.text.trim().split(/\r?\n/)[0].slice(0, 200) }) });
            noteId = result.id;
          }
          // 先保住已创建的目标，第二步失败后重试仍写同一篇，不再造空笔记。
          current = { ...current, noteId };
          update(current);
        }
        await appendCapturedNote(api, noteId, current.text, current.id);
      }
      update(emptyDraft(current.notebookId));
      setNoteOpen(false);
      const label = kind === "task" ? "已加入今天的任务" : kind === "journal" ? "已追加到今天的日记" : "已保存笔记";
      if (noteId) toast.toast({ title: label, description: <button className="min-h-11 underline underline-offset-2" onClick={() => onOpenNote(noteId)}>打开笔记</button> });
      else toast.success(label);
      onCreated();
    } catch (e) {
      setError(`${(e as Error).message}。内容仍在，可重试`);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return <footer className="sticky bottom-0 z-30 shrink-0 border-t border-border bg-background px-3 pt-3 pb-[max(.75rem,env(safe-area-inset-bottom))]" aria-label="随手记">
    <div className="mx-auto max-w-4xl space-y-2">
      <Textarea aria-label="随手记内容" placeholder="随手记，然后选任务、日记或笔记…" rows={2} value={draft.text} disabled={busy} className="min-h-16 max-h-28 resize-y text-base" onChange={e => {
        update({ ...draftRef.current, id: crypto.randomUUID(), text: e.target.value });
        setError("");
      }} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void save("task"); } }} />
      <div className="grid grid-cols-3 gap-2">
        <Button className="min-h-11 px-2" disabled={busy || !draft.text.trim()} onClick={() => void save("task")}><CheckSquare />任务</Button>
        <Button className="min-h-11 px-2" variant="outline" disabled={busy || !draft.text.trim()} onClick={() => void save("journal")}><PenLine />日记</Button>
        <Button className="min-h-11 px-2" variant="outline" disabled={busy || !draft.text.trim()} onClick={() => { setError(""); setNoteOpen(true); }}><FileText />笔记</Button>
      </div>
      <p className="text-xs text-muted-foreground" role="status">{busy ? "正在保存，请稍候…" : "任务加入今天 · 日记追加原文 · 笔记选择笔记本"}</p>
      {!noteOpen && <FormError>{error}</FormError>}
      {storageError && <FormError>浏览器无法保存草稿，请保存后再离开此页</FormError>}
    </div>
    <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
      <DialogContent className="[&>button]:min-h-11 [&>button]:min-w-11">
        <DialogHeader><DialogTitle>存为笔记</DialogTitle><DialogDescription>全文会保留在笔记正文中。保存失败时草稿仍保留在这里。</DialogDescription></DialogHeader>
        <label className="space-y-2 text-sm">笔记本
          <select aria-label="保存到笔记本" className="mt-2 block min-h-11 w-full rounded-lg border border-border bg-background px-3" value={draft.notebookId} disabled={busy || notebooksLoading || !!draft.noteId && draft.kind === "note"} onChange={e => update({ ...draftRef.current, notebookId: e.target.value })}>
            <option value="">{notebooksLoading ? "正在加载…" : "选择笔记本"}</option>
            {notebooks.map(nb => <option key={nb.id} value={nb.id}>{nb.title}</option>)}
          </select>
        </label>
        {!notebooksLoading && !notebooks.length && <p className="text-sm text-muted-foreground">还没有可用的笔记本，请先到笔记页创建一本。速记内容会留在这里。</p>}
        <FormError>{error}</FormError>
        <Button className="min-h-11" disabled={busy || notebooksLoading || !draft.notebookId} onClick={() => void save("note")}>{busy ? "正在保存…" : "保存笔记"}</Button>
      </DialogContent>
    </Dialog>
  </footer>;
}
