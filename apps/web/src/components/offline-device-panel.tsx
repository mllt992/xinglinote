import { useEffect, useState } from "react";
import { api, type Me } from "../api";
import { deviceChanged, deviceStorage, type LocalNoteDraft } from "../lib/device-storage";
import { Button } from "./ui/button";
import { useConfirm } from "./ui/confirm";

export function OfflineDevicePanel() {
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState("");
  const [count, setCount] = useState(0);
  const [drafts, setDrafts] = useState<LocalNoteDraft[]>([]);
  const confirm = useConfirm();
  useEffect(() => {
    let cancelled = false;
    const update = () => { setEnabled(deviceStorage.enabled()); setCount(deviceStorage.snapshots().length); setDrafts(deviceStorage.listDrafts()); };
    void api<Me>("/api/v1/me").then(() => { if (!cancelled) { setReady(true); update(); } }).catch(() => { if (!cancelled) setMessage("请联网登录后管理本机存储"); });
    window.addEventListener("kb:device-storage", update);
    return () => { cancelled = true; window.removeEventListener("kb:device-storage", update); };
  }, []);
  async function toggle() {
    if (!enabled && !await confirm({ title: "这是你的可信设备吗？", description: "开启后，最近笔记、今天快照和未同步草稿将以明文存储在此浏览器。能使用本机或浏览器数据的人可能读取它们。仅在自己的受保护设备上开启，公共电脑请勿开启。", confirmText: "这是我的设备，开启" })) return;
    if (deviceStorage.consent(!enabled)) { setEnabled(!enabled); setCount(0); setMessage(enabled ? "已关闭并清除阅读快照。未同步草稿保留到原账号恢复或主动丢弃。" : "已开启。请重新打开需要离线阅读的笔记和今天页。后续编辑会暂存在本机。切勿把本机暂存当成备份。"); deviceChanged(); }
    else setMessage("浏览器拒绝本机存储，尚未开启。请检查隐私模式与存储空间。");
  }
  return <section className="space-y-3 rounded-xl border bg-background p-5" aria-label="本机离线与草稿">
    <h2 className="font-semibold">本机离线与草稿</h2>
    <p className="text-sm text-muted-foreground">{enabled ? `已开启 · ${count} 份只读快照` : "默认关闭，不在公共设备自动保存正文"}。最多 10 篇笔记、3 个今天快照，7 天后过期。图片、附件与全库同步不在离线范围内。</p>
    <p className="text-xs text-muted-foreground">登出会清除阅读快照；未同步草稿保留在原账号下，重新登录该账号才能恢复。离线下载的内容无法随远端权限变更撤回。</p>
    <div className="flex flex-wrap gap-2"><Button disabled={!ready} onClick={() => void toggle()}>{enabled ? "关闭本机暂存" : "开启可信设备暂存"}</Button><Button variant="outline" onClick={() => { deviceStorage.clearSnapshots(); setCount(0); }}>清除阅读快照</Button><a className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm" href="/offline.html">打开离线阅读</a></div>
    <p className="text-xs text-muted-foreground">添加到主屏幕：在浏览器菜单选择「安装应用」；iPhone/iPad 用 Safari 分享菜单 → 添加到主屏幕。需要 HTTPS（本机 localhost 除外）。</p>
    {drafts.length > 0 && <div className="space-y-2 border-t pt-3"><h3 className="text-sm font-medium">本账号未同步草稿（{drafts.length}）</h3>{drafts.map(draft => <div key={draft.id} className="rounded-lg border p-3"><p className="text-sm">{draft.title} · {new Date(draft.savedAt).toLocaleString()}</p><div className="mt-2 flex flex-wrap gap-2"><a className="text-sm underline" href={`/w/${draft.workspaceId}/n/${draft.id}`}>回到笔记恢复</a><Button size="sm" variant="outline" onClick={() => downloadDraft(draft)}>下载草稿</Button><Button size="sm" variant="ghost" onClick={async () => { if (await confirm({ title: "丢弃本机未同步草稿？", description: "此操作不能撤销。建议先下载一份；远端笔记不会被修改。", confirmText: "丢弃草稿", destructive: true })) { deviceStorage.discardDraft(draft.id); setDrafts(deviceStorage.listDrafts()); } }}>丢弃</Button></div></div>)}</div>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}

function downloadDraft(draft: LocalNoteDraft) {
  const url = URL.createObjectURL(new Blob([`# ${draft.title}\n\n${draft.bodyMd}`], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = "星璃-未同步草稿.md"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function LocalDraftRecovery({ draft, canEdit, onRestore, onDiscard }: { draft: LocalNoteDraft; canEdit: boolean; onRestore: () => void; onDiscard: () => void }) {
  const confirm = useConfirm();
  function download() { downloadDraft(draft); }
  return <section role="status" className="max-h-[50vh] shrink-0 space-y-2 overflow-auto border-b border-amber-500/50 bg-amber-500/10 p-3">
    <p className="font-medium">有本机未同步草稿</p><p className="text-xs">{new Date(draft.savedAt).toLocaleString()} · 基于 v{draft.version}。恢复后先退出本篇协同，保存仍检查版本，不会自动覆盖远端。</p>
    <details><summary className="cursor-pointer text-sm">查看草稿</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{draft.title}{"\n\n"}{draft.bodyMd}</pre></details>
    <div className="flex flex-wrap gap-2"><Button size="sm" disabled={!canEdit} onClick={onRestore}>恢复到编辑器</Button><Button size="sm" variant="outline" onClick={download}>下载草稿</Button><Button size="sm" variant="ghost" onClick={async () => { if (await confirm({ title: "丢弃本机未同步草稿？", description: "只删除这篇的本机草稿，不会修改远端。未下载的内容无法恢复。", confirmText: "丢弃草稿", destructive: true })) onDiscard(); }}>丢弃本机草稿</Button></div>
  </section>;
}
