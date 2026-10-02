/** 公开模型目录与请求级权限判定；不接受目录之外的模型。 */
export function chatSelectionAllowed(provider: { enabled: boolean; ownerUserId: string | null; chatModels: unknown; chatModel: string | null }, userId: string, model: string) {
  if (!provider.enabled || (provider.ownerUserId && provider.ownerUserId !== userId)) return false;
  const catalog = Array.isArray(provider.chatModels) ? provider.chatModels.filter((m): m is string => typeof m === "string" && !!m) : [];
  const defaultModel = provider.chatModel?.trim() || catalog[0] || "";
  return [...catalog, defaultModel].includes(model) && !!model;
}
