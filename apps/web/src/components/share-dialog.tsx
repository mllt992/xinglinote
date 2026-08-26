import { useEffect, useMemo, useState } from "react";
import { outlineOf } from "@kb/shared/markdown";
import { Check, Copy, Link2, LoaderCircle, Lock, Share2, Trash2 } from "lucide-react";
import { api } from "../api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { useToast } from "./ui/toast";
import { FormError } from "./ui/form-error";
import { assertConfirmedRevokedShare, removeConfirmedRevokedShare } from "./share-dialog-state";

export type ShareDto = { id: string; token: string; targetType: string; targetId: string; headingAnchor: string | null; hasPassword: boolean; expiresAt: string | null; allowRobots: boolean; commentsEnabled: boolean; correctionsEnabled: boolean; showBacklinks: boolean; status: string; createdAt: string };
export type ShareTarget = { kind: "note" | "folder" | "attachment" | "notebook"; id: string; title: string; bodyMd?: string };
const typeLabel: Record<string, string> = { note: "整篇", heading: "某一节", folder: "目录", attachment: "附件", notebook: "整本" };

type ShareRowProps = {
  s: ShareDto; url: string; copied?: boolean; confirming?: boolean; revoking?: boolean; revokeDisabled?: boolean;
  onCopy?: () => void; onRequestRevoke?: () => void; onCancelRevoke?: () => void; onConfirmRevoke?: () => void;
};

