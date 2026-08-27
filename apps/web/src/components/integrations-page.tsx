import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import * as Tabs from "@radix-ui/react-tabs";
import { Bot, Pencil, Trash2 } from "lucide-react";
import { api } from "../api";
import { McpPanel } from "./mcp-panel";
import { EmptyState, Field, Row, SectionCard, SettingsShell } from "./settings-shell";
import { Button } from "./ui/button";
import { useConfirm } from "./ui/confirm";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { FormError } from "./ui/form-error";
import { Input } from "./ui/input";
import { useToast } from "./ui/toast";

type Provider = {
  id: string; baseUrl: string; chatModel: string; embeddingModel?: string | null; embeddingBaseUrl?: string | null;
  keySuffix: string; embeddingKeySuffix?: string; workspaceIds: string[]; canEditScope: boolean; canManage: boolean;
};
type Ws = { id: string; name: string; role: string };

const DEFAULTS = { baseUrl: "https://api.openai.com/v1", chatModel: "gpt-4o-mini", apiKey: "", embeddingModel: "", embeddingBaseUrl: "", embeddingApiKey: "" };

/**
 * AI 与 MCP。原来挂在全局的 /settings/integrations?workspace=xxx 下，页面上却没有一处告诉你
 * 「正在给哪个库配模型」，query 掉了就是个空表单；现在归到 /w/:wsId/settings/integrations，
 * 工作区从路由来，面包屑和左栏也就都对得上了。
 */
