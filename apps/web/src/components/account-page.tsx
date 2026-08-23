import { useCallback, useEffect, useState } from "react";
import { HardDrive, Inbox, Send } from "lucide-react";
import { api } from "../api";
import { formatBytes, presetLabel, STORAGE_PRESETS, usagePercent } from "../lib/bytes";
import { cn } from "../lib/utils";
import { EmptyState, Field, SectionCard, SettingsShell } from "./settings-shell";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useConfirm } from "./ui/confirm";
import { FormError } from "./ui/form-error";
import { Textarea } from "./ui/textarea";
import { useToast } from "./ui/toast";

export type ServiceRequest = {
  id: string;
  kind: string;
  requestedBytes: number | null;
  currentQuotaBytes: number | null;
  usedBytes: number | null;
  reason: string | null;
  status: string;
  adminNote: string | null;
  grantedQuotaBytes: number | null;
  createdAt: string;
  decidedAt: string | null;
};

type StorageMe = {
  usedBytes: number;
  quotaBytes: number;
  remainingBytes: number;
  noteBytes: number;
  attachmentBytes: number;
  quotaOverride: boolean;
  defaultQuotaBytes: number;
  canRequest: boolean;
  requestClosedReason?: string;
  pendingRequest: ServiceRequest | null;
};

const STATUS: Record<string, string> = {
  pending: "待审批", approved: "已通过", rejected: "未通过", cancelled: "已取消",
};

function tone(status: string) {
  if (status === "approved") return "border-transparent bg-[color-mix(in_srgb,var(--good)_12%,transparent)] text-[var(--good)]";
  if (status === "rejected") return "border-transparent bg-destructive/10 text-destructive";
  if (status === "pending") return "border-transparent bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)]";
  return undefined;
}

