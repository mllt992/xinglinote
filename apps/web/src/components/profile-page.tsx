import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, AtSign, CircleUserRound, ImagePlus, Mail, Trash2 } from "lucide-react";
import { api, type ApiErr, type ApiOk, type Me } from "../api";
import { Field, SectionCard, SettingsShell } from "./settings-shell";
import { Button } from "./ui/button";
import { useConfirm } from "./ui/confirm";
import { FormError } from "./ui/form-error";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { useToast } from "./ui/toast";
import { UserAvatar } from "./user-avatar";

type ProfileResult = Pick<Me, "displayName" | "handle" | "bio"> & { updatedAt: string };
type FieldErrors = Partial<Record<"displayName" | "handle" | "bio", string>>;

async function uploadAvatar(file: File) {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch("/api/v1/me/avatar", {
    method: "POST",
    credentials: "include",
    headers: { "X-Requested-With": "fetch" },
    body: form,
  });
  const json = await response.json() as ApiOk<{ avatarUrl: string }> | ApiErr;
  if (!json.ok) throw new Error(json.error.message);
  return json.data;
}

export function ProfilePage() {
  const confirm = useConfirm();
  const toast = useToast();
  const [me, setMe] = useState<Me | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [bio, setBio] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [formError, setFormError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const data = await api<Me>("/api/v1/me");
    setMe(data);
    setDisplayName(data.displayName);
    setHandle(data.handle);
    setBio(data.bio ?? "");
  }, []);
  const reload = useCallback(() => {
    setLoading(true);
    load().then(() => setLoadError("")).catch(error => setLoadError((error as Error).message)).finally(() => setLoading(false));
  }, [load]);
  useEffect(() => { reload(); }, [reload]);

  const normalized = useMemo(() => ({
    displayName: displayName.trim(),
    handle: handle.trim().toLowerCase(),
    bio: bio.trim(),
  }), [bio, displayName, handle]);
  const dirty = !!me && (normalized.displayName !== me.displayName || normalized.handle !== me.handle || normalized.bio !== (me.bio ?? ""));

  function validate() {
    const errors: FieldErrors = {};
    if (!normalized.displayName) errors.displayName = "请填写显示名";
    else if (normalized.displayName.length > 32) errors.displayName = "显示名最多 32 个字符";
    if (!/^[a-z][a-z0-9_]{2,31}$/.test(normalized.handle)) errors.handle = "小写字母开头，3–32 位，只能包含字母、数字和下划线";
    if (normalized.bio.length > 200) errors.bio = "个人简介最多 200 个字符";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError("");
    if (!me || !dirty || !validate()) return;
    if (normalized.handle !== me.handle && !await confirm({
      title: "更改用户名？",
      description: <>公开主页地址将改为 <span className="font-medium text-foreground">/u/{normalized.handle}</span>，请同步更新你分享过的旧地址。</>,
      confirmText: "确认更改",
    })) return;

    setBusy(true);
    try {
      const updated = await api<ProfileResult>("/api/v1/me", {
        method: "PATCH",
        body: JSON.stringify(normalized),
      });
      setMe(current => current ? { ...current, ...updated } : current);
      setDisplayName(updated.displayName);
      setHandle(updated.handle);
      setBio(updated.bio ?? "");
      setFieldErrors({});
      window.dispatchEvent(new Event("kb:me-updated"));
      toast.success("个人信息已保存", "显示名和简介会立即更新到公开页面。");
    } catch (error) {
      const apiError = error as Error & { fields?: FieldErrors };
      setFieldErrors(apiError.fields ?? {});
      setFormError(apiError.message);
    } finally {
      setBusy(false);
    }
  }

  async function chooseAvatar(file: File | undefined) {
    if (!file || !me) return;
    setFormError("");
    if (file.size > 1024 * 1024) { setFormError("头像不能超过 1MB"); return; }
    setAvatarBusy(true);
    try {
      const result = await uploadAvatar(file);
      setMe(current => current ? { ...current, avatarUrl: result.avatarUrl } : current);
      window.dispatchEvent(new Event("kb:me-updated"));
      toast.success("头像已更新");
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setAvatarBusy(false);
    }
  }

  async function removeAvatar() {
    if (!me?.avatarUrl || !await confirm({ title: "移除当前头像？", description: "移除后将恢复为显示名首字母。", confirmText: "移除头像" })) return;
    setAvatarBusy(true);
    setFormError("");
    try {
      await api<{ avatarUrl: null }>("/api/v1/me/avatar", { method: "DELETE" });
      setMe(current => current ? { ...current, avatarUrl: null } : current);
      window.dispatchEvent(new Event("kb:me-updated"));
      toast.success("头像已移除");
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setAvatarBusy(false);
    }
  }

  return <SettingsShell current="profile" loading={loading} error={loadError} onRetry={reload}>
    {me && <form className="space-y-4" onSubmit={event => void submit(event)}>
      <SectionCard icon={<CircleUserRound className="size-4" />} title="公开资料" desc="显示在广场、圈子和你的公开主页。">
        <div className="grid gap-6 p-4 md:grid-cols-[10rem_minmax(0,1fr)]">
          <div className="flex flex-col items-center rounded-xl bg-muted/60 px-4 py-5 text-center">
            <UserAvatar name={normalized.displayName} url={me.avatarUrl} className="size-20 bg-primary text-2xl text-primary-foreground" />
            <p className="mt-3 max-w-full truncate text-sm font-medium">{normalized.displayName || "你的显示名"}</p>
            <p className="max-w-full truncate text-xs text-muted-foreground">@{normalized.handle || "handle"}</p>
            <input ref={avatarInput} type="file" className="hidden" accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; void chooseAvatar(file); }} />
            <div className="mt-3 flex flex-wrap justify-center gap-1.5">
              <Button type="button" variant="outline" size="sm" disabled={avatarBusy} onClick={() => avatarInput.current?.click()}>
                <ImagePlus />{avatarBusy ? "处理中…" : me.avatarUrl ? "更换" : "上传头像"}
              </Button>
              {me.avatarUrl && <Button type="button" variant="ghost" size="sm" disabled={avatarBusy} onClick={() => void removeAvatar()}>
                <Trash2 />移除
              </Button>}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">PNG、JPEG、WebP 或 GIF，最大 1MB</p>
            <a className="mt-3 inline-flex items-center gap-1 text-xs text-primary hover:underline" href={`/u/${me.handle}`} target="_blank" rel="noreferrer">
              查看公开主页<ArrowUpRight className="size-3" />
            </a>
          </div>
          <div className="space-y-4">
            <Field label="显示名" htmlFor="profile-display-name" hint="1–32 个字符，可以和其他人重复。">
              <Input id="profile-display-name" value={displayName} maxLength={32} aria-invalid={!!fieldErrors.displayName}
                onChange={event => { setDisplayName(event.target.value); setFieldErrors(value => ({ ...value, displayName: undefined })); }} />
            </Field>
            <FormError className="-mt-2">{fieldErrors.displayName}</FormError>
            <Field label="用户名" htmlFor="profile-handle" hint="用于 @提及和公开主页地址；只能使用小写字母、数字和下划线。">
              <div className="relative">
                <AtSign className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input id="profile-handle" className="pl-9" value={handle} maxLength={32} autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  aria-invalid={!!fieldErrors.handle} onChange={event => { setHandle(event.target.value.toLowerCase()); setFieldErrors(value => ({ ...value, handle: undefined })); }} />
              </div>
            </Field>
            <FormError className="-mt-2">{fieldErrors.handle}</FormError>
            <Field label="个人简介" htmlFor="profile-bio" hint={`${bio.length}/200 · 留空则不在公开主页展示。`}>
              <Textarea id="profile-bio" className="min-h-24 resize-y" value={bio} maxLength={200} aria-invalid={!!fieldErrors.bio}
                placeholder="简单介绍一下自己" onChange={event => { setBio(event.target.value); setFieldErrors(value => ({ ...value, bio: undefined })); }} />
            </Field>
            <FormError className="-mt-2">{fieldErrors.bio}</FormError>
          </div>
        </div>
      </SectionCard>

      <SectionCard icon={<Mail className="size-4" />} title="登录邮箱" desc="邮箱变更需要重新验证，目前请联系实例管理员处理。">
        <div className="p-4">
          <Field label="邮箱地址" htmlFor="profile-email">
            <Input id="profile-email" className="max-w-xl bg-muted/40" value={me.email} readOnly aria-readonly="true" />
          </Field>
        </div>
      </SectionCard>

      <FormError>{formError}</FormError>
      <div className="flex justify-end">
        <Button type="submit" disabled={!dirty || busy || avatarBusy}>{busy ? "保存中…" : "保存个人信息"}</Button>
      </div>
    </form>}
  </SettingsShell>;
}