export function IntegrationsPage() {
  const { wsId = "" } = useParams();
  const toast = useToast();
  const askConfirm = useConfirm();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [spaces, setSpaces] = useState<Ws[]>([]);
  const [draft, setDraft] = useState({ ...DEFAULTS, workspaceIds: [] as string[] });
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState("");
  const [aiErr, setAiErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [scopeEdit, setScopeEdit] = useState<Provider | null>(null);
  const [scopeIds, setScopeIds] = useState<string[]>([]);
  const [scopeBusy, setScopeBusy] = useState(false);
  const [scopeErr, setScopeErr] = useState("");

  /** 新存的提供商要拿服务端给的 id 和 Key 后四位，只能回表；工作区列表是给 MCP 面板用的，不跟着动。 */
  const loadProviders = useCallback(async () => {
    setProviders((await api<{ providers: Provider[] }>(`/api/v1/workspaces/${wsId}/ai/provider`)).providers);
    setAiErr("");
  }, [wsId]);
  const load = useCallback(async () => {
    // 两路互不拖死：模型配置挂了不该把 MCP 钥匙一起藏起来。
    const [p, w] = await Promise.allSettled([
      api<{ providers: Provider[] }>(`/api/v1/workspaces/${wsId}/ai/provider`),
      api<{ workspaces: Ws[] }>("/api/v1/workspaces"),
    ]);
    if (p.status === "fulfilled") { setProviders(p.value.providers); setAiErr(""); }
    else { setProviders([]); setAiErr((p.reason as Error).message); }
    setSpaces(w.status === "fulfilled" ? w.value.workspaces : []);
  }, [wsId]);
  const reload = useCallback(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { setDraft(d => ({ ...d, workspaceIds: wsId ? [wsId] : [] })); }, [wsId]);

  const manageableSpaces = spaces.filter(w => w.role === "owner" || w.role === "admin");
  const canConfigureCurrent = manageableSpaces.some(w => w.id === wsId);
  const workspaceName = (id: string) => spaces.find(w => w.id === id)?.name ?? "其他工作区";
  const toggleWorkspace = (id: string) => setDraft(d => ({
    ...d,
    workspaceIds: d.workspaceIds.includes(id) ? d.workspaceIds.filter(x => x !== id) : [...d.workspaceIds, id],
  }));
  const openScopeEdit = (p: Provider) => { setScopeEdit(p); setScopeIds(p.workspaceIds); setScopeErr(""); };
  const toggleScope = (id: string) => setScopeIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);

  async function saveScope() {
    if (!scopeEdit || !scopeIds.length) return setScopeErr("至少选择一个工作区。");
    setScopeBusy(true); setScopeErr("");
    try {
      await api(`/api/v1/ai/providers/${scopeEdit.id}`, { method: "PATCH", body: JSON.stringify({ workspaceIds: scopeIds }) });
      toast.success("适用范围已更新", `现在供 ${scopeIds.length} 个工作区共用，原 Key 不变。`);
      setScopeEdit(null);
      void loadProviders();
    } catch (e) { setScopeErr((e as Error).message); }
    finally { setScopeBusy(false); }
  }

  async function save() {
    setFormErr("");
    if (!draft.baseUrl.trim() || !draft.chatModel.trim()) return setFormErr("对话的 Base URL 和模型名都不能留空。");
    if (draft.embeddingBaseUrl.trim() && !draft.embeddingModel.trim()) return setFormErr("单独配了向量地址，就要填 Embedding 模型名。");
    if (!draft.workspaceIds.length) return setFormErr("至少选择一个工作区。");
    if (!draft.workspaceIds.includes(wsId)) return setFormErr("当前工作区必须保留在适用范围内。");
    if (!canConfigureCurrent) return setFormErr("只有 Owner 或 Admin 能配置当前工作区的 AI。");
    setSaving(true);
    try {
      await api(`/api/v1/workspaces/${wsId}/ai/provider`, { method: "POST", body: JSON.stringify({
        baseUrl: draft.baseUrl.trim(),
        chatModel: draft.chatModel.trim(),
        apiKey: draft.apiKey,
        embeddingModel: draft.embeddingModel.trim() || undefined,
        embeddingBaseUrl: draft.embeddingBaseUrl.trim() || undefined,
        embeddingApiKey: draft.embeddingApiKey.trim() || undefined,
        workspaceIds: draft.workspaceIds,
        personal: false,
      }) });
      setDraft({ ...draft, apiKey: "", embeddingApiKey: "" });
      toast.success("已保存", draft.embeddingModel.trim()
        ? `${draft.workspaceIds.length} 个工作区会立刻排队重建向量索引。之后改笔记要等五分钟没再动才重嵌。`
        : `${draft.workspaceIds.length} 个工作区的 AI 写作和问答会走它。没填 Embedding 模型，语义检索不会建索引。`);
      void loadProviders();
    } catch (e) { setFormErr((e as Error).message); }
    finally { setSaving(false); }
  }

  async function remove(p: Provider) {
    const names = p.workspaceIds.map(workspaceName).join("、");
    const yes = await askConfirm({
      title: `移除 ${p.chatModel}？`,
      description: `这会从${p.workspaceIds.length > 1 ? ` ${p.workspaceIds.length} 个工作区（${names}）` : ` ${names}`}移除这份共享配置。没有其他提供商的工作区将暂停 AI 写作、问答和索引。`,
      confirmText: "移除", destructive: true,
    });
    if (!yes) return;
    try { await api(`/api/v1/ai/providers/${p.id}`, { method: "DELETE" }); toast.success("已移除"); setProviders(list => list.filter(x => x.id !== p.id)); }
    catch (e) { toast.error("移除失败", (e as Error).message); }
  }

  return <SettingsShell wsId={wsId} current="integrations" counts={{ integrations: providers.length }} loading={loading}>
    <Tabs.Root defaultValue="ai">
      <Tabs.List className="mb-4 inline-flex rounded-lg bg-muted p-1">
        {[["ai", "AI 提供商"], ["mcp", "MCP 钥匙"]].map(([v, label]) =>
          <Tabs.Trigger key={v} value={v} className="rounded-md px-4 py-1.5 text-sm text-muted-foreground transition-colors data-[state=active]:bg-background data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-sm">{label}</Tabs.Trigger>)}
      </Tabs.List>

      <Tabs.Content value="ai" className="space-y-4 outline-none">
        {aiErr && <FormError>{aiErr}</FormError>}
        <SectionCard title="接入模型" desc="对话和向量都可以是 OpenAI 兼容接口。向量可以另填地址。配上后会给已打开 AI 可读的笔记建索引，正文、PDF、图片和视频都会进；之后改一篇要等五分钟没再动才重嵌。">
          <div className="grid gap-4 p-4">
            <Field label="适用工作区" hint="一份配置可以复用到多个工作区；这里只列出你有管理权限的工作区。">
              <div className="max-h-44 overflow-auto rounded-lg border p-1">
                {manageableSpaces.length === 0
                  ? <p className="p-3 text-xs text-muted-foreground">你没有可配置 AI 的工作区。</p>
                  : manageableSpaces.map(w => <label key={w.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-muted">
                    <input type="checkbox" className="size-4 accent-current" checked={draft.workspaceIds.includes(w.id)} onChange={() => toggleWorkspace(w.id)} />
                    <span className="truncate">{w.name}{w.id === wsId ? <span className="ml-1 text-[11px] text-muted-foreground">· 当前</span> : null}</span>
                  </label>)}
              </div>
            </Field>
            <Field label="对话 Base URL" htmlFor="ai-base" hint="要带到 /v1 这一层，末尾不用加斜杠。">
              <Input id="ai-base" value={draft.baseUrl} onChange={e => setDraft({ ...draft, baseUrl: e.target.value })} placeholder={DEFAULTS.baseUrl} />
            </Field>
            <Field label="对话模型" htmlFor="ai-model" hint="AI 写作、问答和摘要都用它。">
              <Input id="ai-model" value={draft.chatModel} onChange={e => setDraft({ ...draft, chatModel: e.target.value })} placeholder={DEFAULTS.chatModel} />
            </Field>
            <Field label="对话 API Key" htmlFor="ai-key" hint="没有 Key 的兼容接口可以留空。保存后前端只看得到后四位。">
              <Input id="ai-key" type="password" autoComplete="off" value={draft.apiKey} onChange={e => setDraft({ ...draft, apiKey: e.target.value })} placeholder="sk-…" />
            </Field>
            <Field label="Embedding 模型" htmlFor="ai-embed-model" hint="语义检索和后台向量化用它。多模态接口会把图/视频一并送进去；纯文本模型会退回文件名。不填就不建索引。">
              <Input id="ai-embed-model" value={draft.embeddingModel} onChange={e => setDraft({ ...draft, embeddingModel: e.target.value })} placeholder="text-embedding-3-small" />
            </Field>
            <Field label="Embedding Base URL" htmlFor="ai-embed-base" hint="留空则跟对话同一地址。独立向量服务填到 /v1 这一层。">
              <Input id="ai-embed-base" value={draft.embeddingBaseUrl} onChange={e => setDraft({ ...draft, embeddingBaseUrl: e.target.value })} placeholder="https://embed.example.com/v1" />
            </Field>
            <Field label="Embedding API Key" htmlFor="ai-embed-key" hint="只在单独填了向量地址时使用；没有就留空。跟对话共用地址时走上面那把 Key。">
              <Input id="ai-embed-key" type="password" autoComplete="off" value={draft.embeddingApiKey} onChange={e => setDraft({ ...draft, embeddingApiKey: e.target.value })} placeholder="可选" />
            </Field>
            <FormError>{formErr}</FormError>
            <Button className="w-fit" disabled={saving || !canConfigureCurrent || !draft.workspaceIds.length || !draft.workspaceIds.includes(wsId)} onClick={() => void save()}>{saving ? "保存中…" : `保存并应用到 ${draft.workspaceIds.length || 0} 个工作区`}</Button>
          </div>
        </SectionCard>

        <SectionCard title="已配置的提供商" desc={providers.length ? `${providers.length} 个，按最近添加排序` : undefined}>
          {providers.length === 0
            ? <EmptyState icon={<Bot className="size-5" />} title="还没接模型" text="配置之前，AI 写作、问答和自动索引都是关着的。" />
            : providers.map((p, i) => <Row key={p.id} first={i === 0} icon={<Bot className="size-4" />}
              title={p.chatModel} desc={`${p.baseUrl} · Key ${p.keySuffix ? `••••${p.keySuffix}` : "无"} · 向量 ${p.embeddingModel || "未配"}${p.embeddingBaseUrl ? ` @ ${p.embeddingBaseUrl}` : ""} · ${p.workspaceIds.map(workspaceName).join("、")}`}
              actions={p.canEditScope || p.canManage ? <>{p.canEditScope && <Button variant="ghost" size="sm" onClick={() => openScopeEdit(p)}><Pencil />调整范围</Button>}{p.canManage && <Button variant="ghost" size="icon" className="text-destructive" aria-label={`移除 ${p.chatModel}`} onClick={() => void remove(p)}><Trash2 /></Button>}</> : undefined} />)}
        </SectionCard>
      </Tabs.Content>

      <Tabs.Content value="mcp" className="outline-none">
        <McpPanel workspaces={spaces} defaultWorkspaceId={wsId || undefined} />
      </Tabs.Content>
    </Tabs.Root>

    <Dialog open={scopeEdit !== null} onOpenChange={open => { if (!open) setScopeEdit(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>调整 {scopeEdit?.chatModel} 的适用范围</DialogTitle>
          <DialogDescription>只改工作区绑定，模型参数和已保存的 API Key 都不会改变。</DialogDescription>
        </DialogHeader>
        <div className="max-h-64 overflow-auto rounded-lg border p-1">
          {manageableSpaces.map(w => <label key={w.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-muted">
            <input type="checkbox" className="size-4 accent-current" checked={scopeIds.includes(w.id)} onChange={() => toggleScope(w.id)} />
            <span className="truncate">{w.name}</span>
          </label>)}
        </div>
        <FormError>{scopeErr}</FormError>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setScopeEdit(null)}>取消</Button>
          <Button disabled={scopeBusy || !scopeIds.length} onClick={() => void saveScope()}>{scopeBusy ? "保存中…" : "保存范围"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </SettingsShell>;
}
