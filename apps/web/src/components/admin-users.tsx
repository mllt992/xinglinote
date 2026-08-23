import { useEffect, useState, type ReactNode } from "react";
import * as Avatar from "@radix-ui/react-avatar";
import { Ban, HardDrive, MoreHorizontal, UserCog } from "lucide-react";
import { api } from "../api";
import { formatBytes, presetLabel, STORAGE_PRESETS, usagePercent } from "../lib/bytes";
import { cn } from "../lib/utils";
import type { ServiceRequest } from "./account-page";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useConfirm } from "./ui/confirm";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { FormError } from "./ui/form-error";
import { Textarea } from "./ui/textarea";
import { useToast } from "./ui/toast";

export type AdminUser = {
  id: string;
  displayName: string;
  email: string;
  handle: string;
  roleInstance: string;
  status: string;
  createdAt?: string;
  storageQuotaBytes?: number | null;
  storage?: {
    usedBytes: number;
    quotaBytes: number;
    remainingBytes: number;
    noteBytes: number;
    attachmentBytes: number;
    quotaOverride: boolean;
    defaultQuotaBytes: number;
  } | null;
  pendingRequest?: { id: string; kind: string; requestedBytes: number | null; createdAt: string } | null;
};

export type AdminRequest = ServiceRequest & {
  user?: { id: string; displayName: string; handle: string; email: string };
};

const STATUS_LABEL: Record<string, string> = {
  active: "正常", banned: "已封禁", pending_deletion: "注销中", pending_verification: "待验证",
  admin: "管理员", user: "成员", pending: "待审批", approved: "已通过", rejected: "未通过", cancelled: "已取消",
};

export function statusTone(status: string) {
  if (status === "active" || status === "admin" || status === "approved") return "border-transparent bg-[color-mix(in_srgb,var(--good)_12%,transparent)] text-[var(--good)]";
  if (status === "banned" || status === "revoked" || status === "rejected") return "border-transparent bg-destructive/10 text-destructive";
  if (status === "pending_deletion" || status === "exhausted" || status === "expired" || status === "pending") return "border-transparent bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)]";
  return undefined;
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge className={statusTone(status)}>{STATUS_LABEL[status] ?? status}</Badge>;
}

export function StorageBar({ used, quota, compact }: { used: number; quota: number; compact?: boolean }) {
  const pct = usagePercent(used, quota);
  return <div className={cn("min-w-0", compact ? "w-28" : "w-full")}>
    <div className={cn("mb-1 flex justify-between text-muted-foreground", compact ? "text-[10px]" : "text-xs")}>
      <span className="tabular-nums">{formatBytes(used)}</span>
      <span className="tabular-nums">{formatBytes(quota)}</span>
    </div>
    <div className={cn("overflow-hidden rounded-full bg-muted", compact ? "h-1" : "h-1.5")}>
      <div className={cn("h-full rounded-full", pct >= 90 ? "bg-destructive" : pct >= 80 ? "bg-[var(--warning)]" : "bg-primary")}
        style={{ width: `${pct}%` }} />
    </div>
  </div>;
}

export function UserRow({ user, extra }: { user: AdminUser; extra?: ReactNode }) {
  return <div className="flex min-w-0 flex-1 items-center gap-3">
    <Avatar.Root className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-xs font-semibold text-background">
      <Avatar.Fallback>{user.displayName.slice(0, 1)}</Avatar.Fallback>
    </Avatar.Root>
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-medium">{user.displayName} <span className="font-normal text-muted-foreground">@{user.handle}</span></p>
      <p className="truncate text-xs text-muted-foreground">{user.email}</p>
    </div>
    {extra}
    {user.pendingRequest && <Badge className={statusTone("pending")}>待审批</Badge>}
    <StatusBadge status={user.roleInstance} />
    <StatusBadge status={user.status} />
  </div>;
}

