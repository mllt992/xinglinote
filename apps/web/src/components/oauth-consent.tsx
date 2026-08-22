import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api } from "../api";
import { Button } from "./ui/button";
import { FormError } from "./ui/form-error";

type Req = {
  clientName: string;
  redirectHost: string;
  scope: string;
  resource: string;
  workspaces: Array<{ id: string; name: string; role: string }>;
};
type Nb = { id: string; title: string };

const RW = [
  { v: "read", title: "只读", desc: "检索、读取、问答。不能改任何内容。" },
  { v: "write", title: "读写", desc: "在只读之上，可新建、追加、修改笔记。" },
  { v: "manage", title: "全部", desc: "在读写之上，可移动、打标签、删到回收站。" },
] as const;
type Rw = (typeof RW)[number]["v"];

/** 请求的 scope 只作为默认勾选，最终给多少由用户在这页说了算。 */
function defaultRw(scope: string): Rw {
  if (scope.includes("knowledge.manage")) return "manage";
  if (scope.includes("knowledge.write")) return "write";
  return "read";
}

/** OAuth 同意页：把 MCP 钥匙的那套权限维度摆出来让用户勾。 */
export function OauthConsent() {
  const id = new URLSearchParams(location.search).get("request") ?? "";
  const [req, setReq] = useState<Req | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [notebooks, setNotebooks] = useState<Nb[]>([]);

  const [workspaceIds, setWorkspaceIds] = useState<string[]>([]);
  const [rw, setRw] = useState<Rw>("read");
  const [mode, setMode] = useState<"inherit" | "allowlist">("inherit");
  const [notebookIds, setNotebookIds] = useState<string[]>([]);
  const [allowDelete, setAllowDelete] = useState(false);
  const [requireAiIndex, setRequireAiIndex] = useState(true);
  const [allowPrivate, setAllowPrivate] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState<number | null>(null);

  useEffect(() => {
    if (!id) return setErr("链接里缺少 request 参数");
    api<Req>(`/api/v1/oauth/requests/${id}`).then((d) => {
      setReq(d);
      setWorkspaceIds(d.workspaces[0]?.id ? [d.workspaces[0].id] : []);
      setRw(defaultRw(d.scope));
    }).catch((e: Error & { code?: string }) => {
      if (e.code === "UNAUTHENTICATED") {
        location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
        return;
      }
      setErr(e.message);
    });
  }, [id]);

  useEffect(() => {
    if (!workspaceIds.length) return setNotebooks([]);
    void Promise.all(workspaceIds.map((id) =>
      api<{ notebooks: Nb[] }>(`/api/v1/workspaces/${id}/notebooks`)
        .then((d) => d.notebooks).catch(() => [] as Nb[]),
    )).then((groups) => setNotebooks(groups.flat()));
    setNotebookIds([]);
  }, [workspaceIds.join(",")]);

  async function decide(action: "approve" | "deny") {
    setBusy(true); setErr("");
    try {
      const body = action === "approve" ? JSON.stringify({
        workspaceIds, rw, notebookMode: mode,
        notebookIds: mode === "allowlist" ? notebookIds : [],
        allowDelete: rw === "manage" && allowDelete,
        requireAiIndex, allowPrivateNotebooks: allowPrivate,
        feedPublic: false, feedWorkspace: false,
        dailyWriteLimitBytes: null, expiresInDays,
      }) : undefined;
      const d = await api<{ redirect: string }>(`/api/v1/oauth/requests/${id}/${action}`, { method: "POST", body });
      location.replace(d.redirect);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  if (err && !req) return <Shell><FormError>{err}</FormError></Shell>;
  if (!req) return <Shell><p className="text-sm text-muted-foreground">正在读取授权请求…</p></Shell>;

  const viewerOnly = req.workspaces.some((w) => workspaceIds.includes(w.id) && w.role === "viewer");
  useEffect(() => {
    if (viewerOnly && rw !== "read") { setRw("read"); setAllowDelete(false); }
  }, [viewerOnly, rw]);
  function toggleWorkspace(id: string) {
    setWorkspaceIds((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  }

  return <Shell>
    <div className="grid gap-4">
      <div className="rounded-xl border bg-muted/30 p-4">
        <p className="text-sm"><b>{req.clientName}</b> 想代表你访问这个知识库。</p>
        <p className="mt-1 text-xs text-muted-foreground">授权后会回到 {req.redirectHost}。资源：{req.resource}</p>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">授权哪些工作区</p>
        <p className="mb-2 text-[11px] text-muted-foreground">可多选。权限不会超过你在每个区自己的权限。</p>
        <div className="max-h-44 overflow-auto rounded-lg border p-1">
          {req.workspaces.map((w) => <label key={w.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-muted">
            <input type="checkbox" className="size-4 accent-current" checked={workspaceIds.includes(w.id)} onChange={() => toggleWorkspace(w.id)} />
            <span className="truncate">{w.name}</span>
          </label>)}
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">给到什么程度</p>
        <div className="grid gap-2 md:grid-cols-3">
          {RW.map((o) => <button key={o.v} type="button" disabled={viewerOnly && o.v !== "read"}
            onClick={() => { setRw(o.v); if (o.v !== "manage") setAllowDelete(false); }}
            className={`rounded-lg border p-3 text-left transition disabled:opacity-40 ${rw === o.v ? "border-foreground bg-muted" : "hover:bg-muted/50"}`}>
            <span className="text-sm font-medium">{o.title}</span>
            <span className="mt-1 block text-xs text-muted-foreground">{o.desc}</span>
          </button>)}
        </div>
        {viewerOnly && <p className="mt-1.5 text-[11px] text-muted-foreground">你在勾选的某个工作区是 Viewer，只能授权只读。</p>}
      </div>

      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">笔记本范围</p>
        <div className="grid gap-2 md:grid-cols-2">
          <button type="button" onClick={() => setMode("inherit")} className={`rounded-lg border p-3 text-left text-sm transition ${mode === "inherit" ? "border-foreground bg-muted" : "hover:bg-muted/50"}`}>跟随我的权限<span className="mt-1 block text-xs text-muted-foreground">以后新增的笔记本自动包含。</span></button>
          <button type="button" onClick={() => setMode("allowlist")} className={`rounded-lg border p-3 text-left text-sm transition ${mode === "allowlist" ? "border-foreground bg-muted" : "hover:bg-muted/50"}`}>指定笔记本<span className="mt-1 block text-xs text-muted-foreground">只给勾选的这几本。</span></button>
        </div>
        {mode === "allowlist" && <div className="mt-2 max-h-44 overflow-auto rounded-lg border p-1">
          {notebooks.length === 0 ? <p className="p-3 text-xs text-muted-foreground">{workspaceIds.length ? "勾选的工作区还没有笔记本。" : "先勾选工作区。"}</p>
            : notebooks.map((n) => <label key={n.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-muted">
              <input type="checkbox" className="size-4 accent-current" checked={notebookIds.includes(n.id)}
                onChange={(e) => setNotebookIds(e.target.checked ? [...notebookIds, n.id] : notebookIds.filter((x) => x !== n.id))} />
              <span className="truncate">{n.title}</span>
            </label>)}
        </div>}
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        <Toggle checked={allowDelete} disabled={rw !== "manage"} onChange={setAllowDelete} title="允许删除" desc={rw === "manage" ? "可以把笔记删到回收站。" : "只有「全部」档位能开。"} />
        <Toggle checked={requireAiIndex} onChange={setRequireAiIndex} title="遵守 AI 索引开关" desc="关掉 ai_index 的笔记对它隐形。" />
        <Toggle checked={allowPrivate} onChange={setAllowPrivate} title="允许私密笔记本" desc="默认不给，即使你本人能看。" />
        <label className="grid gap-1.5 rounded-lg border p-3">
          <span className="text-sm font-medium">有效期</span>
          <select className="h-8 rounded-lg border bg-background px-2 text-sm" value={expiresInDays ?? ""} onChange={(e) => setExpiresInDays(e.target.value ? Number(e.target.value) : null)}>
            <option value="">永不过期</option><option value="30">30 天</option><option value="90">90 天</option><option value="365">365 天</option>
          </select>
        </label>
      </div>

      <FormError>{err}</FormError>
      <p className="text-[11px] text-muted-foreground">授权后可以随时在「设置 → 集成」里吊销，吊销即刻生效。</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => void decide("deny")}>拒绝</Button>
        <Button disabled={busy || !workspaceIds.length || (mode === "allowlist" && !notebookIds.length)} onClick={() => void decide("approve")}>
          {busy ? "处理中…" : "同意并继续"}
        </Button>
      </div>
    </div>
  </Shell>;
}

function Toggle({ checked, onChange, title, desc, disabled }: { checked: boolean; onChange: (v: boolean) => void; title: string; desc: string; disabled?: boolean }) {
  return <label className={`flex items-start gap-2.5 rounded-lg border p-3 ${disabled ? "opacity-50" : "cursor-pointer hover:bg-muted/50"}`}>
    <input type="checkbox" className="mt-0.5 size-4 accent-current" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    <span className="min-w-0"><span className="block text-sm font-medium">{title}</span><span className="block text-xs text-muted-foreground">{desc}</span></span>
  </label>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto grid min-h-dvh max-w-2xl place-items-center p-6">
    <div className="w-full rounded-2xl border bg-background p-6 shadow-sm">
      <div className="mb-4 flex items-center gap-2">
        <span className="grid size-9 place-items-center rounded-xl bg-muted"><ShieldCheck className="size-5" /></span>
        <div><p className="text-sm font-medium">授权访问知识库</p><p className="text-xs text-muted-foreground">确认给出去的范围，再点同意。</p></div>
      </div>
      {children}
    </div>
  </div>;
}
