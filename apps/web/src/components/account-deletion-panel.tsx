import { useEffect, useRef, useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { api, type Me } from "../api";
import { SectionCard } from "./settings-shell";
import { Button } from "./ui/button";
import { usePrompt } from "./ui/confirm";
import { useToast } from "./ui/toast";

/** 账号注销与工作区注销分开；密码校验、所有权限制及 7 天宽限仍由原接口执行。 */
export function AccountDeletionPanel({ me, onChanged }: { me: Me; onChanged: () => Promise<void> }) {
  const askText = usePrompt();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const pending = me.status === "pending_deletion";

  async function act() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      if (pending) {
        const current = await api<Me>("/api/v1/me");
        if (!mounted.current) return;
        if (current.id !== me.id || current.status !== me.status) throw new Error("账号状态已改变，请刷新设置后重试。");
        await api("/api/v1/account/cancel-deletion", { method: "POST" });
        if (!mounted.current) return;
        toast.success("已撤销注销申请", "账号恢复正常，数据不会被删除。");
        window.dispatchEvent(new Event("kb:me-updated"));
        await onChanged();
      } else {
        const password = await askText({ title: "申请注销账号", description: "提交后账号进入注销流程，7 天内可以登录回来撤销；超过 7 天数据会被彻底删除。请输入当前密码确认。", label: "当前密码", type: "password", autoComplete: "current-password", confirmText: "申请注销", destructive: true });
        if (!password || !mounted.current) return;
        // 弹窗期间若其他标签页切换账号，拒绝沿用旧账号的确认操作。
        const current = await api<Me>("/api/v1/me");
        if (!mounted.current) return;
        if (current.id !== me.id || current.status !== me.status) throw new Error("账号状态已改变，请刷新设置后重试。");
        await api("/api/v1/account/request-deletion", { method: "POST", body: JSON.stringify({ password }) });
        if (mounted.current) window.location.assign("/login");
      }
    } catch (e) {
      if (mounted.current) toast.error(pending ? "撤销失败" : "申请注销失败", (e as Error).message);
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <SectionCard icon={<Trash2 className="size-4" />} title="账号注销" desc="这是整个账号的注销申请，与工作区注销不同。">
    <div className="space-y-3 p-4">
      <p className="text-sm text-muted-foreground">{pending
        ? `账号处于注销宽限期${me.deletionScheduledAt ? `，计划于 ${new Date(me.deletionScheduledAt).toLocaleString()} 注销` : ""}。到期前可撤销，个人工作区暂时只读。`
        : "申请时须输入当前密码；提交后有 7 天宽限期，可以重新登录并在这里撤销。到期后数据会被永久删除。"}</p>
      <Button variant={pending ? "outline" : "destructive"} disabled={busy} onClick={() => void act()}>
        {pending ? <RotateCcw /> : <Trash2 />}{busy ? "处理中…" : pending ? "撤销账号注销" : "申请注销账号"}
      </Button>
    </div>
  </SectionCard>;
}
