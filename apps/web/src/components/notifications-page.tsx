import { useCallback, useEffect, useState } from "react";
import { BellOff, BellRing, Laptop, Send, Smartphone, TriangleAlert } from "lucide-react";
import { api } from "../api";
import { currentSubscription, pushSupported, subscribeThisDevice, unsubscribeThisDevice, type PushConfig, type PushDevice } from "../lib/push";
import { EmptyState, Row, SectionCard, SettingsShell } from "./settings-shell";
import { Button } from "./ui/button";
import { useConfirm } from "./ui/confirm";
import { FormError } from "./ui/form-error";
import { useToast } from "./ui/toast";

/** Edge 的 UA 里也有 Chrome 和 Safari，Chrome 的里也有 Safari，所以顺序不能反。 */
const BROWSERS: Array<[RegExp, string]> = [[/Edg\/(\d+)/, "Edge"], [/Firefox\/(\d+)/, "Firefox"], [/Chrome\/(\d+)/, "Chrome"]];
const OSES: Array<[RegExp, string]> = [[/Windows/, "Windows"], [/Android/, "Android"], [/iPhone|iPad/, "iOS"], [/Mac OS/, "macOS"], [/Linux/, "Linux"]];

/** 「Chrome 141 · Windows」这种够用了，不必把整串 UA 摆出来吓人。 */
function deviceName(ua: string | null) {
  if (!ua) return "未知设备";
  const hit = BROWSERS.map(([re, name]) => { const m = re.exec(ua); return m ? `${name} ${m[1]}` : null; }).find(Boolean);
  const browser = hit ?? (/Safari/.test(ua) ? "Safari" : "浏览器");
  const os = OSES.find(([re]) => re.test(ua))?.[1] ?? "";
  return [browser, os].filter(Boolean).join(" · ");
}

const mobile = (ua: string | null) => !!ua && /Android|iPhone|iPad|Mobile/.test(ua);

export function NotificationsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [cfg, list] = await Promise.all([
      api<PushConfig>("/api/v1/push/config"),
      api<{ devices: PushDevice[] }>("/api/v1/push/devices"),
    ]);
    setConfig(cfg);
    setDevices(list.devices);
    // 拿本机订阅的指纹来认「这一台」，endpoint 原文服务端不回，前端自己算
    setThisEndpoint((await currentSubscription())?.endpoint?.slice(-16) ?? null);
  }, []);
  const reload = useCallback(() => {
    setLoading(true);
    load().then(() => setError("")).catch(e => setError((e as Error).message)).finally(() => setLoading(false));
  }, [load]);
  useEffect(() => { reload(); }, [reload]);

  const supported = pushSupported();
  const here = devices.find(d => d.fingerprint === thisEndpoint && d.status === "active");

  async function enable() {
    if (!config?.publicKey) return;
    setBusy(true);
    try {
      await subscribeThisDevice(config.publicKey);
      await load();
      toast.success("这台设备已开启推送", "日历提醒里选「推送」渠道就会发到这里。");
    } catch (e) { toast.error("开启失败", (e as Error).message); }
    finally { setBusy(false); }
  }

  async function disable(device: PushDevice, isHere: boolean) {
    if (!await confirm({ title: "停用这台设备的推送？", description: isHere ? "这台设备将不再收到提醒推送，站内铃铛与邮件不受影响。" : "这台设备下次要收推送，得在它自己的浏览器里重新开一次。", confirmText: "停用" })) return;
    setBusy(true);
    try {
      if (isHere) await unsubscribeThisDevice(device.id);
      else await api(`/api/v1/push/devices/${device.id}`, { method: "DELETE" });
      setDevices(list => list.filter(d => d.id !== device.id));   // 就地撤行，不重拉整张列表
      if (isHere) setThisEndpoint(null);
    } catch (e) { toast.error("停用失败", (e as Error).message); void load(); }
    finally { setBusy(false); }
  }

  async function test() {
    setBusy(true);
    try {
      const r = await api<{ sent: number; total: number }>("/api/v1/push/test", { method: "POST" });
      toast.success("测试推送已发出", `${r.total} 台设备里送达 ${r.sent} 台。没弹出来就检查系统的通知权限。`);
    } catch (e) { toast.error("发不出去", (e as Error).message); }
    finally { setBusy(false); }
  }

  return <SettingsShell current="notifications" loading={loading} error={error} onRetry={reload}
    subtitle="日历提醒可以走站内铃铛、邮件或浏览器推送。前两个一直可用，推送要每台设备各开一次。">
    <div className="space-y-4">
      <SectionCard icon={<BellRing className="size-4" />} title="浏览器推送"
        desc="关掉这台设备的浏览器也能收到提醒。推送由本实例自己加密后直发，不经任何第三方服务。"
        action={here && <Button variant="outline" size="sm" disabled={busy} onClick={() => void test()}><Send />发一条测试</Button>}>
        {!config?.enabled
          ? <div className="px-4 py-4"><FormError>实例还没有开启推送。请实例管理员到后台「通知与推送」里生成一对 VAPID 密钥。</FormError></div>
          : !supported
            ? <div className="px-4 py-4"><FormError>这个浏览器不支持 Web Push（Safari 需要先把站点添加到主屏幕）。站内铃铛与邮件提醒照常可用。</FormError></div>
            : here
              ? <Row first icon={<span className="text-primary"><BellRing className="size-4" /></span>} title="这台设备已开启"
                  desc={`${deviceName(here.userAgent)} · ${here.lastOkAt ? `最近送达 ${new Date(here.lastOkAt).toLocaleString("zh-CN")}` : "还没收到过推送"}`}
                  actions={<Button variant="outline" size="sm" disabled={busy} onClick={() => void disable(here, true)}><BellOff />停用</Button>} />
              : <Row first icon={<BellRing className="size-4" />} title="这台设备还没开启"
                  desc="点开启后浏览器会问一次通知权限，同意才算数。"
                  actions={<Button size="sm" disabled={busy} onClick={() => void enable()}><BellRing />开启推送</Button>} />}
      </SectionCard>

      <SectionCard icon={<Laptop className="size-4" />} title="已登记的设备" desc={`最多 10 台。掉线的设备会自动停用，第二天清出这张表。`}>
        {devices.length === 0
          ? <EmptyState icon={<BellOff className="size-5" />} title="还没有设备" text="在任意一台想收提醒的设备上打开这一页，点「开启推送」。" />
          : devices.map((d, i) => <Row key={d.id} first={i === 0}
              icon={mobile(d.userAgent) ? <Smartphone className="size-4" /> : <Laptop className="size-4" />}
              title={<span className="flex items-center gap-2">{deviceName(d.userAgent)}
                {d.fingerprint === thisEndpoint && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">这一台</span>}
                {d.status !== "active" && <span className="flex items-center gap-1 text-[10px] text-destructive"><TriangleAlert className="size-3" />已停用</span>}</span>}
              desc={`登记于 ${new Date(d.createdAt).toLocaleDateString("zh-CN")}${d.failCount ? ` · 连续失败 ${d.failCount} 次` : ""}`}
              actions={<Button variant="ghost" size="sm" disabled={busy} onClick={() => void disable(d, d.fingerprint === thisEndpoint)}>移除</Button>} />)}
      </SectionCard>
    </div>
  </SettingsShell>;
}
