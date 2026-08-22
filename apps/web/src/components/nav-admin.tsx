import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Compass, ExternalLink, LoaderCircle, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/utils";
import { hostOf, NavIcon, type NavCatalog, type NavGroupDto, type NavLinkDto } from "./nav-page";
import { Button } from "./ui/button";
import { useConfirm } from "./ui/confirm";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { FormError } from "./ui/form-error";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { useToast } from "./ui/toast";

type Settings = {
  navEnabled?: boolean;
  navPublic?: boolean;
  navTitle?: string | null;
  navSubtitle?: string | null;
};

export function NavAdmin({ settings, onSaved }: { settings: Record<string, boolean | number | string | null>; onSaved: () => void }) {
  const toast = useToast();
  const ask = useConfirm();
  const [catalog, setCatalog] = useState<NavCatalog | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [groupId, setGroupId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [title, setTitle] = useState(String(settings.navTitle ?? ""));
  const [subtitle, setSubtitle] = useState(String(settings.navSubtitle ?? ""));
  const [groupDlg, setGroupDlg] = useState<{ mode: "create" | "edit"; group?: NavGroupDto } | null>(null);
  const [linkDlg, setLinkDlg] = useState<{ mode: "create" | "edit"; link?: NavLinkDto } | null>(null);

  const enabled = !!settings.navEnabled;
  const pub = settings.navPublic !== false;

  async function reload() {
    const d = await api<NavCatalog>("/api/v1/admin/nav");
    setCatalog(d);
    setGroupId(cur => cur && d.groups.some(g => g.id === cur) ? cur : d.groups[0]?.id ?? null);
  }

  useEffect(() => {
    reload().then(() => setLoadErr("")).catch(e => setLoadErr((e as Error).message));
  }, []);

  useEffect(() => {
    setTitle(String(settings.navTitle ?? ""));
    setSubtitle(String(settings.navSubtitle ?? ""));
  }, [settings.navTitle, settings.navSubtitle]);

  async function patchSetting(body: Settings, key: string, okText?: string) {
    setPending(key);
    try {
      await api("/api/v1/admin/settings", { method: "PATCH", body: JSON.stringify(body) });
      await onSaved();
      if (okText) toast.success(okText);
    } catch (e) {
      toast.error("更新失败", (e as Error).message);
    } finally {
      setPending(null);
    }
  }

  const groups = catalog?.groups ?? [];
  const current = groups.find(g => g.id === groupId) ?? groups[0];

  async function moveGroup(from: number, dir: -1 | 1) {
    const to = from + dir;
    if (to < 0 || to >= groups.length) return;
    const next = groups.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    await api("/api/v1/admin/nav/reorder", {
      method: "POST",
      body: JSON.stringify({ groups: next.map((g, i) => ({ id: g.id, sortKey: (i + 1) * 10 })) }),
    });
    await reload();
  }

  async function moveLink(from: number, dir: -1 | 1) {
    if (!current) return;
    const to = from + dir;
    if (to < 0 || to >= current.links.length) return;
    const next = current.links.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    await api("/api/v1/admin/nav/reorder", {
      method: "POST",
      body: JSON.stringify({ links: next.map((l, i) => ({ id: l.id, sortKey: (i + 1) * 10 })) }),
    });
    await reload();
  }

  return <div className="space-y-5">
    <section className="overflow-hidden rounded-xl border bg-background">
      <div className="flex items-start gap-4 px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">启用导航页</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">关掉后顶栏不再出现「导航」，目录对所有人不可见。这里仍能改。</p>
        </div>
        <Switch checked={enabled} disabled={pending === "navEnabled"} label="启用导航页" onCheckedChange={v => void patchSetting({ navEnabled: v }, "navEnabled")} />
      </div>
      <div className="flex items-start gap-4 border-t px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">对访客公开</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">关闭后未登录的人打开 /nav 会先被要求登录。</p>
        </div>
        <Switch checked={pub} disabled={pending === "navPublic"} label="对访客公开" onCheckedChange={v => void patchSetting({ navPublic: v }, "navPublic")} />
      </div>
    </section>

    <section className="rounded-xl border bg-background p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">页标题</span>
          <Input value={title} maxLength={20} placeholder="导航" onChange={e => setTitle(e.target.value)}
            onBlur={() => { if (title.trim() !== String(settings.navTitle ?? "")) void patchSetting({ navTitle: title.trim() || null }, "navTitle", "标题已更新"); }} />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">副标题</span>
          <Input value={subtitle} maxLength={80} placeholder="实例里的常用去处。点开即走。" onChange={e => setSubtitle(e.target.value)}
            onBlur={() => { if (subtitle.trim() !== String(settings.navSubtitle ?? "")) void patchSetting({ navSubtitle: subtitle.trim() || null }, "navSubtitle", "副标题已更新"); }} />
        </label>
      </div>
    </section>

    {loadErr && <FormError>{loadErr}</FormError>}

    <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
      <section className="rounded-xl border bg-background">
        <div className="flex items-center justify-between border-b px-3 py-2.5">
          <h2 className="text-sm font-semibold">分组</h2>
          <Button variant="ghost" size="sm" onClick={() => setGroupDlg({ mode: "create" })}><Plus />新建</Button>
        </div>
        {groups.length === 0 ? <p className="px-4 py-10 text-center text-xs text-muted-foreground">先建一个分组，再往里面加站点。</p>
          : <ul>
            {groups.map((g, i) => <li key={g.id} className={cn("flex items-center gap-0.5 border-b last:border-b-0", g.id === current?.id && "bg-muted/60")}>
              <button type="button" onClick={() => setGroupId(g.id)} className="min-w-0 flex-1 px-3 py-2.5 text-left">
                <span className="block truncate text-sm font-medium">{g.title}</span>
                <span className="text-[11px] text-muted-foreground">{g.links.length} 个站点</span>
              </button>
              <Button variant="ghost" size="icon" className="size-8" disabled={i === 0} aria-label="上移" onClick={() => void moveGroup(i, -1)}><ChevronUp /></Button>
              <Button variant="ghost" size="icon" className="size-8" disabled={i === groups.length - 1} aria-label="下移" onClick={() => void moveGroup(i, 1)}><ChevronDown /></Button>
            </li>)}
          </ul>}
      </section>

      <section className="rounded-xl border bg-background">
        <div className="flex items-center justify-between border-b px-3 py-2.5">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{current?.title ?? "站点"}</h2>
            {current?.description && <p className="truncate text-[11px] text-muted-foreground">{current.description}</p>}
          </div>
          <div className="flex items-center gap-1">
            {current && <>
              <Button variant="ghost" size="sm" onClick={() => setGroupDlg({ mode: "edit", group: current })}><Pencil />改分组</Button>
              <Button variant="ghost" size="sm" className="text-destructive" onClick={() => void (async () => {
                if (!await ask({ title: `删除「${current.title}」？`, description: "分组里的站点会一起删掉。", confirmText: "删除", destructive: true })) return;
                try {
                  await api(`/api/v1/admin/nav/groups/${current.id}`, { method: "DELETE" });
                  toast.success("分组已删除");
                  await reload();
                } catch (e) {
                  toast.error("删除失败", (e as Error).message);
                }
              })()}><Trash2 />删分组</Button>
              <Button size="sm" onClick={() => setLinkDlg({ mode: "create" })}><Plus />加站点</Button>
            </>}
          </div>
        </div>
        {!current ? <div className="px-5 py-16 text-center">
          <span className="mx-auto grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground"><Compass className="size-4" /></span>
          <p className="mt-3 text-sm font-medium">还没有分组</p>
        </div> : current.links.length === 0 ? <p className="px-5 py-14 text-center text-sm text-muted-foreground">这个分组还是空的。</p>
          : <ul>
            {current.links.map((l, i) => <li key={l.id} className={cn("flex items-center gap-2 px-3 py-2.5", i && "border-t")}>
              <NavIcon title={l.title} iconUrl={l.iconUrl} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{l.title}</p>
                <p className="truncate text-[11px] text-muted-foreground">{hostOf(l.url)}</p>
              </div>
              <Button variant="ghost" size="icon" className="size-8" disabled={i === 0} aria-label="上移" onClick={() => void moveLink(i, -1)}><ChevronUp /></Button>
              <Button variant="ghost" size="icon" className="size-8" disabled={i === current.links.length - 1} aria-label="下移" onClick={() => void moveLink(i, 1)}><ChevronDown /></Button>
              <Button variant="ghost" size="icon" className="size-8" aria-label="编辑" onClick={() => setLinkDlg({ mode: "edit", link: l })}><Pencil /></Button>
              <Button variant="ghost" size="icon" className="size-8 text-destructive" aria-label="删除" onClick={() => void (async () => {
                if (!await ask({ title: `删除「${l.title}」？`, description: "从导航里拿掉，不影响目标网站本身。", confirmText: "删除", destructive: true })) return;
                try {
                  await api(`/api/v1/admin/nav/links/${l.id}`, { method: "DELETE" });
                  toast.success("站点已删除");
                  await reload();
                } catch (e) {
                  toast.error("删除失败", (e as Error).message);
                }
              })()}><Trash2 /></Button>
            </li>)}
          </ul>}
      </section>
    </div>

    {groupDlg && <GroupDialog
      mode={groupDlg.mode}
      group={groupDlg.group}
      onClose={() => setGroupDlg(null)}
      onDone={async () => { setGroupDlg(null); await reload(); }}
    />}
    {linkDlg && current && <LinkDialog
      mode={linkDlg.mode}
      groupId={current.id}
      link={linkDlg.link}
      onClose={() => setLinkDlg(null)}
      onDone={async () => { setLinkDlg(null); await reload(); }}
    />}
  </div>;
}

function GroupDialog({ mode, group, onClose, onDone }: {
  mode: "create" | "edit"; group?: NavGroupDto; onClose: () => void; onDone: () => Promise<void>;
}) {
  const [title, setTitle] = useState(group?.title ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function submit() {
    if (!title.trim()) return;
    setBusy(true); setErr("");
    try {
      if (mode === "create") await api("/api/v1/admin/nav/groups", { method: "POST", body: JSON.stringify({ title: title.trim(), description: description.trim() || null }) });
      else await api(`/api/v1/admin/nav/groups/${group!.id}`, { method: "PATCH", body: JSON.stringify({ title: title.trim(), description: description.trim() || null }) });
      await onDone();
    } catch (e) {
      setErr((e as Error).message); setBusy(false);
    }
  }
  return <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{mode === "create" ? "新建分组" : "编辑分组"}</DialogTitle>
        <DialogDescription>分组用来把站点按用途摊开，比如「常用」「文档」「内部」。</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">名称</span><Input autoFocus value={title} maxLength={24} onChange={e => setTitle(e.target.value)} /></label>
        <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">简介（可选）</span><Input value={description} maxLength={120} onChange={e => setDescription(e.target.value)} /></label>
        <FormError>{err}</FormError>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>取消</Button><Button disabled={busy || !title.trim()} onClick={() => void submit()}>{busy ? "保存中…" : "保存"}</Button></div>
      </div>
    </DialogContent>
  </Dialog>;
}

function LinkDialog({ mode, groupId, link, onClose, onDone }: {
  mode: "create" | "edit"; groupId: string; link?: NavLinkDto; onClose: () => void; onDone: () => Promise<void>;
}) {
  const [title, setTitle] = useState(link?.title ?? "");
  const [url, setUrl] = useState(link?.url ?? "");
  const [description, setDescription] = useState(link?.description ?? "");
  const [iconSha, setIconSha] = useState<string | null>(link?.iconUrl ? link.iconUrl.split("/").pop() ?? null : null);
  const [iconMime, setIconMime] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const preview = iconSha ? `/api/v1/nav/icons/${iconSha}` : null;

  async function grab(target = url) {
    const href = target.trim();
    if (!href || href.startsWith("/")) { setIconSha(null); setIconMime(null); return; }
    setFetching(true);
    try {
      const d = await api<{ sha256: string | null; mime: string | null }>("/api/v1/admin/nav/favicon", { method: "POST", body: JSON.stringify({ url: href }) });
      setIconSha(d.sha256);
      setIconMime(d.mime);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setFetching(false);
    }
  }

  async function submit() {
    if (!title.trim() || !url.trim()) return;
    setBusy(true); setErr("");
    try {
      const payload = {
        groupId,
        title: title.trim(),
        url: url.trim(),
        description: description.trim() || null,
        iconSha256: iconSha,
        iconMime,
        fetchIcon: !iconSha,
      };
      if (mode === "create") await api("/api/v1/admin/nav/links", { method: "POST", body: JSON.stringify(payload) });
      else await api(`/api/v1/admin/nav/links/${link!.id}`, { method: "PATCH", body: JSON.stringify({ ...payload, fetchIcon: false }) });
      await onDone();
    } catch (e) {
      setErr((e as Error).message); setBusy(false);
    }
  }

  return <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{mode === "create" ? "添加站点" : "编辑站点"}</DialogTitle>
        <DialogDescription>外链填 https://…，站内路径以 / 开头。填完地址会自动取图标。</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">地址</span>
          <Input autoFocus value={url} placeholder="https:// 或 /s/workspace/notebook" onChange={e => setUrl(e.target.value)}
            onBlur={() => { if (url.trim() && url.trim() !== link?.url) void grab(); }} />
        </label>
        <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">名称</span><Input value={title} maxLength={40} onChange={e => setTitle(e.target.value)} /></label>
        <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">简介（可选）</span><Textarea className="min-h-16" value={description} maxLength={120} onChange={e => setDescription(e.target.value)} /></label>
        <div className="flex items-center gap-3 rounded-xl border bg-muted/30 px-3 py-2.5">
          <NavIcon title={title || "站点"} iconUrl={preview} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{fetching ? "正在获取图标…" : preview ? "已取得图标" : "将显示名称首字"}</p>
            <p className="truncate text-[11px] text-muted-foreground">{url.trim() ? hostOf(url.trim()) : "填入地址后自动获取"}</p>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={fetching || !url.trim() || url.trim().startsWith("/")} onClick={() => void grab()}>
            {fetching ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}重取
          </Button>
        </div>
        <FormError>{err}</FormError>
        <div className="flex items-center justify-between gap-2">
          {url.trim().startsWith("http") ? <a className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" href={url.trim()} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-3" />预览地址</a> : <span />}
          <div className="flex gap-2"><Button variant="ghost" onClick={onClose}>取消</Button><Button disabled={busy || !title.trim() || !url.trim()} onClick={() => void submit()}>{busy ? "保存中…" : "保存"}</Button></div>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}