export function UserActions({ user, onChanged, onOpen }: { user: AdminUser; onChanged: () => void; onOpen: () => void }) {
  const toast = useToast();
  const askConfirm = useConfirm();
  async function patch(body: Record<string, string>, okText: string) {
    try {
      await api(`/api/v1/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify(body) });
      toast.success(okText);
      onChanged();
    } catch (e) {
      toast.error("操作失败", (e as Error).message);
    }
  }
  return <div className="flex shrink-0 items-center gap-1">
    <Button variant="ghost" size="sm" onClick={onOpen}>详情</Button>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`${user.displayName} 的操作`}><MoreHorizontal /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => {
          void (async () => {
            const promote = user.roleInstance !== "admin";
            if (!await askConfirm({
              title: promote ? `将 ${user.displayName} 提升为管理员？` : `将 ${user.displayName} 降为普通用户？`,
              description: promote ? "对方将能进入实例后台，管理注册策略、用户配额和所有用户。" : "对方将失去实例后台权限。实例必须至少保留一名有效管理员。",
              confirmText: promote ? "提升" : "降级",
              destructive: !promote,
            })) return;
            await patch({ roleInstance: promote ? "admin" : "user" }, promote ? "已提升为管理员" : "已降为普通用户");
          })();
        }}><UserCog />{user.roleInstance === "admin" ? "降为普通用户" : "提升为管理员"}</DropdownMenuItem>
        <DropdownMenuItem className="text-destructive" onSelect={() => {
          void (async () => {
            const ban = user.status !== "banned";
            if (!await askConfirm({
              title: ban ? `封禁 ${user.displayName}？` : `解除 ${user.displayName} 的封禁？`,
              description: ban ? "对方会立刻被踢下线，无法再登录。其写过的共享笔记会留下。" : "对方可以重新登录，会话需要重新建立。",
              confirmText: ban ? "封禁" : "解封",
              destructive: ban,
            })) return;
            await patch({ status: ban ? "banned" : "active" }, ban ? "已封禁并踢出会话" : "已解除封禁");
          })();
        }}><Ban />{user.status === "banned" ? "解除封禁" : "封禁并踢出会话"}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}

/** 详情里分配配额、批申请，避免在长列表里塞表单。 */
export function UserDetailDialog({ userId, open, onOpenChange, onChanged }: {
  userId: string | null; open: boolean; onOpenChange: (v: boolean) => void; onChanged: () => void;
}) {
  const toast = useToast();
  const [detail, setDetail] = useState<{ user: AdminUser; storage: NonNullable<AdminUser["storage"]>; requests: ServiceRequest[] } | null>(null);
  const [err, setErr] = useState("");
  const [quota, setQuota] = useState<number | "default" | "custom">("default");
  const [customGb, setCustomGb] = useState("");
  const [busy, setBusy] = useState(false);

  async function load(id: string) {
    setErr("");
    try {
      const d = await api<{ user: AdminUser; storage: NonNullable<AdminUser["storage"]>; requests: ServiceRequest[] }>(`/api/v1/admin/users/${id}`);
      setDetail(d);
      setQuota(d.storage.quotaOverride ? d.storage.quotaBytes : "default");
      setCustomGb("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    if (open && userId) void load(userId);
    if (!open) setDetail(null);
  }, [open, userId]);

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-lg" onOpenAutoFocus={e => e.preventDefault()}>
      <DialogHeader>
        <DialogTitle>{detail?.user.displayName ?? "用户"}</DialogTitle>
        <DialogDescription>{detail ? `@${detail.user.handle} · ${detail.user.email}` : "加载中…"}</DialogDescription>
      </DialogHeader>
      {err && <FormError>{err}</FormError>}
      {detail && <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <StatusBadge status={detail.user.roleInstance} />
          <StatusBadge status={detail.user.status} />
          {detail.storage.quotaOverride && <Badge>单独配额</Badge>}
        </div>
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">存储</p>
          <StorageBar used={detail.storage.usedBytes} quota={detail.storage.quotaBytes} />
          <p className="mt-2 text-xs text-muted-foreground">
            笔记 {formatBytes(detail.storage.noteBytes)} · 附件 {formatBytes(detail.storage.attachmentBytes)}
            {detail.storage.quotaOverride ? "" : ` · 跟随默认 ${presetLabel(detail.storage.defaultQuotaBytes)}`}
          </p>
        </div>
        <div className="grid gap-2">
          <p className="text-xs font-medium text-muted-foreground">分配容量</p>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={quota === "default"} onClick={() => { setQuota("default"); setCustomGb(""); }}>跟随默认</Chip>
            {STORAGE_PRESETS.map(o => <Chip key={o.value} active={quota === o.value} onClick={() => { setQuota(o.value); setCustomGb(""); }}>{o.label}</Chip>)}
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            自定义 GB
            <input type="number" min={1} max={1024} value={customGb} onChange={e => { setCustomGb(e.target.value); setQuota("custom"); }}
              className="h-8 w-24 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/20" />
          </label>
          <Button size="sm" disabled={busy} onClick={() => {
            void (async () => {
              const bytes = quota === "default" ? null
                : quota === "custom" ? Math.round(Number(customGb) * 1_073_741_824)
                  : quota;
              if (bytes !== null && (!Number.isFinite(bytes) || bytes <= 0)) { toast.error("请填写有效容量"); return; }
              setBusy(true);
              try {
                await api(`/api/v1/admin/users/${detail.user.id}/storage`, { method: "POST", body: JSON.stringify({ storageQuotaBytes: bytes }) });
                toast.success(bytes == null ? "已恢复跟随默认" : `已分配 ${formatBytes(bytes)}`);
                await load(detail.user.id);
                onChanged();
              } catch (e) {
                toast.error("分配失败", (e as Error).message);
              } finally {
                setBusy(false);
              }
            })();
          }}><HardDrive />保存配额</Button>
        </div>
        {detail.requests.some(r => r.status === "pending") && <PendingDecide
          request={detail.requests.find(r => r.status === "pending")!}
          onDone={async () => { await load(detail.user.id); onChanged(); }}
        />}
        {detail.requests.length > 0 && <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">申请记录</p>
          <ul className="max-h-40 space-y-1.5 overflow-auto text-xs text-muted-foreground">
            {detail.requests.map(r => <li key={r.id} className="flex justify-between gap-2">
              <span>{formatBytes(r.requestedBytes ?? 0)} · {new Date(r.createdAt).toLocaleDateString()}</span>
              <StatusBadge status={r.status} />
            </li>)}
          </ul>
        </div>}
      </div>}
    </DialogContent>
  </Dialog>;
}

export function RequestRow({ request, onChanged }: { request: AdminRequest; onChanged: () => void }) {
  return <div className="flex flex-wrap items-start gap-3 px-4 py-3.5">
    <div className="min-w-0 flex-1">
      <p className="text-sm font-medium">{request.user?.displayName ?? "用户"}
        <span className="font-normal text-muted-foreground"> @{request.user?.handle}</span>
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {formatBytes(request.currentQuotaBytes ?? 0)} → {formatBytes(request.requestedBytes ?? 0)}
        {request.usedBytes != null ? ` · 已用 ${formatBytes(request.usedBytes)}` : ""}
        {` · ${new Date(request.createdAt).toLocaleString()}`}
      </p>
      {request.reason && <p className="mt-1 text-xs">{request.reason}</p>}
      {request.adminNote && request.status !== "pending" && <p className="mt-1 text-xs text-muted-foreground">说明：{request.adminNote}</p>}
    </div>
    <StatusBadge status={request.status} />
    {request.status === "pending" && <PendingDecide request={request} onDone={onChanged} compact />}
  </div>;
}

function PendingDecide({ request, onDone, compact }: { request: ServiceRequest; onDone: () => void | Promise<void>; compact?: boolean }) {
  const toast = useToast();
  const [note, setNote] = useState("");
  const [grant, setGrant] = useState(request.requestedBytes ?? 5_368_709_120);
  const [busy, setBusy] = useState<string | null>(null);
  async function decide(status: "approved" | "rejected") {
    setBusy(status);
    try {
      await api(`/api/v1/admin/service-requests/${request.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status, grantedQuotaBytes: status === "approved" ? grant : undefined, adminNote: note.trim() || null }),
      });
      toast.success(status === "approved" ? `已通过，配额 ${formatBytes(grant)}` : "已拒绝");
      await onDone();
    } catch (e) {
      toast.error("处理失败", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return <div className={cn("grid gap-2", compact ? "w-full sm:w-64" : "")}>
    {compact ? null : <p className="text-xs font-medium text-muted-foreground">待审批：申请 {formatBytes(request.requestedBytes ?? 0)}</p>}
    <select className="h-8 rounded-lg border border-input bg-background px-2 text-sm" value={grant} onChange={e => setGrant(Number(e.target.value))} aria-label="通过后的配额">
      {STORAGE_PRESETS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      {request.requestedBytes && !STORAGE_PRESETS.some(o => o.value === request.requestedBytes) && <option value={request.requestedBytes}>{formatBytes(request.requestedBytes)}</option>}
    </select>
    <Textarea className="min-h-16" value={note} maxLength={500} onChange={e => setNote(e.target.value)} placeholder="给用户的说明，可空" />
    <div className="flex gap-2">
      <Button size="sm" disabled={!!busy} onClick={() => void decide("approved")}>{busy === "approved" ? "…" : "通过"}</Button>
      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void decide("rejected")}>{busy === "rejected" ? "…" : "拒绝"}</Button>
    </div>
  </div>;
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} aria-pressed={active}
    className={cn("rounded-lg border border-border px-2.5 py-1 text-xs outline-none hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring/50",
      active && "border-primary ring-2 ring-primary/10")}>{children}</button>;
}
