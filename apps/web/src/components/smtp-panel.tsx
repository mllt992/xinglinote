import { useState, type FormEvent } from "react";
import { Mail } from "lucide-react";
import { api } from "../api";
import { Button } from "./ui/button";
import { FormError } from "./ui/form-error";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { useToast } from "./ui/toast";

/**
 * 实例级 SMTP。
 *
 * 后端一直收这几个字段，但界面上没有任何入口——于是邮箱验证、找回密码、
 * 日历邮件提醒这三条链路只能靠手工调 API 才能启用，实际等于关着。
 *
 * 密码字段回来的是掩码（••••••••）。原样提交表示「不改」，后端会跳过；
 * 想清空就把它删空再保存。
 */
const MASK = "••••••••";

type Props = { settings: Record<string, unknown>; onSaved: () => void | Promise<void> };

export function SmtpConfig({ settings, onSaved }: Props) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    smtpHost: String(settings.smtpHost ?? ""),
    smtpPort: String(settings.smtpPort ?? "587"),
    smtpUser: String(settings.smtpUser ?? ""),
    smtpPassword: settings.smtpPassword ? MASK : "",
    smtpFrom: String(settings.smtpFrom ?? ""),
  });
  const [secure, setSecure] = useState(!!settings.smtpSecure);
  const field = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: e.target.value });

  const configured = !!settings.smtpHost && !!settings.smtpFrom;

  async function save(e: FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await api("/api/v1/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({
          smtpHost: form.smtpHost.trim() || null,
          smtpPort: form.smtpPort ? Number(form.smtpPort) : null,
          smtpUser: form.smtpUser.trim() || null,
          // 掩码原样回传 = 不改密码，后端认这个前缀
          smtpPassword: form.smtpPassword === MASK ? MASK : (form.smtpPassword || null),
          smtpFrom: form.smtpFrom.trim() || null,
          smtpSecure: secure,
        }),
      });
      await onSaved();
      toast.success("SMTP 已保存", configured ? undefined : "邮箱验证和找回密码现在可以用了。");
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <section className="overflow-hidden rounded-xl border bg-background">
    <header className="flex items-center gap-3 border-b bg-muted/40 px-5 py-3">
      <Mail className="size-4 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold">邮件发送（SMTP）</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          邮箱验证、找回密码、日历的邮件提醒都走这里。没配的话这些功能会静默降级：
          验证信发不出去，找回密码点了也没反应。
        </p>
      </div>
      {configured && <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">已配置</span>}
    </header>

    <form className="space-y-4 px-5 py-4" onSubmit={save}>
      <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
        <label className="space-y-1.5">
          <span className="text-sm font-medium">服务器地址</span>
          <Input value={form.smtpHost} onChange={field("smtpHost")} placeholder="smtp.example.com" />
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">端口</span>
          <Input value={form.smtpPort} onChange={field("smtpPort")} inputMode="numeric" placeholder="587" />
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-sm font-medium">用户名</span>
          <Input value={form.smtpUser} onChange={field("smtpUser")} autoComplete="off" placeholder="留空表示不认证" />
        </label>
        <label className="space-y-1.5">
          <span className="text-sm font-medium">密码</span>
          <Input type="password" value={form.smtpPassword} onChange={field("smtpPassword")} autoComplete="new-password" placeholder="留空表示不认证" />
        </label>
      </div>

      <label className="block space-y-1.5">
        <span className="text-sm font-medium">发件地址</span>
        <Input value={form.smtpFrom} onChange={field("smtpFrom")} placeholder="知识库 &lt;noreply@example.com&gt;" />
      </label>

      <div className="flex items-start justify-between gap-4 rounded-lg bg-muted/40 px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">直接使用 TLS</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">465 端口通常要开；587 一般走 STARTTLS，保持关闭即可。</p>
        </div>
        <Switch checked={secure} onCheckedChange={setSecure} label="直接使用 TLS" />
      </div>

      <FormError>{err}</FormError>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={busy}>{busy ? "保存中…" : "保存"}</Button>
        <span className="text-xs text-muted-foreground">密码加密后入库（APP_SECRET），接口只回掩码。</span>
      </div>
    </form>
  </section>;
}
