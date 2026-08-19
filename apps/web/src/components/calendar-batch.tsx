import { useCallback, useEffect, useState } from "react";
import { CalendarPlus, Check, ChevronRight, Layers, Trash2, Undo2, X } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { useConfirm } from "./ui/confirm";
import { FormError } from "./ui/form-error";
import { Input } from "./ui/input";
import { useToast } from "./ui/toast";

export type BatchAction = "complete" | "reopen" | "shift" | "setDue" | "assign" | "priority" | "trash";
export type BatchPayload = { action: BatchAction; days?: number; dueAt?: string | null; assigneeUserId?: string | null; priority?: number };
type Member = { userId: string; displayName: string; handle: string };

export type Template = {
  id: string; name: string; description: string | null; scope: "workspace" | "private";
  itemCount: number; mine: boolean;
  items: Array<{ kind: "task" | "event"; title: string; offsetDays: number; startMin: number | null; durationMin: number | null; priority: number }>;
};

const fmtMin = (m: number | null) => (m == null ? "全天" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);

/**
 * 多选后顶掉面板标题的那条工具栏（设计 16 §3.11）。
 * 每个动作都是一次批量请求，服务端逐条鉴权、允许部分成功，所以这里不做前置过滤，
 * 让人自己看结果里哪几条没动——前端猜「这条大概没权限」只会猜错。
 */
export function BatchBar({ count, recurring, members, canAssign, onAction, onSaveTemplate, onClear }: {
  count: number;
  /** 选中里有几条是重复条目：批量只作用于整条序列，得说清楚。 */
  recurring: number;
  members: Member[];
  canAssign: boolean;
  onAction: (payload: BatchPayload, label: string) => void | Promise<void>;
  onSaveTemplate: () => void;
  onClear: () => void;
}) {
  const [menu, setMenu] = useState<"" | "due" | "assign" | "priority">("");
  const [date, setDate] = useState("");

  return <div className="border-b border-border bg-primary/5 px-3 py-2">
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs font-medium">已选 {count} 项</span>
      <Button size="sm" variant="outline" onClick={() => void onAction({ action: "complete" }, `已完成 ${count} 项`)}><Check />完成</Button>
      <Button size="sm" variant="ghost" onClick={() => void onAction({ action: "reopen" }, `已重开 ${count} 项`)}><Undo2 />重开</Button>
      <Button size="sm" variant="ghost" onClick={() => void onAction({ action: "shift", days: 1 }, `已推后 1 天：${count} 项`)}>+1 天</Button>
      <Button size="sm" variant="ghost" onClick={() => void onAction({ action: "shift", days: 7 }, `已推后 7 天：${count} 项`)}>+7 天</Button>
      <Button size="sm" variant={menu === "due" ? "secondary" : "ghost"} onClick={() => setMenu(m => (m === "due" ? "" : "due"))}>指定日期</Button>
      <Button size="sm" variant={menu === "priority" ? "secondary" : "ghost"} onClick={() => setMenu(m => (m === "priority" ? "" : "priority"))}>优先级</Button>
      {canAssign && <Button size="sm" variant={menu === "assign" ? "secondary" : "ghost"} onClick={() => setMenu(m => (m === "assign" ? "" : "assign"))}>指派</Button>}
      <Button size="sm" variant="ghost" onClick={onSaveTemplate}><Layers />存为模板</Button>
      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void onAction({ action: "trash" }, `已删除 ${count} 项`)}><Trash2 />删除</Button>
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear} aria-label="退出多选"><X />退出多选</Button>
    </div>

    {menu === "due" && <div className="mt-2 flex flex-wrap items-center gap-2">
      <Input type="date" className="h-8 w-40" value={date} onChange={e => setDate(e.target.value)} aria-label="改到哪一天" />
      <Button size="sm" disabled={!date} onClick={() => { setMenu(""); void onAction({ action: "setDue", dueAt: new Date(`${date}T09:00:00`).toISOString() }, `已改到 ${date}：${count} 项`); }}>改期</Button>
      <Button size="sm" variant="ghost" onClick={() => { setMenu(""); void onAction({ action: "setDue", dueAt: null }, `已清掉期限：${count} 项`); }}>清除期限（回收件箱）</Button>
    </div>}

    {menu === "priority" && <div className="mt-2 flex flex-wrap gap-1.5">
      {([["高", 3], ["中", 2], ["低", 1], ["无", 0]] as const).map(([label, p]) =>
        <Button key={p} size="sm" variant="ghost" onClick={() => { setMenu(""); void onAction({ action: "priority", priority: p }, `已设为${label}优先级：${count} 项`); }}>{label}</Button>)}
    </div>}

    {menu === "assign" && <div className="mt-2 flex flex-wrap gap-1.5">
      {members.map(m => <Button key={m.userId} size="sm" variant="ghost" onClick={() => { setMenu(""); void onAction({ action: "assign", assigneeUserId: m.userId }, `已指派给 ${m.displayName}：${count} 项`); }}>{m.displayName}</Button>)}
      <Button size="sm" variant="ghost" onClick={() => { setMenu(""); void onAction({ action: "assign", assigneeUserId: null }, `已取消指派：${count} 项`); }}>不指派</Button>
    </div>}

    {recurring > 0 && <p className="mt-2 text-[11px] text-muted-foreground">
      其中 {recurring} 条是重复条目，批量会作用到<strong className="font-medium text-foreground">整条序列</strong>。只改某一次请单独操作那一条。
    </p>}
  </div>;
}

