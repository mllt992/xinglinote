import { useEffect, useState } from "react";
import { api } from "../api";
import { DEVICE_PREFIX, deviceStorage } from "../lib/device-storage";

export type ChatSelection = { providerId: string; model: string };
type Options = { userId: string; channels: { id: string; name: string; source: string; models: string[] }[]; effective: { providerId: string; model: string; source: string } | null; explicitWorkspace: boolean };

export function useAiModel(workspaceId?: string) {
  const [revision, setRevision] = useState(0);
  const epoch = deviceStorage.epoch();
  const identity = deviceStorage.identity();
  const [state, setState] = useState<{ workspaceId?: string; epoch: number; identity: string | null; data: Options | null; value: string; error: string }>({ epoch, identity, data: null, value: "", error: "" });
  useEffect(() => {
    const changed = () => { setState({ workspaceId, epoch: deviceStorage.epoch(), identity: deviceStorage.identity(), data: null, value: "", error: "" }); setRevision(r => r + 1); };
    const storage = (event: StorageEvent) => { if (!event.key || event.key === `${DEVICE_PREFIX}authVersion` || event.key === `${DEVICE_PREFIX}active`) changed(); };
    window.addEventListener("storage", storage);
    window.addEventListener("kb:me-updated", changed);
    window.addEventListener("kb:device-storage", changed);
    return () => { window.removeEventListener("storage", storage); window.removeEventListener("kb:me-updated", changed); window.removeEventListener("kb:device-storage", changed); };
  }, [workspaceId]);
  useEffect(() => {
    const controller = new AbortController();
    const requestEpoch = deviceStorage.epoch();
    const requestIdentity = deviceStorage.identity();
    const live = () => !controller.signal.aborted && requestEpoch === deviceStorage.epoch() && requestIdentity === deviceStorage.identity();
    setState({ workspaceId, epoch: requestEpoch, identity: requestIdentity, data: null, value: "", error: "" });
    if (workspaceId && requestIdentity) api<Options>(`/api/v1/workspaces/${workspaceId}/ai/chat-options`, { signal: controller.signal })
      .then(data => { if (live() && data.userId === requestIdentity) setState({ workspaceId, epoch: requestEpoch, identity: requestIdentity, data, value: "", error: "" }); })
      .catch(e => { if (live()) setState({ workspaceId, epoch: requestEpoch, identity: requestIdentity, data: null, value: "", error: (e as Error).message }); });
    return () => controller.abort();
  }, [workspaceId, epoch, identity, revision]);
  const current = state.workspaceId === workspaceId && state.epoch === epoch && state.identity === identity ? state : { epoch, identity, data: null, value: "", error: "" };
  const selection: ChatSelection | undefined = current.value ? JSON.parse(current.value) as ChatSelection : undefined;
  return { ...current, selection, isCurrent: () => epoch === deviceStorage.epoch() && identity === deviceStorage.identity(), setValue: (value: string) => setState(s => ({ ...s, value })) };
}

export function AiModelSelect({ model, disabled }: { model: ReturnType<typeof useAiModel>; disabled?: boolean }) {
  const selectedChannel = model.data?.channels.find(c => c.id === model.selection?.providerId);
  const current = model.selection ? `${model.selection.model} · ${selectedChannel?.source ?? "不可用"}` : model.data?.effective ? `${model.data.effective.model} · ${model.data.effective.source}` : "暂无可用模型";
  return <div className="space-y-1 text-xs">
    <label className="block">对话模型
      <select aria-label="对话模型" className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-foreground" disabled={disabled || !model.data} value={model.value} onChange={e => model.setValue(e.target.value)}>
        <option value="">自动 · {model.data?.explicitWorkspace ? "工作区指定配置" : "个人 → 工作区共享 → 平台默认"}</option>
        {model.data?.channels.map(c => <optgroup key={c.id} label={`${c.name} · ${c.source}`}>{c.models.map(m => <option key={m} value={JSON.stringify({ providerId: c.id, model: m })}>{m}</option>)}</optgroup>)}
      </select>
    </label>
    <p className="text-muted-foreground">当前：{current}。手动选择仅用于本次入口，不修改工作区配置。</p>
    {model.error && <p role="alert" className="text-destructive">模型目录加载失败：{model.error}</p>}
  </div>;
}