function ShareRow({ s, url, copied, confirming, revoking, revokeDisabled, onCopy, onRequestRevoke, onCancelRevoke, onConfirmRevoke }: ShareRowProps) {
  const expired = !!s.expiresAt && new Date(s.expiresAt).getTime() < Date.now();
  return <div className="rounded-xl border border-border p-3">
    <div className="flex items-center gap-3">
      <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${onCopy ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>{s.hasPassword ? <Lock className="size-4" /> : <Link2 className="size-4" />}</span>
      <div className="min-w-0 flex-1"><p className={`truncate font-mono text-xs ${onCopy ? "" : "text-muted-foreground line-through"}`}>{url}</p>
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground"><Badge>{typeLabel[s.targetType] ?? s.targetType}</Badge>
          {s.status === "revoked" ? "已撤销" : expired ? "已过期" : s.expiresAt ? `到期 ${new Date(s.expiresAt).toLocaleDateString()}` : "永不过期"}
          {s.hasPassword ? " · 有密码" : " · 无密码"}{s.correctionsEnabled ? " · 可纠错" : ""}{s.allowRobots ? " · 公开收录" : ""}</p></div>
      {onCopy && <Button type="button" variant="ghost" size="icon" aria-label="复制链接" onClick={onCopy}>{copied ? <Check /> : <Copy />}</Button>}
      {onRequestRevoke && <Button type="button" variant="ghost" size="icon" aria-label="删除分享链接" aria-expanded={confirming} className="text-destructive" disabled={revokeDisabled} onClick={onRequestRevoke}><Trash2 /></Button>}
    </div>
    {confirming && <div role="group" aria-label="确认删除分享链接" className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
      <p className="min-w-48 flex-1 text-xs text-muted-foreground">删除后链接立即失效，已经拿到链接的人也无法再打开。</p>
      <Button type="button" size="sm" variant="ghost" disabled={revoking} onClick={onCancelRevoke}>取消</Button>
      <Button type="button" size="sm" variant="destructive" autoFocus disabled={revoking} onClick={onConfirmRevoke}>{revoking && <LoaderCircle className="animate-spin" />}{revoking ? "正在删除…" : "确认删除"}</Button>
    </div>}
  </div>;
}

function shareListPath(target: ShareTarget) {
  if (target.kind === "note") return `/api/v1/notes/${target.id}/shares`;
  if (target.kind === "notebook") return `/api/v1/notebooks/${target.id}/shares`;
  if (target.kind === "folder") return `/api/v1/folders/${target.id}/shares`;
  return `/api/v1/attachments/${target.id}/shares`;
}

function hint(kind: ShareTarget["kind"]) {
  if (kind === "notebook") return "整本链接是实时投影，之后在这个本里新建的笔记也会出现。和发布文档站不同：这里不看是否已发布，本里所有未删除的笔记都会进去。勾选「允许搜索引擎收录」且不设密码时，会出现在广场的笔记本列表。";
  if (kind === "folder") return "目录链接是实时子树，之后在这个目录下新建的笔记也会出现在链接里。公开页和整本分享一样是 wiki 阅读壳。勾选「允许搜索引擎收录」且不设密码时，会出现在广场的笔记本列表。";
  if (kind === "attachment") return "附件只能经这条链接下载，不暴露物理路径。";
  return "每条链接相互独立，可以设置密码、有效期或单独撤销。";
}

/** 一个目标可以有多条互不影响的链接：密码、有效期、评论纠错开关都各自独立。 */
export function ShareDialog({ target, open, onOpenChange }: { target: ShareTarget | null; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [shares, setShares] = useState<ShareDto[]>([]);
  const [password, setPassword] = useState("");
  const [days, setDays] = useState("never");
  const [busy, setBusy] = useState(false);
  const [confirmingId, setConfirmingId] = useState("");
  const [revokingId, setRevokingId] = useState("");
  const [copied, setCopied] = useState("");
  const [err, setErr] = useState("");
  const toast = useToast();
  const [anchor, setAnchor] = useState("");
  const [opts, setOpts] = useState({ commentsEnabled: true, correctionsEnabled: false, showBacklinks: false, allowRobots: false });
  const headings = useMemo(() => target?.kind === "note" && target.bodyMd ? outlineOf(target.bodyMd).map(item => ({ anchor: item.slug, text: item.text, level: item.level })) : [], [target?.bodyMd, target?.kind]);
  const listPath = target ? shareListPath(target) : null;
  const load = () => listPath && api<{ shares: ShareDto[] }>(listPath).then(d => setShares(d.shares)).catch(() => setShares([]));
  useEffect(() => { if (open) { setErr(""); setAnchor(""); setConfirmingId(""); void load(); } }, [open, target?.id]);
  const url = (s: ShareDto) => `${location.origin}/p/${s.token}`;
  const [showDead, setShowDead] = useState(false);
  const isLive = (s: ShareDto) => s.status === "active" && (!s.expiresAt || new Date(s.expiresAt).getTime() > Date.now());
  // revoked 是服务端为审计保留的软删除记录，不应在“已有分享链接”中再次出现。
  const visibleShares = shares.filter(s => s.status !== "revoked");
  const live = visibleShares.filter(isLive);
  const dead = visibleShares.filter(s => !isLive(s));
  async function revoke(s: ShareDto) {
    if (revokingId) return;
    setRevokingId(s.id);
    setErr("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const revoked = await api<ShareDto>(`/api/v1/shares/${s.id}`, { method: "DELETE", signal: controller.signal });
      // 先在 try/catch 内校验，避免状态更新器异步执行时抛错绕过错误提示。
      assertConfirmedRevokedShare(revoked);
      setShares(rows => removeConfirmedRevokedShare(rows, revoked));
      setConfirmingId("");
      toast.success("已删除分享链接");
    } catch (e) {
      const message = controller.signal.aborted ? "请求超时，请检查网络后重试。" : (e as Error).message;
      setErr(`删除失败：${message}`);
      toast.error("删除失败", message);
    } finally {
      window.clearTimeout(timeout);
      setRevokingId("");
    }
  }
  async function copy(s: ShareDto) {
    try {
      await navigator.clipboard.writeText(url(s));
      setCopied(s.id);
      toast.success("已复制链接");
      setTimeout(() => setCopied(""), 1200);
    } catch {
      setErr("链接已生成，请手动复制下面的地址。");
    }
  }

  async function createShare() {
    if (!listPath) return;
    setBusy(true); setErr("");
    try {
      const s = await api<ShareDto>(listPath, { method: "POST", body: JSON.stringify({ password: password || undefined, expiresInDays: days === "never" ? null : Number(days), ...(anchor ? { headingAnchor: anchor } : {}), ...opts }) });
      setShares(v => [s, ...v]);
      setPassword("");
      await copy(s);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-xl">
    <DialogHeader><DialogTitle className="flex items-center gap-2"><Share2 className="size-5" />分享《{target?.title}》</DialogTitle>
      <DialogDescription>{target ? hint(target.kind) : ""}</DialogDescription>
      <p className="text-xs text-muted-foreground">这条链接<b className="font-medium">只读</b>，访客能看能评论，但不能编辑。想让人跟你一起写，用顶栏的「协作」。</p></DialogHeader>
    <form className="rounded-xl border border-border bg-muted/30 p-4" onSubmit={e => { e.preventDefault(); void createShare(); }}>
      {target?.kind === "note" && headings.length > 0 && <select className="mb-3 h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none" value={anchor} onChange={e => setAnchor(e.target.value)}><option value="">分享整篇</option>{headings.map(h => <option key={h.anchor} value={h.anchor}>只分享这一节：{"　".repeat(Math.max(0, h.level - 1))}{h.text}</option>)}</select>}
      <div className="grid gap-3 sm:grid-cols-[1fr_150px_auto]">
        <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="访问密码（可选）" autoComplete="new-password" />
        <select className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none" value={days} onChange={e => setDays(e.target.value)}><option value="never">永不过期</option><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option></select>
        <Button type="submit" disabled={busy}>{busy ? "生成中…" : "生成并复制"}</Button>
      </div>
      {target?.kind !== "attachment" && <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        {([["commentsEnabled", "允许评论"], ["correctionsEnabled", "允许纠错建议"], ["showBacklinks", "显示反向链接"], ["allowRobots", "允许搜索引擎收录"]] as const).map(([k, label]) =>
          <label key={k} className="flex cursor-pointer items-center gap-1.5"><input type="checkbox" className="size-3.5 accent-current" checked={opts[k]} onChange={e => setOpts({ ...opts, [k]: e.target.checked })} />{label}</label>)}
      </div>}
      <FormError className="mt-2">{err}</FormError>
    </form>
    <div className="max-h-80 space-y-2 overflow-auto">
      {visibleShares.length === 0 && <div className="py-10 text-center text-sm text-muted-foreground">还没有分享链接。</div>}
      {live.length > 0 && <p className="px-1 text-[11px] font-semibold uppercase tracking-[.12em] text-muted-foreground">生效中 {live.length}</p>}
      {live.map(s => <ShareRow key={s.id} s={s} url={url(s)} copied={copied === s.id} confirming={confirmingId === s.id} revoking={revokingId === s.id} revokeDisabled={!!revokingId || (!!confirmingId && confirmingId !== s.id)} onCopy={() => void copy(s)} onRequestRevoke={() => setConfirmingId(s.id)} onCancelRevoke={() => setConfirmingId("")} onConfirmRevoke={() => void revoke(s)} />)}
      {dead.length > 0 && <>
        <button className="mt-2 w-full rounded-lg px-1 py-1.5 text-left text-[11px] font-semibold uppercase tracking-[.12em] text-muted-foreground hover:bg-muted" onClick={() => setShowDead(v => !v)}>
          {showDead ? "▾" : "▸"} 已失效 {dead.length}
        </button>
        {showDead && dead.map(s => <ShareRow key={s.id} s={s} url={url(s)} confirming={confirmingId === s.id} revoking={revokingId === s.id} revokeDisabled={!!revokingId || (!!confirmingId && confirmingId !== s.id)} onRequestRevoke={() => setConfirmingId(s.id)} onCancelRevoke={() => setConfirmingId("")} onConfirmRevoke={() => void revoke(s)} />)}
      </>}
    </div>
  </DialogContent></Dialog>;
}
