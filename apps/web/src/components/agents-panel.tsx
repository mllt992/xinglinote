import { useEffect, useRef, useState, type ReactNode, type Dispatch, type SetStateAction } from "react";
import { Bot, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../api";
import { AgentAvatar } from "./agent-avatar";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useConfirm } from "./ui/confirm";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { useToast } from "./ui/toast";

export type AdminAgent = {
  id: string;
  handle: string;
  displayName: string;
  bio: string | null;
  avatarEmoji: string;
  avatarUrl?: string | null;
  systemPrompt?: string;
  enabled: boolean;
  allowSquare: boolean;
  allowCircle: boolean;
  knowledgeEnabled: boolean;
  aiSource?: "own" | "platform" | "auto";
  providerId?: string | null;
  providerName?: string | null;
  baseUrl: string;
  chatModel: string;
  keyConfigured: boolean;
  keySuffix: string;
  createdAt: string;
};

type Form = {
  handle: string;
  displayName: string;
  bio: string;
  avatarEmoji: string;
  avatarSha256: string | null;
  avatarMime: string | null;
  systemPrompt: string;
  enabled: boolean;
  allowSquare: boolean;
  allowCircle: boolean;
  knowledgeEnabled: boolean;
  aiSource: "own" | "platform" | "auto";
  providerId: string;
  baseUrl: string;
  chatModel: string;
  apiKey: string;
};

const EMPTY: Form = {
  handle: "", displayName: "", bio: "", avatarEmoji: "🤖", avatarSha256: null, avatarMime: null,
  systemPrompt: "你是这个知识库的助手。用简洁的中文回答动态里的问题，不知道就直说。",
  enabled: true, allowSquare: true, allowCircle: true, knowledgeEnabled: false,
  aiSource: "own", providerId: "", baseUrl: "", chatModel: "", apiKey: "",
};

const EMOJIS = ["🤖", "🧠", "📚", "✨", "🪄", "🦊", "🐱", "🧭"];

function Field({ title, children }: { title: string; children: ReactNode }) {
  return <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">{title}</span>{children}</label>;
}

