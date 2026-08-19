import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import * as Tabs from "@radix-ui/react-tabs";
import { Bot, Trash2 } from "lucide-react";
import { api } from "../api";
import { McpPanel } from "./mcp-panel";
import { EmptyState, Field, Row, SectionCard, SettingsShell } from "./settings-shell";
import { Button } from "./ui/button";
import { useConfirm } from "./ui/confirm";
import { FormError } from "./ui/form-error";
import { Input } from "./ui/input";
import { useToast } from "./ui/toast";

type Provider = { id: string; baseUrl: string; chatModel: string; keySuffix: string };
type Ws = { id: string; name: string };

const DEFAULTS = { baseUrl: "https://api.openai.com/v1", chatModel: "gpt-4o-mini", apiKey: "" };

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
  const [draft, setDraft] = useState(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [p, w] = await Promise.all([
      api<{ providers: Provider[] }>(`/api/v1/workspaces/${wsId}/ai/provider`),
      api<{ workspaces: Ws[] }>("/api/v1/workspaces"),
    ]);
    setProviders(p.providers);
    setSpaces(w.workspaces);
  }, [wsId]);
  const reload = useCallback(() => {
    setLoading(true);
    load().then(() => setError("")).catch(e => setError((e as Error).message)).finally(() => setLoading(false));
  }, [load]);
  useEffect(() => { reload(); }, [reload]);

  async function save() {
    setFormErr("");
    if (!draft.baseUrl.trim() || !draft.chatModel.trim()) return setFormErr("Base URL 和模型名都不能留空。");
    if (!draft.apiKey.trim()) return setFormErr("要保存就得带上 API Key；密钥只存服务端，不会回传前端。");
    setSaving(true);
    try {
      await api(`/api/v1/workspaces/${wsId}/ai/provider`, { method: "POST", body: JSON.stringify({ ...draft, personal: false }) });
      setDraft({ ...draft, apiKey: "" });
      toast.success("已保存", "这个工作区的 AI 写作、问答和索引都会走它。");
      void load();
    } catch (e) { setFormErr((e as Error).message); }
    finally { setSaving(false); }
  }

  async function remove(p: Provider) {
    const yes = await askConfirm({
      title: `移除 ${p.chatModel}？`,
      description: "移除后这个工作区的 AI 写作、问答和索引都会停摆，直到重新配一个。",
      confirmText: "移除", destructive: true,
    });
    if (!yes) return;
    try { await api(`/api/v1/ai/providers/${p.id}`, { method: "DELETE" }); toast.success("已移除"); void load(); }
    catch (e) { toast.error("移除失败", (e as Error).message); }
  }

  return <SettingsShell wsId={wsId} current="integrations" counts={{ integrations: providers.length }} loading={loading} error={error} onRetry={reload}>
    <Tabs.Root defaultValue="ai">
      <Tabs.List className="mb-4 inline-flex rounded-lg bg-muted p-1">
        {[["ai", "AI 提供商"], ["mcp", "MCP 钥匙"]].map(([v, label]) =>
          <Tabs.Trigger key={v} value={v} className="rounded-md px-4 py-1.5 text-sm text-muted-foreground transition-colors data-[state=active]:bg-background data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-sm">{label}</Tabs.Trigger>)}
      </Tabs.List>

      <Tabs.Content value="ai" className="space-y-4 outline-none">
        <SectionCard title="接入模型" desc="任何 OpenAI 兼容的接口都行：官方、Azure、或者自建的中转。">
          <div className="grid gap-4 p-4">
            <Field label="Base URL" htmlFor="ai-base" hint="要带到 /v1 这一层，末尾不用加斜杠。">
              <Input id="ai-base" value={draft.baseUrl} onChange={e => setDraft({ ...draft, baseUrl: e.target.value })} placeholder={DEFAULTS.baseUrl} />
            </Field>
            <Field label="对话模型" htmlFor="ai-model" hint="AI 写作、问答和摘要都用它。">
              <Input id="ai-model" value={draft.chatModel} onChange={e => setDraft({ ...draft, chatModel: e.target.value })} placeholder={DEFAULTS.chatModel} />
            </Field>
            <Field label="API Key" htmlFor="ai-key" hint="只存在服务端，保存后前端只看得到后四位。">
              <Input id="ai-key" type="password" autoComplete="off" value={draft.apiKey} onChange={e => setDraft({ ...draft, apiKey: e.target.value })} placeholder="sk-…" />
            </Field>
            <FormError>{formErr}</FormError>
            <Button className="w-fit" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存工作区配置"}</Button>
          </div>
        </SectionCard>

        <SectionCard title="已配置的提供商" desc={providers.length ? `${providers.length} 个，按最近添加排序` : undefined}>
          {providers.length === 0
            ? <EmptyState icon={<Bot className="size-5" />} title="还没接模型" text="配置之前，AI 写作、问答和自动索引都是关着的。" />
            : providers.map((p, i) => <Row key={p.id} first={i === 0} icon={<Bot className="size-4" />}
              title={p.chatModel} desc={`${p.baseUrl} · Key ••••${p.keySuffix}`}
              actions={<Button variant="ghost" size="icon" className="text-destructive" aria-label={`移除 ${p.chatModel}`} onClick={() => void remove(p)}><Trash2 /></Button>} />)}
        </SectionCard>
      </Tabs.Content>

      <Tabs.Content value="mcp" className="outline-none">
        <McpPanel workspaces={spaces} defaultWorkspaceId={wsId || undefined} />
      </Tabs.Content>
    </Tabs.Root>
  </SettingsShell>;
}
