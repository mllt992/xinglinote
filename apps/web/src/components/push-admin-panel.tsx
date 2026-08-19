import { useState } from "react";
import { BellRing, KeyRound, RefreshCw } from "lucide-react";
import { api } from "../api";
import { Button } from "./ui/button";
import { useConfirm } from "./ui/confirm";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { useToast } from "./ui/toast";

/**
 * 实例级的推送配置：一对 VAPID 密钥 + 一个联系地址。
 * 私钥生成后就再也不出这台机器，接口只回公钥，所以这里没有「查看私钥」这种入口。
 */
export function PushConfig({ settings, onSaved }: { settings: Record<string, unknown>; onSaved: () => void | Promise<void> }) {
  const toast = useToast();
  const confirm = useConfirm();
  const configured = !!settings.vapidConfigured;
  const enabled = !!settings.pushEnabled;
  const [subject, setSubject] = useState(String(settings.vapidSubject ?? ""));
  const [busy, setBusy] = useState(false);

  async function patch(body: Record<string, unknown>, okText?: string) {
    setBusy(true);
    try {
      await api("/api/v1/admin/settings", { method: "PATCH", body: JSON.stringify(body) });
      await onSaved();
      if (okText) toast.success(okText);
    } catch (e) { toast.error("更新失败", (e as Error).message); }
    finally { setBusy(false); }
  }

  async function keys(rotate: boolean) {
    if (rotate && !await confirm({
      title: "轮换 VAPID 密钥？",
      description: "浏览器是拿旧公钥订阅的，换了之后所有已登记的设备立刻失效，每个人都得重新开一次推送。只有密钥可能泄露时才这么做。",
      confirmText: "仍然轮换", destructive: true,
    })) return;
    setBusy(true);
    try {
      const r = await api<{ revokedDevices: number }>("/api/v1/admin/push/vapid", { method: "POST", body: JSON.stringify({ rotate, subject: subject.trim() || undefined }) });
      await onSaved();
      toast.success(rotate ? "已轮换" : "密钥已生成", rotate ? `${r.revokedDevices} 台设备需要重新授权。` : "现在可以打开推送开关了。");
    } catch (e) { toast.error(rotate ? "轮换失败" : "生成失败", (e as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="overflow-hidden rounded-xl border bg-background">
    <header className="flex items-center gap-3 border-b bg-muted/40 px-5 py-3">
      <BellRing className="size-4 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold">浏览器推送</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">日历提醒可以推到成员的设备上。推送由本实例自己签名加密后直连浏览器厂商的网关，不经第三方服务。</p>
      </div>
    </header>

    <div className="flex items-start justify-between gap-4 px-5 py-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">开启推送</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{configured ? "关闭后成员的「推送」提醒会自动降级成站内铃铛，不会静默丢失。" : "得先生成一对 VAPID 密钥。"}</p>
      </div>
      <Switch checked={enabled} disabled={busy || !configured} label="开启推送"
        onCheckedChange={v => void patch({ pushEnabled: v }, v ? "推送已开启" : "推送已关闭")} />
    </div>

    <div className="border-t px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><KeyRound className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{configured ? "VAPID 密钥已就绪" : "还没有 VAPID 密钥"}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">私钥加密存库、永不外传；公钥由前端拿去向浏览器订阅。</p>
        </div>
        {configured
          ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void keys(true)}><RefreshCw />轮换</Button>
          : <Button size="sm" disabled={busy} onClick={() => void keys(false)}><KeyRound />生成密钥</Button>}
      </div>

      <label className="mt-4 grid gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">联系地址</span>
        <div className="flex flex-wrap gap-2">
          <Input className="min-w-56 flex-1" value={subject} placeholder="mailto:ops@example.com"
            onChange={e => setSubject(e.target.value)} />
          <Button variant="outline" size="sm" disabled={busy || subject === String(settings.vapidSubject ?? "")}
            onClick={() => void patch({ vapidSubject: subject.trim() || null }, "已保存")}>保存</Button>
        </div>
        <span className="text-xs text-muted-foreground">推送网关出问题时会照这个地址找你。留空则用站点域名拼一个。</span>
      </label>
    </div>
  </section>;
}