export function AgentsPanel() {
  const toast = useToast();
  const askConfirm = useConfirm();
  const [agents, setAgents] = useState<AdminAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AdminAgent | null | "new">(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [avatarDirty, setAvatarDirty] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => api<{ agents: AdminAgent[] }>("/api/v1/admin/agents")
    .then(d => setAgents(d.agents))
    .catch(e => toast.error("智能体没加载出来", (e as Error).message))
    .finally(() => setLoading(false));

  useEffect(() => { void load(); }, []);

  function openNew() {
    setForm(EMPTY);
    setPreview(null);
    setAvatarDirty(false);
    setEditing("new");
  }
  function openEdit(a: AdminAgent) {
    setForm({
      handle: a.handle, displayName: a.displayName, bio: a.bio ?? "", avatarEmoji: a.avatarEmoji || "🤖",
      avatarSha256: null, avatarMime: null,
      systemPrompt: a.systemPrompt ?? "", enabled: a.enabled, allowSquare: a.allowSquare, allowCircle: a.allowCircle,
      knowledgeEnabled: a.knowledgeEnabled, aiSource: a.aiSource ?? "own", providerId: a.providerId ?? "",
      baseUrl: a.baseUrl, chatModel: a.chatModel,
      apiKey: a.keyConfigured ? `••••${a.keySuffix}` : "",
    });
    setPreview(a.avatarUrl ?? null);
    setAvatarDirty(false);
    setEditing(a);
  }

  async function uploadAvatar(file: File) {
    const body = new FormData();
    body.append("file", file);
    const res = await fetch("/api/v1/admin/agents/avatar", { method: "POST", body, credentials: "include", headers: { "X-Requested-With": "fetch" } });
    const json = await res.json() as { ok: true; data: { sha256: string; mime: string } } | { ok: false; error: { message: string } };
    if (!json.ok) throw new Error(json.error.message);
    return json.data;
  }

  async function save() {
    if (form.aiSource === "own" && (!form.baseUrl.trim() || !form.chatModel.trim())) return toast.error("还不能保存", "请填写接口地址和模型名。");
    if (form.aiSource === "platform" && (!form.providerId || !form.chatModel.trim())) return toast.error("还不能保存", "请选择平台渠道和模型。");
    setBusy(true);
    try {
      const body = {
        handle: form.handle.trim().toLowerCase(),
        displayName: form.displayName.trim(),
        bio: form.bio.trim() || null,
        avatarEmoji: form.avatarEmoji.trim() || "🤖",
        ...(avatarDirty || editing === "new" ? { avatarSha256: form.avatarSha256, avatarMime: form.avatarMime } : {}),
        systemPrompt: form.systemPrompt.trim(),
        enabled: form.enabled,
        allowSquare: form.allowSquare,
        allowCircle: form.allowCircle,
        knowledgeEnabled: form.knowledgeEnabled,
        aiSource: form.aiSource,
        providerId: form.aiSource === "platform" ? form.providerId : null,
        baseUrl: form.aiSource === "own" ? form.baseUrl.trim() : "",
        chatModel: form.aiSource === "auto" ? "" : form.chatModel.trim(),
        apiKey: form.aiSource === "own" ? form.apiKey : "",
      };
      if (editing === "new") await api("/api/v1/admin/agents", { method: "POST", body: JSON.stringify(body) });
      else if (editing) await api(`/api/v1/admin/agents/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) });
      toast.success(editing === "new" ? "智能体已创建" : "智能体已更新");
      setEditing(null);
      await load();
    } catch (e) {
      toast.error("没能保存", (e as Error).message);
    } finally { setBusy(false); }
  }

  async function toggle(a: AdminAgent, enabled: boolean) {
    try {
      await api(`/api/v1/admin/agents/${a.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
      setAgents(list => list.map(x => x.id === a.id ? { ...x, enabled } : x));
    } catch (e) {
      toast.error("更新失败", (e as Error).message);
    }
  }

  async function remove(a: AdminAgent) {
    if (!await askConfirm({ title: `删除 @${a.handle}？`, description: "旧评论还在，只是不会再被 @ 到。这个标识会继续占用，避免被人拿去冒充。", confirmText: "删除", destructive: true })) return;
    try {
      await api(`/api/v1/admin/agents/${a.id}`, { method: "DELETE" });
      toast.success("已删除智能体");
      setAgents(list => list.filter(x => x.id !== a.id));
    } catch (e) {
      toast.error("删除失败", (e as Error).message);
    }
  }

  return <div className="space-y-5">
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-9 place-items-center rounded-lg bg-muted"><Bot className="size-4" /></span>
        <div>
          <h2 className="text-sm font-semibold">可被动态 @ 的助手</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">每个智能体有自己的人设和模型。用户在广场或圈子里写下 @标识，它会以评论回复。</p>
        </div>
      </div>
      <Button onClick={openNew}><Plus />新建智能体</Button>
    </section>

    {loading && <div className="h-28 animate-pulse rounded-xl border bg-muted/60" />}
    {!loading && agents.length === 0 && <div className="rounded-xl border border-dashed py-14 text-center">
      <p className="text-sm font-medium">还没有智能体</p>
      <p className="mt-1 text-xs text-muted-foreground">先建一个，再去动态里 @ 它试试。</p>
    </div>}
    {!loading && agents.map(a => <article key={a.id} className="flex flex-wrap items-start gap-4 rounded-xl border bg-background p-5">
      <span className="grid size-11 place-items-center overflow-hidden rounded-xl bg-muted text-xl">
        <AgentAvatar emoji={a.avatarEmoji} url={a.avatarUrl} label={a.displayName} className="size-11 text-xl" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold">{a.displayName}</p>
          <span className="text-xs text-muted-foreground">@{a.handle}</span>
          {!a.enabled && <Badge>已停用</Badge>}
        </div>
        {a.bio && <p className="mt-1 text-xs text-muted-foreground">{a.bio}</p>}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {a.allowSquare && <Badge>广场</Badge>}
          {a.allowCircle && <Badge>圈子</Badge>}
          {a.knowledgeEnabled && <Badge>检索公开笔记</Badge>}
          <Badge className="font-normal text-muted-foreground">{a.aiSource === "platform" ? `平台提供${a.providerName ? ` · ${a.providerName}` : ""}${a.chatModel ? ` · ${a.chatModel}` : ""}` : a.aiSource === "auto" ? "自动选择" : (a.chatModel || "自己的接口")}</Badge>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Switch checked={a.enabled} label={`启用 ${a.displayName}`} onCheckedChange={v => void toggle(a, v)} />
        <Button variant="ghost" size="icon" aria-label="编辑" onClick={() => openEdit(a)}><Pencil /></Button>
        <Button variant="ghost" size="icon" aria-label="删除" onClick={() => void remove(a)}><Trash2 /></Button>
      </div>
    </article>)}

    <Dialog open={editing !== null} onOpenChange={v => { if (!v) setEditing(null); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing === "new" ? "新建智能体" : "编辑智能体"}</DialogTitle>
          <DialogDescription>人设会进系统提示。模型可以用站点准备的，也可以接自己的服务。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field title="显示名"><Input value={form.displayName} maxLength={40} onChange={e => setForm({ ...form, displayName: e.target.value })} /></Field>
            <Field title="标识"><Input value={form.handle} maxLength={32} placeholder="archivist" onChange={e => setForm({ ...form, handle: e.target.value.toLowerCase() })} /></Field>
          </div>
          <Field title="简介"><Input value={form.bio} maxLength={200} placeholder="一句话说明它擅长什么" onChange={e => setForm({ ...form, bio: e.target.value })} /></Field>
          <Field title="头像">
            <div className="flex flex-wrap items-center gap-2">
              <span className="grid size-12 place-items-center overflow-hidden rounded-xl border bg-muted text-2xl">
                <AgentAvatar emoji={form.avatarEmoji} url={preview} label={form.displayName} className="size-12 text-2xl" />
              </span>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden"
                onChange={async e => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  try {
                    const uploaded = await uploadAvatar(file);
                    setForm(f => ({ ...f, avatarSha256: uploaded.sha256, avatarMime: uploaded.mime }));
                    setAvatarDirty(true);
                    setPreview(URL.createObjectURL(file));
                  } catch (err) {
                    toast.error("头像没传上", (err as Error).message);
                  }
                }} />
              <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>上传图片</Button>
              {preview && <Button type="button" variant="ghost" size="sm" onClick={() => { setForm(f => ({ ...f, avatarSha256: null, avatarMime: null })); setAvatarDirty(true); setPreview(null); }}>去掉图片</Button>}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EMOJIS.map(e => <button key={e} type="button" onClick={() => setForm({ ...form, avatarEmoji: e })}
                className={`grid size-9 place-items-center rounded-lg border text-lg ${form.avatarEmoji === e ? "border-primary bg-primary/10" : "bg-background"}`}>{e}</button>)}
            </div>
          </Field>
          <Field title="人设与职责"><Textarea value={form.systemPrompt} maxLength={4000} className="min-h-28" onChange={e => setForm({ ...form, systemPrompt: e.target.value })} /></Field>
          <div className="grid gap-3 rounded-lg border px-3 py-3">
            <div className="flex items-center justify-between gap-3"><div><p className="text-sm">启用</p><p className="text-xs text-muted-foreground">关掉后补全里不再出现，也不会回复新的 @。</p></div><Switch checked={form.enabled} label="启用" onCheckedChange={v => setForm({ ...form, enabled: v })} /></div>
            <div className="flex items-center justify-between gap-3"><div><p className="text-sm">广场</p><p className="text-xs text-muted-foreground">允许在公开动态里被叫到。</p></div><Switch checked={form.allowSquare} label="广场" onCheckedChange={v => setForm({ ...form, allowSquare: v })} /></div>
            <div className="flex items-center justify-between gap-3"><div><p className="text-sm">圈子</p><p className="text-xs text-muted-foreground">允许在工作区动态里被叫到。</p></div><Switch checked={form.allowCircle} label="圈子" onCheckedChange={v => setForm({ ...form, allowCircle: v })} /></div>
            <div className="flex items-center justify-between gap-3"><div><p className="text-sm">检索公开笔记</p><p className="text-xs text-muted-foreground">只读已发布到文档站且允许 AI 读的篇，不会碰到私密本。</p></div><Switch checked={form.knowledgeEnabled} label="检索公开笔记" onCheckedChange={v => setForm({ ...form, knowledgeEnabled: v })} /></div>
          </div>
          <AgentModelFields form={form} setForm={setForm} />
        </div>
                <div className="flex flex-wrap justify-end gap-2">
          {editing && editing !== "new" && <Button type="button" variant="outline" disabled={testing || busy} onClick={async () => {
            setTesting(true);
            try {
              const d = await api<{ reply: string }>(`/api/v1/admin/agents/${editing.id}/test`, { method: "POST", body: JSON.stringify({}) });
              toast.success("模型通了", d.reply);
            } catch (e) {
              toast.error("模型没通", (e as Error).message);
            } finally { setTesting(false); }
          }}>{testing ? "在试…" : "试一下模型"}</Button>}
          <Button variant="ghost" onClick={() => setEditing(null)}>取消</Button>
          <Button disabled={busy || !form.displayName.trim() || !form.handle.trim() || !form.systemPrompt.trim()} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}

type PlatformChannel = { id: string; name: string; models: string[]; platformDefault: boolean };
function AgentModelFields({ form, setForm }: { form: Form; setForm: Dispatch<SetStateAction<Form>> }) {
  const toast = useToast();
  const [channels, setChannels] = useState<PlatformChannel[]>([]);
  useEffect(() => {
    api<{ channels: Array<PlatformChannel & { enabled?: boolean }> }>("/api/v1/admin/ai/platform").then(d => setChannels(d.channels.filter(c => c.enabled !== false))).catch(e => toast.error("平台渠道没读到", (e as Error).message));
  }, [toast]);
  const current = channels.find(c => c.id === form.providerId);
  return <div className="grid gap-3">
    <Field title="模型来源">
      <select className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm" value={form.aiSource} onChange={e => setForm({ ...form, aiSource: e.target.value as Form["aiSource"] })}>
        <option value="auto">自动（回复时按私人渠道、工作区渠道、平台默认的顺序）</option>
        <option value="platform">平台提供</option>
        <option value="own">自己的接口</option>
      </select>
    </Field>
    {form.aiSource === "auto" && <p className="text-xs leading-5 text-muted-foreground">有人 @ 它时，用那个人在动态所在工作区会自动用到的渠道。广场上没有工作区时，用平台默认渠道。用到平台渠道会计入那个人当天的额度。</p>}
    {form.aiSource === "platform" && <>
      <Field title="平台渠道">
        <select className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm" value={form.providerId} onChange={e => {
          const id = e.target.value;
          const ch = channels.find(c => c.id === id);
          setForm({ ...form, providerId: id, chatModel: ch?.models.includes(form.chatModel) ? form.chatModel : ch?.models[0] ?? "" });
        }}>
          <option value="">选择渠道</option>
          {channels.map(c => <option key={c.id} value={c.id}>{c.name}{c.platformDefault ? "（默认）" : ""}</option>)}
        </select>
      </Field>
      <Field title="模型">
        <select className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm" value={form.chatModel} disabled={!current} onChange={e => setForm({ ...form, chatModel: e.target.value })}>
          {(current?.models ?? []).map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
      <p className="text-xs text-muted-foreground">只显示渠道名称和开放的模型。接口地址和密钥在「平台 AI」里管理。</p>
    </>}
    {form.aiSource === "own" && <>
      <Field title="接口地址"><Input value={form.baseUrl} placeholder="https://api.openai.com/v1" onChange={e => setForm({ ...form, baseUrl: e.target.value })} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field title="模型名"><Input value={form.chatModel} placeholder="所用模型的名字" onChange={e => setForm({ ...form, chatModel: e.target.value })} /></Field>
        <Field title="密钥"><Input type="password" value={form.apiKey} placeholder={form.apiKey.startsWith("••") ? "不改请留着" : "服务商提供的密钥"} onChange={e => setForm({ ...form, apiKey: e.target.value })} /></Field>
      </div>
      <p className="text-xs text-muted-foreground">自己的接口不占平台额度，也不会出现在其他人的渠道列表里。</p>
    </>}
  </div>;
}