export function AccountPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [storage, setStorage] = useState<StorageMe | null>(null);
  const [history, setHistory] = useState<ServiceRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [requested, setRequested] = useState<number>(5_368_709_120);
  const [customGb, setCustomGb] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState("");

  const load = useCallback(async () => {
    const [s, h] = await Promise.all([
      api<StorageMe>("/api/v1/me/storage"),
      api<{ requests: ServiceRequest[] }>("/api/v1/me/service-requests"),
    ]);
    setStorage(s);
    setHistory(h.requests);
    const next = STORAGE_PRESETS.find(o => o.value > s.quotaBytes)?.value ?? s.quotaBytes * 2;
    setRequested(next);
  }, []);
  const reload = useCallback(() => {
    setLoading(true);
    load().then(() => setError("")).catch(e => setError((e as Error).message)).finally(() => setLoading(false));
  }, [load]);
  useEffect(() => { reload(); }, [reload]);

  const chosen = customGb.trim() ? Math.round(Number(customGb) * 1_073_741_824) : requested;
  const pct = storage ? usagePercent(storage.usedBytes, storage.quotaBytes) : 0;

  async function submit() {
    setFormErr("");
    if (!Number.isFinite(chosen) || chosen <= 0) { setFormErr("请填写有效的容量"); return; }
    setBusy(true);
    try {
      await api("/api/v1/me/service-requests", {
        method: "POST",
        body: JSON.stringify({ kind: "storage", requestedBytes: chosen, reason: reason.trim() || null }),
      });
      toast.success("申请已提交", "管理员处理完后会通知你。");
      setReason("");
      setCustomGb("");
      await load();
    } catch (e) {
      setFormErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    if (!await confirm({ title: "取消这条申请？", description: "取消后可以再提一条新的。", confirmText: "取消申请" })) return;
    try {
      await api(`/api/v1/me/service-requests/${id}`, { method: "DELETE" });
      toast.success("已取消申请");
      await load();
    } catch (e) {
      toast.error("取消失败", (e as Error).message);
    }
  }

  return <SettingsShell current="account" loading={loading} error={error} onRetry={reload}>
    <div className="space-y-4">
      <SectionCard icon={<HardDrive className="size-4" />} title="存储空间"
        desc={storage?.quotaOverride ? "管理员为你单独分配的配额。" : `跟随实例默认（${presetLabel(storage?.defaultQuotaBytes ?? 0)}）。`}>
        {storage && <div className="space-y-4 p-4">
          <div>
            <div className="mb-1.5 flex justify-between text-sm">
              <span>已用 {formatBytes(storage.usedBytes)}</span>
              <span className="text-muted-foreground">共 {formatBytes(storage.quotaBytes)}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className={cn("h-full rounded-full", pct >= 90 ? "bg-destructive" : pct >= 80 ? "bg-[var(--warning)]" : "bg-primary")}
                style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">还剩 {formatBytes(storage.remainingBytes)}
              {pct >= 80 ? " · 快满了，申请扩容或删掉回收站里的东西。" : ""}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border px-3 py-2.5">
              <p className="text-xs text-muted-foreground">笔记正文</p>
              <p className="mt-0.5 text-sm font-medium">{formatBytes(storage.noteBytes)}</p>
            </div>
            <div className="rounded-lg border border-border px-3 py-2.5">
              <p className="text-xs text-muted-foreground">附件与动态文件</p>
              <p className="mt-0.5 text-sm font-medium">{formatBytes(storage.attachmentBytes)}</p>
            </div>
          </div>
        </div>}
      </SectionCard>

      {storage?.pendingRequest && <SectionCard icon={<Inbox className="size-4" />} title="待审批的申请"
        desc="管理员处理前你可以取消。"
        action={<Button variant="outline" size="sm" onClick={() => void cancel(storage.pendingRequest!.id)}>取消申请</Button>}>
        <div className="px-4 py-3 text-sm">
          申请把配额调到 <span className="font-medium">{formatBytes(storage.pendingRequest.requestedBytes ?? 0)}</span>
          {storage.pendingRequest.reason ? <p className="mt-1 text-xs text-muted-foreground">{storage.pendingRequest.reason}</p> : null}
          <p className="mt-1 text-xs text-muted-foreground">{new Date(storage.pendingRequest.createdAt).toLocaleString()} 提交</p>
        </div>
      </SectionCard>}

      <SectionCard icon={<Send className="size-4" />} title="申请扩容" desc="发给本实例的管理员。通过后立刻生效，没有付款这一步。">
        {!storage?.canRequest && !storage?.pendingRequest
          ? <p className="px-4 py-8 text-center text-sm text-muted-foreground">{storage?.requestClosedReason ?? "暂时不能申请。"}</p>
          : storage?.pendingRequest
            ? <p className="px-4 py-8 text-center text-sm text-muted-foreground">等当前这条批完，才能再提新的。</p>
            : <div className="space-y-4 p-4">
              <Field label="想要的总容量">
                <div className="flex flex-wrap gap-2">
                  {STORAGE_PRESETS.filter(o => !storage || o.value > storage.quotaBytes).map(o => (
                    <button key={o.value} type="button" aria-pressed={!customGb && requested === o.value}
                      onClick={() => { setRequested(o.value); setCustomGb(""); }}
                      className={cn("rounded-lg border border-border px-3 py-1.5 text-sm outline-none hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring/50",
                        !customGb && requested === o.value && "border-primary ring-2 ring-primary/10")}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="或自定义（GB）" hint="填写想要的总配额，不是增量。">
                <input type="number" min={1} max={1024} step={1} value={customGb}
                  onChange={e => setCustomGb(e.target.value)}
                  className="h-9 w-full max-w-40 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
                  placeholder="例如 8" />
              </Field>
              <Field label="说明（可选）" hint="告诉管理员为什么需要这么多，比如要存扫描件、家庭影像。">
                <Textarea value={reason} maxLength={500} onChange={e => setReason(e.target.value)} placeholder="可空" />
              </Field>
              <FormError>{formErr}</FormError>
              <Button disabled={busy} onClick={() => void submit()}>
                {busy ? "提交中…" : `申请 ${formatBytes(Number.isFinite(chosen) ? chosen : 0)}`}
              </Button>
            </div>}
      </SectionCard>

      <SectionCard title="申请记录" desc="最近 50 条。">
        {history.length === 0
          ? <EmptyState icon={<Inbox />} title="还没有申请" text="空间不够时在上面提交，管理员会在站内通知你。" />
          : history.map((r, i) => <div key={r.id} className={cn("flex flex-wrap items-start gap-3 px-4 py-3", i && "border-t border-border")}>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">扩容到 {formatBytes(r.requestedBytes ?? 0)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {new Date(r.createdAt).toLocaleString()}
                {r.grantedQuotaBytes != null && r.status === "approved" ? ` · 实际给了 ${formatBytes(r.grantedQuotaBytes)}` : ""}
              </p>
              {r.reason && <p className="mt-1 text-xs text-muted-foreground">{r.reason}</p>}
              {r.adminNote && r.status === "rejected" && <p className="mt-1 text-xs text-destructive">{r.adminNote}</p>}
              {r.adminNote && r.status === "approved" && <p className="mt-1 text-xs text-muted-foreground">{r.adminNote}</p>}
            </div>
            <Badge className={tone(r.status)}>{STATUS[r.status] ?? r.status}</Badge>
          </div>)}
      </SectionCard>
    </div>
  </SettingsShell>;
}
