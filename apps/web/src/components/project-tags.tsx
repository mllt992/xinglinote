import { useState, type FormEvent } from "react";
import { Tag as TagIcon, X } from "lucide-react";
import { cn } from "../lib/utils";
import { type Milestone, type ProjectTag, type Task, COLOR_DOT, isoDate } from "./project-model";
import { Button } from "./ui/button";
import { useConfirm, usePrompt } from "./ui/confirm";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

const COLORS = ["ink", "accent", "good", "warn", "muted"] as const;

export function TagChips({ tags, className }: { tags: ProjectTag[]; className?: string }) {
  if (!tags.length) return null;
  return <div className={cn("flex flex-wrap gap-1", className)}>
    {tags.map(tag => <span key={tag.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", COLOR_DOT[tag.color])} />
      {tag.name}
    </span>)}
  </div>;
}

export function TaskTagFields({
  tags, selectedIds, milestones, milestoneId, canEdit, onToggleTag, onMilestone,
}: {
  tags: ProjectTag[]; selectedIds: string[];
  milestones: Milestone[]; milestoneId: string | null;
  canEdit: boolean;
  onToggleTag: (tagId: string, on: boolean) => void | Promise<void>;
  onMilestone: (milestoneId: string | null) => void | Promise<void>;
}) {
  return <div className="grid gap-2">
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">里程碑</span>
      <select
        className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
        value={milestoneId ?? ""}
        disabled={!canEdit}
        onChange={e => void onMilestone(e.target.value || null)}
      >
        <option value="">不挂里程碑</option>
        {milestones.map(m => <option key={m.id} value={m.id}>{m.title} · {isoDate(m.dueAt)}</option>)}
      </select>
    </label>
    {!!tags.length && <div>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">标签</p>
      <div className="flex flex-wrap gap-1.5">
        {tags.map(tag => {
          const on = selectedIds.includes(tag.id);
          return <button
            type="button"
            key={tag.id}
            disabled={!canEdit}
            onClick={() => void onToggleTag(tag.id, !on)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
              on ? "border-foreground/40 bg-muted" : "border-border text-muted-foreground",
            )}
          >
            <span className={cn("size-1.5 rounded-full", COLOR_DOT[tag.color])} />
            {tag.name}
          </button>;
        })}
      </div>
    </div>}
  </div>;
}

export function TagManagerDialog({
  open, tags, canEdit, onOpenChange, onCreate, onRename, onRecolor, onDelete,
}: {
  open: boolean; tags: ProjectTag[]; canEdit: boolean;
  onOpenChange: (v: boolean) => void;
  onCreate: (name: string, color: ProjectTag["color"]) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onRecolor: (id: string, color: ProjectTag["color"]) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const ask = useConfirm();
  const askPrompt = usePrompt();
  const [name, setName] = useState("");
  const [color, setColor] = useState<ProjectTag["color"]>("ink");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    const next = name.trim();
    if (!next || !canEdit || busy) return;
    setBusy(true); setErr("");
    try {
      await onCreate(next, color);
      setName("");
    } catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader>
      <DialogTitle>标签</DialogTitle>
      <DialogDescription>给本项目的任务打标签。不是第二个 Jira，一项目几十个就够。</DialogDescription>
    </DialogHeader>
    {canEdit && <form className="flex flex-wrap items-center gap-2" onSubmit={submit}>
      <Input value={name} onChange={e => setName(e.target.value)} placeholder="新标签名" className="min-w-0 flex-1" disabled={busy} />
      <div className="flex gap-1">{COLORS.map(c => <button type="button" key={c} onClick={() => setColor(c)} className={cn("size-5 rounded-full", COLOR_DOT[c], color === c && "ring-2 ring-offset-2 ring-foreground")} aria-label={c} />)}</div>
      <Button type="submit" size="sm" disabled={busy || !name.trim()}>加上</Button>
    </form>}
    {err && <p className="text-sm text-destructive">{err}</p>}
    <ul className="max-h-64 space-y-1 overflow-y-auto">
      {tags.map(tag => <li key={tag.id} className="flex items-center gap-2 rounded-md px-1 py-1">
        <span className={cn("size-2.5 rounded-full", COLOR_DOT[tag.color])} />
        <span className="min-w-0 flex-1 truncate text-sm">{tag.name}</span>
        {canEdit && <>
          <div className="flex gap-0.5">{COLORS.map(c => <button type="button" key={c} onClick={() => void onRecolor(tag.id, c)} className={cn("size-3.5 rounded-full", COLOR_DOT[c], tag.color === c && "ring-1 ring-foreground")} aria-label={`设为 ${c}`} />)}</div>
          <Button type="button" size="sm" variant="ghost" onClick={async () => {
            const next = await askPrompt({ title: "改标签名", label: "名称", defaultValue: tag.name, confirmText: "保存" });
            if (!next?.trim() || next.trim() === tag.name) return;
            await onRename(tag.id, next.trim());
          }}>改名</Button>
          <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`删除 ${tag.name}`} onClick={async () => {
            if (!await ask({ title: `删除标签「${tag.name}」？`, description: "打在任务上的会一起摘掉，标签本身删掉。", confirmText: "删除", destructive: true })) return;
            await onDelete(tag.id);
          }}><X className="size-3.5" /></Button>
        </>}
      </li>)}
      {!tags.length && <p className="px-1 py-2 text-xs text-muted-foreground">还没有标签。{canEdit ? "上面起一个。" : ""}</p>}
    </ul>
  </DialogContent></Dialog>;
}

export function TagFilter({ tags, value, onChange }: { tags: ProjectTag[]; value: string | null; onChange: (id: string | null) => void }) {
  if (!tags.length) return null;
  return <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
    <TagIcon className="size-3.5 text-muted-foreground" />
    <button type="button" onClick={() => onChange(null)} className={cn("rounded-full px-2 py-0.5 text-[11px]", !value ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted")}>全部</button>
    {tags.map(tag => <button type="button" key={tag.id} onClick={() => onChange(value === tag.id ? null : tag.id)} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]", value === tag.id ? "border-foreground/40 bg-muted" : "border-border text-muted-foreground")}>
      <span className={cn("size-1.5 rounded-full", COLOR_DOT[tag.color])} />{tag.name}
    </button>)}
  </div>;
}

export function tasksOfMilestone(tasks: Task[], milestoneId: string) {
  return tasks.filter(t => t.milestoneId === milestoneId);
}
