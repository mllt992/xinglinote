import { useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { api } from "../api";
import { Button } from "./ui/button";
import { FormError } from "./ui/form-error";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { useToast } from "./ui/toast";

const MASK = "••••••••";
type Props = { settings: Record<string, unknown>; onSaved: () => void | Promise<void> };

export function OidcConfig({ settings, onSaved }: Props) {
  const toast = useToast();
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [err, setErr] = useState("");
  const [enabled, setEnabled] = useState(!!settings.oidcEnabled);
  const [autoProvision, setAutoProvision] = useState(settings.oidcAutoProvision !== false);
  const [requireVerifiedEmail, setRequireVerifiedEmail] = useState(settings.oidcRequireVerifiedEmail !== false);
  const [form, setForm] = useState({
    oidcProviderName: String(settings.oidcProviderName ?? "统一认证中心"),
    oidcIssuerUrl: String(settings.oidcIssuerUrl ?? ""),
    oidcClientId: String(settings.oidcClientId ?? ""),
    oidcClientSecret: settings.oidcClientSecret ? MASK : "",
    oidcScopes: String(settings.oidcScopes ?? "openid profile email"),
    oidcClientAuthMethod: String(settings.oidcClientAuthMethod ?? "client_secret_basic"),
  });
  const field = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(current => ({ ...current, [key]: e.target.value }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setErr(""); setBusy("save");
    try {
      await api("/api/v1/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({
          oidcEnabled: enabled,
          oidcProviderName: form.oidcProviderName.trim(),
          oidcIssuerUrl: form.oidcIssuerUrl.trim() || null,
          oidcClientId: form.oidcClientId.trim() || null,
          oidcClientSecret: form.oidcClientSecret === MASK ? MASK : (form.oidcClientSecret || null),
          oidcScopes: form.oidcScopes.trim(),
          oidcClientAuthMethod: form.oidcClientAuthMethod,
          oidcAutoProvision: autoProvision,
          oidcRequireVerifiedEmail: requireVerifiedEmail,
        }),
      });
      await onSaved();
      if (form.oidcClientSecret && form.oidcClientSecret !== MASK) setForm(current => ({ ...current, oidcClientSecret: MASK }));
      toast.success("统一认证配置已保存", enabled ? "登录页入口已经生效，无需重启服务。" : "统一认证入口已关闭。");
    } catch (error) {
      setErr((error as Error).message);
    } finally { setBusy(null); }
  }

  async function testConnection() {
    setErr(""); setBusy("test");
    try {
      await api("/api/v1/admin/oidc/test", { method: "POST" });
      toast.success("连接成功", "已读取并校验认证中心的 OIDC 发现文档。");
    } catch (error) {
      setErr((error as Error).message);
    } finally { setBusy(null); }
  }

  return <section className="overflow-hidden rounded-xl border bg-background">
    <header className="flex items-center gap-3 border-b bg-muted/40 px-5 py-3">
      <KeyRound className="size-4 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold">统一认证（OAuth 2.0 / OIDC）</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">在线配置认证中心。保存后立即生效，Client Secret 加密入库且不会回显。</p>
      </div>
      <Switch checked={enabled} onCheckedChange={setEnabled} label="启用统一认证" />
    </header>
    <form className="space-y-4 px-5 py-4" onSubmit={save}>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5"><span className="text-sm font-medium">登录入口名称</span><Input value={form.oidcProviderName} onChange={field("oidcProviderName")} placeholder="统一认证中心" /></label>
        <label className="space-y-1.5"><span className="text-sm font-medium">Issuer URL</span><Input value={form.oidcIssuerUrl} onChange={field("oidcIssuerUrl")} placeholder="https://auth.example.com" /></label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5"><span className="text-sm font-medium">Client ID</span><Input value={form.oidcClientId} onChange={field("oidcClientId")} autoComplete="off" /></label>
        <label className="space-y-1.5"><span className="text-sm font-medium">Client Secret</span><Input type="password" value={form.oidcClientSecret} onChange={field("oidcClientSecret")} autoComplete="new-password" placeholder={form.oidcClientAuthMethod === "none" ? "公共客户端无需填写" : "填写客户端密钥"} /></label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5"><span className="text-sm font-medium">Scope</span><Input value={form.oidcScopes} onChange={field("oidcScopes")} placeholder="openid profile email" /></label>
        <label className="space-y-1.5"><span className="text-sm font-medium">客户端认证方式</span>
          <select className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/20" value={form.oidcClientAuthMethod} onChange={field("oidcClientAuthMethod")}>
            <option value="client_secret_basic">client_secret_basic</option><option value="client_secret_post">client_secret_post</option><option value="none">none（公共客户端）</option>
          </select>
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex items-start justify-between gap-4 rounded-lg bg-muted/40 px-4 py-3"><div><p className="text-sm font-medium">自动开通用户</p><p className="mt-1 text-xs leading-5 text-muted-foreground">首次登录时创建本地账号和个人工作区。</p></div><Switch checked={autoProvision} onCheckedChange={setAutoProvision} label="自动开通用户" /></div>
        <div className="flex items-start justify-between gap-4 rounded-lg bg-muted/40 px-4 py-3"><div><p className="text-sm font-medium">要求邮箱已验证</p><p className="mt-1 text-xs leading-5 text-muted-foreground">防止未验证邮箱冒名关联已有账号，建议保持开启。</p></div><Switch checked={requireVerifiedEmail} onCheckedChange={setRequireVerifiedEmail} label="要求邮箱已验证" /></div>
      </div>
      <div className="rounded-lg border px-4 py-3 text-xs leading-5 text-muted-foreground">在认证中心登记的回调地址：<code className="select-all text-foreground">{location.origin}/api/v1/auth/oidc/callback</code></div>
      <FormError>{err}</FormError>
      <div className="flex flex-wrap items-center gap-3"><Button type="submit" size="sm" disabled={!!busy}>{busy === "save" ? "保存中…" : "保存配置"}</Button><Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => void testConnection()}>{busy === "test" ? "检测中…" : "检测连接"}</Button><span className="text-xs text-muted-foreground">检测连接使用已保存的配置。</span></div>
    </form>
  </section>;
}