/** 存为模板：只问名字、说明和范围，条目由服务端按选中的那几条折算成相对偏移。 */
export function SaveTemplateDialog({ wsId, itemIds, canShare, onDone, onClose }: {
  wsId: string; itemIds: string[]; canShare: boolean; onDone: () => void; onClose: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<"private" | "workspace">("private");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); setErr("");
    try {
      await api(`/api/v1/workspaces/${wsId}/calendar/templates`, { method: "POST", body: JSON.stringify({ name, description: description || null, scope, fromItemIds: itemIds }) });
      toast.success("模板已保存", `${itemIds.length} 条，按相对天数存的，可以套到任意一天。`);
      onDone();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="grid gap-3">
    <p className="text-xs text-muted-foreground">会把选中的 {itemIds.length} 条折算成相对结构：最早的那天算第 0 天，其余按差几天记。绝对日期不会存进去。</p>
    <label className="grid gap-1.5">
      <span className="text-xs font-medium">模板名</span>
      <Input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="例如：出差三天" />
    </label>
    <label className="grid gap-1.5">
      <span className="text-xs font-medium">说明（可选）</span>
      <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="什么时候用它" />
    </label>
    {canShare && <label className="flex items-center gap-2 text-xs">
      <input type="checkbox" className="size-3.5 accent-[var(--foreground)]" checked={scope === "workspace"} onChange={e => setScope(e.target.checked ? "workspace" : "private")} />
      整个工作区都能用（否则只有你自己看得到）
    </label>}
    <FormError>{err}</FormError>
    <div className="flex justify-end gap-2">
      <Button variant="ghost" onClick={onClose}>取消</Button>
      <Button disabled={busy || !name.trim() || !itemIds.length} onClick={() => void save()}>保存模板</Button>
    </div>
  </div>;
}

type Preview = { date: string; items: Array<{ kind: string; title: string; day: string; allDay: boolean }> };

/** 面板里的模板页签：列出来、套到某一天、删掉。套用前一律先预览，确认才写库。 */
export function TemplatePanel({ wsId, narrow, canEdit, today, onApplied, onClose }: {
  wsId: string; narrow: boolean; canEdit: boolean; today: string;
  onApplied: () => void; onClose: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string>("");
  const [date, setDate] = useState(today);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setTemplates((await api<{ templates: Template[] }>(`/api/v1/workspaces/${wsId}/calendar/templates`)).templates); setError(""); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [wsId]);
  useEffect(() => { void load(); }, [load]);

  async function loadPreview(id: string, day: string) {
    setBusy(true);
    try { setPreview(await api<Preview>(`/api/v1/calendar/templates/${id}/apply`, { method: "POST", body: JSON.stringify({ date: day, preview: true }) })); }
    catch (e) { toast.error("算不出来", (e as Error).message); setPreview(null); }
    finally { setBusy(false); }
  }

  async function apply(t: Template) {
    setBusy(true);
    try {
      const r = await api<{ items: unknown[] }>(`/api/v1/calendar/templates/${t.id}/apply`, { method: "POST", body: JSON.stringify({ date }) });
      toast.success(`已套用「${t.name}」`, `落了 ${r.items.length} 条，从 ${date} 起。`);
      setOpen(""); setPreview(null);
      onApplied();
    } catch (e) { toast.error("套用失败", (e as Error).message); }
    finally { setBusy(false); }
  }

  async function remove(t: Template) {
    if (!await confirm({ title: `删除模板「${t.name}」？`, description: "已经套用出去的条目不受影响，它们和模板本来就没有关联。", confirmText: "删除", destructive: true })) return;
    try {
      await api(`/api/v1/calendar/templates/${t.id}`, { method: "DELETE" });
      setTemplates(list => list.filter(x => x.id !== t.id));   // 就地撤行，不重拉整张列表
    } catch (e) { toast.error("删除失败", (e as Error).message); }
  }

  return <aside className={cn("flex min-h-0 shrink-0 flex-col border-l border-border", narrow ? "w-full" : "w-80")}>
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
      <Layers className="size-4 text-muted-foreground" />
      <span className="text-sm font-medium">模板</span>
      <Button variant="ghost" size="sm" className="ml-auto" onClick={onClose} aria-label="关闭模板面板"><X /></Button>
    </header>

    <div className="min-h-0 flex-1 overflow-auto p-3">
      {error && <FormError>{error}</FormError>}
      {loading && <p className="py-8 text-center text-xs text-muted-foreground">正在读…</p>}
      {!loading && !templates.length && <div className="py-10 text-center">
        <p className="text-sm font-medium">还没有模板</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">在日历上多选一组条目（按住 Ctrl/⌘ 点），再点「存为模板」。下次一键套到任意一天。</p>
      </div>}

      {templates.map(t => <div key={t.id} className="mb-2 rounded-lg border border-border">
        <button className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => { setOpen(o => (o === t.id ? "" : t.id)); setPreview(null); }}>
          <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition", open === t.id && "rotate-90")} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{t.name}</span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {t.itemCount} 条 · {t.scope === "workspace" ? "工作区共用" : "仅自己"}{t.description ? ` · ${t.description}` : ""}
            </span>
          </span>
        </button>

        {open === t.id && <div className="border-t border-border px-3 py-2">
          <ul className="mb-2 grid gap-0.5">
            {t.items.slice(0, 8).map((it, i) => <li key={i} className="flex items-baseline gap-2 text-[11px] text-muted-foreground">
              <span className="tabular-nums">第 {it.offsetDays + 1} 天</span>
              <span className="tabular-nums">{fmtMin(it.startMin)}</span>
              <span className="truncate text-foreground">{it.title}</span>
            </li>)}
            {t.items.length > 8 && <li className="text-[11px] text-muted-foreground">还有 {t.items.length - 8} 条…</li>}
          </ul>

          {canEdit && <div className="flex flex-wrap items-center gap-2">
            <Input type="date" className="h-8 w-36" value={date} onChange={e => { setDate(e.target.value); setPreview(null); }} aria-label="从哪一天开始" />
            <Button size="sm" variant="outline" disabled={busy || !date} onClick={() => void loadPreview(t.id, date)}>预览</Button>
            <Button size="sm" disabled={busy || !date || !preview} onClick={() => void apply(t)}><CalendarPlus />套用</Button>
            {t.mine && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void remove(t)}><Trash2 /></Button>}
          </div>}

          {preview && open === t.id && <ul className="mt-2 grid gap-0.5 rounded-md bg-muted/40 p-2">
            {preview.items.map((it, i) => <li key={i} className="flex items-baseline gap-2 text-[11px]">
              <span className="tabular-nums text-muted-foreground">{it.day}</span>
              <span className="truncate">{it.title}</span>
            </li>)}
            <li className="mt-1 text-[11px] text-muted-foreground">确认无误再点「套用」。落地后就和模板没关系了，改模板不会回头改它们。</li>
          </ul>}
        </div>}
      </div>)}
    </div>
  </aside>;
}
