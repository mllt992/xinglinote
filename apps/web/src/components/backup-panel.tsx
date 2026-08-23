import { useEffect, useState, type ReactNode } from "react";
import { Archive, CloudDownload, CloudUpload, FileCheck2, FileClock, Pencil, Play, Plug, Plus, RotateCcw, Search, Trash2 } from "lucide-react";
import { api } from "../api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { useConfirm } from "./ui/confirm";
import { useToast } from "./ui/toast";
import { FormError } from "./ui/form-error";

const box = "rounded-xl border bg-background";

function Field({ title, children }: { title: string; children: ReactNode }) {
  return <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">{title}</span>{children}</label>;
}

function Hollow({ icon, text }: { icon: ReactNode; text: string }) {
  return <div className="py-12 text-center">
    <span className="mx-auto grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">{icon}</span>
    <p className="mt-3 text-xs text-muted-foreground">{text}</p>
  </div>;
}

const mb = (n: number | null) => n == null ? "—" : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

type Target = {
  id: string; name: string; type: string; endpoint: string; prefix: string; schedule: string;
  retainDaily: number; retainWeekly: number; enabled: boolean;
  encryptionFingerprint: string | null; lastRunAt: string | null;
  lastRestoreTestAt: string | null; lastRestoreTestStatus: string | null;
};
type RemoteObject = {
  remote_path: string; bytes: number | null; updated_at: string | null; checksum_sha256: string | null;
  format: string | null; version: number | null; encrypted: boolean | null; locally_recorded: boolean;
};
type RestoreRun = {
  id: string; targetId: string; status: string; mode: string; drill: boolean; error: string | null;
  stats: Record<string, number>; warnings: string[]; createdAt: string; finishedAt: string | null;
};
type RestorePlan = {
  restore_plan_id: string;
  backup: { format: string; version: number; exported_at: string; checksum_sha256: string; checksum_verified: boolean; encrypted: boolean };
  counts: Record<string, number>; conflicts: string[]; warnings: string[]; compatible: boolean; expires_at: string; confirmation_text: string;
};
type Run = {
  id: string; targetId: string; status: string; bytes: number | null; checksumSha256: string | null;
  remotePath: string | null; error: string | null; manifest: Record<string, number | boolean | string> | null;
  startedAt: string | null; finishedAt: string | null; createdAt: string;
};

const emptyForm = {
  name: "", type: "webdav", endpoint: "", prefix: "knowledge", schedule: "manual",
  retainDaily: 7, retainWeekly: 4, passphrase: "", username: "", password: "",
  accessKey: "", secretKey: "", bucket: "", region: "",
};

const runLabel: Record<string, string> = { pending: "排队中", running: "备份中", success: "成功", failed: "失败" };

type Props = { workspaceId?: string };

/** 备份目标与运行历史。测试与运行都是后台任务，所以有在跑的记录时自动轮询。 */
export function BackupPanel({ workspaceId }: Props) {
  const toast = useToast();
  const askConfirm = useConfirm();
  const instance = !workspaceId;
  const base = instance ? "/api/v1/admin/backups" : `/api/v1/workspaces/${workspaceId}/backups`;
  const [targets, setTargets] = useState<Target[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [restoreRuns, setRestoreRuns] = useState<RestoreRun[]>([]);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState(emptyForm);
  const [objectTarget, setObjectTarget] = useState<Target | null>(null);
  const [objects, setObjects] = useState<RemoteObject[]>([]);
  const [selectedObject, setSelectedObject] = useState<RemoteObject | null>(null);
  const [restoreMode, setRestoreMode] = useState(instance ? "replace_instance_metadata" : "new_workspace");
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [allowMissing, setAllowMissing] = useState(false);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [confirmName, setConfirmName] = useState("");

  const load = () => api<{ targets: Target[]; runs: Run[]; restoreRuns: RestoreRun[] }>(base).then(d => {
    setTargets(d.targets);
    setRuns(d.runs);
    setRestoreRuns(d.restoreRuns);
  });
  useEffect(() => { void load(); }, [base]);
  useEffect(() => {
    if (!runs.some(r => r.status === "pending" || r.status === "running")) return;
    const t = window.setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [runs, base]);

  function resetForm() {
    setF(emptyForm);
    setEditing(null);
    setOpen(false);
    setErr("");
  }

  function startEdit(t: Target) {
    setEditing(t.id);
    setOpen(true);
    setErr("");
    setF({
      ...emptyForm,
      name: t.name,
      type: t.type,
      endpoint: t.endpoint,
      prefix: t.prefix,
      schedule: t.schedule,
      retainDaily: t.retainDaily,
      retainWeekly: t.retainWeekly,
    });
  }

  async function act(path: string, okText: string) {
    try {
      await api(path, { method: "POST" });
      toast.success(okText);
      setTimeout(() => void load(), 1200);
    } catch (e) {
      toast.error("操作失败", (e as Error).message);
    }
  }

  async function save() {
    setBusy(true);
    setErr("");
    try {
      const credentials = f.type === "webdav"
        ? { username: f.username, password: f.password }
        : { accessKey: f.accessKey, secretKey: f.secretKey, bucket: f.bucket, region: f.region };
      const body: Record<string, unknown> = {
        name: f.name,
        type: f.type,
        endpoint: f.endpoint,
        prefix: f.prefix,
        schedule: f.schedule,
        retainDaily: f.retainDaily,
        retainWeekly: f.retainWeekly,
        ...(f.passphrase ? { passphrase: f.passphrase } : {}),
      };
      if (editing) {
        if (f.username || f.password || f.accessKey || f.secretKey || f.bucket) body.credentials = credentials;
        await api(`/api/v1/backup-targets/${editing}`, { method: "PATCH", body: JSON.stringify(body) });
        toast.success("备份目标已更新");
      } else {
        const d = await api<{ encryptionFingerprint: string | null }>(`${base}/targets`, {
          method: "POST",
          body: JSON.stringify({ ...body, credentials }),
        });
        toast.success("备份目标已创建", d.encryptionFingerprint
          ? `加密指纹 ${d.encryptionFingerprint.slice(0, 16)}…，恢复时需要同一口令。`
          : "未设口令，备份包不加密。");
      }
      resetForm();
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(t: Target) {
    if (!await askConfirm({
      title: `删除备份目标「${t.name}」？`,
      description: "只删这里的配置和运行记录，远端已经传上去的包不会动。",
      confirmText: "删除目标",
      destructive: true,
    })) return;
    try {
      await api(`/api/v1/backup-targets/${t.id}`, { method: "DELETE" });
      toast.success("已删除备份目标");
      if (editing === t.id) resetForm();
      await load();
    } catch (e) {
      toast.error("删除失败", (e as Error).message);
    }
  }

  async function showObjects(target: Target) {
    setBusy(true);
    setPlan(null);
    setSelectedObject(null);
    setObjectTarget(target);
    try {
      const data = await api<{ objects: RemoteObject[] }>(`/api/v1/backup-targets/${target.id}/objects`);
      setObjects(data.objects);
    } catch (e) {
      toast.error("读取远端备份失败", (e as Error).message);
      setObjects([]);
    } finally { setBusy(false); }
  }

  async function inspectObject() {
    if (!objectTarget || !selectedObject) return;
    setBusy(true);
    setErr("");
    setPlan(null);
    try {
      const data = await api<RestorePlan>(`/api/v1/backup-targets/${objectTarget.id}/objects/inspect`, {
        method: "POST",
        body: JSON.stringify({ remote_path: selectedObject.remote_path, passphrase: restorePassphrase || undefined, mode: restoreMode, allow_missing_attachments: allowMissing }),
      });
      setPlan(data);
      setConfirmName("");
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function executeRestore(drill: boolean) {
    if (!plan) return;
    if (!await askConfirm({
      title: drill ? "执行隔离恢复演练？" : "执行恢复？",
      description: drill ? "系统会在事务中完整恢复并验证，然后销毁临时数据。" : "高风险模式会先创建恢复前检查点；执行期间请勿关闭页面。",
      confirmText: drill ? "开始演练" : "开始恢复",
      destructive: !drill,
    })) return;
    setBusy(true);
    setErr("");
    try {
      const result = await api<{ workspace_id: string | null; warnings: string[] }>(`/api/v1/backup-restore-plans/${plan.restore_plan_id}/${drill ? "drill" : "execute"}`, {
        method: "POST",
        body: JSON.stringify({ passphrase: restorePassphrase || undefined, confirm_name: confirmName }),
      });
      toast.success(drill ? "恢复演练通过" : "恢复完成", result.workspace_id ? `工作区 ${result.workspace_id}` : result.warnings.join("；"));
      setPlan(null);
      await load();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  const hint = instance
    ? "把用户、注册策略、广场和全局配置打包加密后上传到你自己的 WebDAV 或 S3。选每天/每周后由 worker 自动跑，不必一直开着这个页面。"
    : "备份包在服务端加密后再上传。频率选每天或每周，worker 会按上次成功时间自动再跑；凭据与口令不会回传前端。";

  return <div className="space-y-5">
    <div className="flex items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">{hint}</p>
      <Button size="sm" onClick={() => { resetForm(); setOpen(true); }}><Plus />新增目标</Button>
    </div>
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-muted-foreground">
      内置实例快照只恢复用户与全局元数据，不等于 PostgreSQL + kbdata 的完整整机灾备。整机故障请按运维文档同时恢复数据库和数据卷。
    </div>

    {open && <div className={`${box} space-y-4 p-5`}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field title="名称"><Input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder={instance ? "实例逃生舱" : "家里的 NAS"} /></Field>
        <Field title="类型">
          <select className="h-9 rounded-lg border bg-background px-3 text-sm" value={f.type} disabled={!!editing} onChange={e => setF({ ...f, type: e.target.value })}>
            <option value="webdav">WebDAV</option>
            <option value="s3">S3 兼容</option>
          </select>
        </Field>
        <Field title="地址">
          <Input value={f.endpoint} onChange={e => setF({ ...f, endpoint: e.target.value })}
            placeholder={f.type === "webdav" ? "https://nas.example.com/dav" : "https://s3.example.com"} />
        </Field>
        <Field title="路径前缀"><Input value={f.prefix} onChange={e => setF({ ...f, prefix: e.target.value })} /></Field>
        {f.type === "webdav"
          ? <>
            <Field title={editing ? "用户名（留空则不改）" : "用户名"}><Input value={f.username} onChange={e => setF({ ...f, username: e.target.value })} autoComplete="off" /></Field>
            <Field title={editing ? "密码（留空则不改）" : "密码"}><Input type="password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
          </>
          : <>
            <Field title={editing ? "Access Key（留空则不改）" : "Access Key"}><Input value={f.accessKey} onChange={e => setF({ ...f, accessKey: e.target.value })} autoComplete="off" /></Field>
            <Field title={editing ? "Secret Key（留空则不改）" : "Secret Key"}><Input type="password" value={f.secretKey} onChange={e => setF({ ...f, secretKey: e.target.value })} autoComplete="new-password" /></Field>
            <Field title="Bucket"><Input value={f.bucket} onChange={e => setF({ ...f, bucket: e.target.value })} /></Field>
            <Field title="Region"><Input value={f.region} onChange={e => setF({ ...f, region: e.target.value })} placeholder="auto" /></Field>
          </>}
        <Field title="自动备份">
          <select className="h-9 rounded-lg border bg-background px-3 text-sm" value={f.schedule} onChange={e => setF({ ...f, schedule: e.target.value })}>
            <option value="manual">仅手动</option>
            <option value="daily">每天自动</option>
            <option value="weekly">每周自动</option>
          </select>
        </Field>
        <Field title={editing ? "加密口令（留空则不改）" : "加密口令（留空则不加密）"}>
          <Input type="password" value={f.passphrase} onChange={e => setF({ ...f, passphrase: e.target.value })} placeholder="至少 8 位，丢了就恢复不了" autoComplete="new-password" />
        </Field>
        <Field title="保留最近几天"><Input type="number" min={1} max={365} value={f.retainDaily} onChange={e => setF({ ...f, retainDaily: Number(e.target.value) })} /></Field>
        <Field title="保留最近几周"><Input type="number" min={1} max={52} value={f.retainWeekly} onChange={e => setF({ ...f, retainWeekly: Number(e.target.value) })} /></Field>
      </div>
      <FormError>{err}</FormError>
      <div className="flex gap-2">
        <Button disabled={busy || !f.name.trim() || !f.endpoint.trim()} onClick={() => void save()}>
          <CloudUpload />{busy ? "保存中…" : editing ? "保存修改" : "创建目标"}
        </Button>
        <Button variant="ghost" onClick={resetForm}>取消</Button>
      </div>
    </div>}

    {targets.length === 0
      ? <div className={box}><Hollow icon={<CloudUpload />} text={instance
        ? "还没有实例备份目标。加一个 WebDAV 或 S3，灾难时才有一份能拿回来的用户和配置。"
        : "还没有备份目标。加一个 WebDAV 或 S3，就能手动或定时把这个工作区打包上传。"} /></div>
      : <div className="space-y-2">{targets.map(t => <div key={t.id} className={`${box} flex flex-wrap items-center gap-3 p-4`}>
        <span className="grid size-10 place-items-center rounded-lg bg-muted"><Archive className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">{t.name}<Badge>{t.type === "s3" ? "S3" : "WebDAV"}</Badge>{t.encryptionFingerprint && <Badge>已加密</Badge>}{!t.enabled && <Badge>已停用</Badge>}</p>
          <p className="truncate text-xs text-muted-foreground">{t.endpoint}/{t.prefix} · {t.schedule === "manual" ? "仅手动" : t.schedule === "daily" ? "每天自动" : "每周自动"} · 保留 {t.retainDaily} 天 / {t.retainWeekly} 周{t.lastRunAt ? ` · 上次成功 ${new Date(t.lastRunAt).toLocaleString()}` : " · 还没自动跑过"}{t.lastRestoreTestAt ? ` · 上次演练 ${t.lastRestoreTestStatus === "success" ? "通过" : "失败"} ${new Date(t.lastRestoreTestAt).toLocaleDateString()}` : " · 尚未演练"}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void act(`/api/v1/backup-targets/${t.id}/test`, "已提交连接测试，稍后看运行记录")}><Plug />测试连接</Button>
        <Button variant="outline" size="sm" onClick={() => void showObjects(t)}><CloudDownload />远端备份</Button>
        <Button size="sm" onClick={() => void act(`/api/v1/backup-targets/${t.id}/run`, "已开始备份")}><Play />立即备份</Button>
        <Button variant="ghost" size="icon" aria-label="编辑" onClick={() => startEdit(t)}><Pencil /></Button>
        <Button variant="ghost" size="icon" aria-label="删除" className="text-destructive" onClick={() => void remove(t)}><Trash2 /></Button>
      </div>)}</div>}

    {objectTarget && <section className={`${box} space-y-4 p-4`}>
      <div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">远端备份 · {objectTarget.name}</h3><p className="text-xs text-muted-foreground">即使本地运行记录已删除，这里仍直接从 WebDAV / S3 发现对象。</p></div><Button variant="ghost" size="sm" onClick={() => setObjectTarget(null)}>关闭</Button></div>
      {objects.length === 0 ? <p className="py-5 text-center text-xs text-muted-foreground">{busy ? "正在读取…" : "没有发现 .kbbackup 文件"}</p> : <div className="divide-y rounded-lg border">{objects.map(object => <div key={object.remote_path} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
        <FileCheck2 className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1"><p className="truncate text-sm">{object.remote_path}</p><p className="text-xs text-muted-foreground">{mb(object.bytes)}{object.updated_at ? ` · ${new Date(object.updated_at).toLocaleString()}` : ""}{object.format ? ` · ${object.format} v${object.version}` : " · 待检查格式"}{object.encrypted === true ? " · 已加密" : object.encrypted === false ? " · 未加密" : ""}{!object.locally_recorded ? " · 仅远端" : ""}</p></div>
        <a className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-xs hover:bg-muted" href={`/api/v1/backup-targets/${objectTarget.id}/objects/${encodeURIComponent(object.remote_path)}/download`}><CloudDownload className="size-3.5" />下载</a>
        <Button size="sm" variant={selectedObject?.remote_path === object.remote_path ? "default" : "outline"} onClick={() => { setSelectedObject(object); setPlan(null); setErr(""); }}><Search />检查</Button>
      </div>)}</div>}

      {selectedObject && <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <Field title="恢复模式"><select className="h-9 rounded-lg border bg-background px-3 text-sm" value={restoreMode} onChange={e => { setRestoreMode(e.target.value); setPlan(null); }}>
            {instance ? <><option value="replace_instance_metadata">替换实例元数据</option><option value="bootstrap_empty_instance">引导空实例</option></> : <><option value="new_workspace">恢复为新工作区（推荐）</option><option value="replace_workspace">替换当前工作区</option></>}
          </select></Field>
          <Field title="解密口令（未加密包留空）"><Input type="password" value={restorePassphrase} onChange={e => { setRestorePassphrase(e.target.value); setPlan(null); }} autoComplete="new-password" /></Field>
        </div>
        {!instance && <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={allowMissing} onChange={e => setAllowMissing(e.target.checked)} />允许恢复旧 v3 包并明确跳过缺少文件的附件元数据</label>}
        <Button disabled={busy} onClick={() => void inspectObject()}><Search />{busy ? "检查中…" : "只读预检"}</Button>
        {plan && <div className="space-y-3 rounded-lg border bg-background p-4 text-xs">
          <p className="font-medium">{plan.backup.format} v{plan.backup.version} · {plan.backup.encrypted ? "已加密" : "未加密"} · checksum {plan.backup.checksum_sha256.slice(0, 16)}…</p>
          <p className="text-muted-foreground">资源：{Object.entries(plan.counts).filter(([, count]) => count > 0).map(([key, count]) => `${key} ${count}`).join(" · ") || "空包"}</p>
          {plan.warnings.map(warning => <p key={warning} className="text-amber-700 dark:text-amber-300">⚠ {warning}</p>)}
          <p className={plan.compatible ? "text-emerald-600" : "text-destructive"}>{plan.compatible ? "预检通过，15 分钟内可执行" : "预检未通过，不能恢复"}</p>
          {plan.compatible && <><Field title={`输入「${plan.confirmation_text}」确认`}><Input value={confirmName} onChange={e => setConfirmName(e.target.value)} /></Field><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || confirmName !== plan.confirmation_text} onClick={() => void executeRestore(true)}><RotateCcw />恢复演练</Button><Button disabled={busy || confirmName !== plan.confirmation_text} onClick={() => void executeRestore(false)}><Play />执行恢复</Button></div></>}
        </div>}
        <FormError>{err}</FormError>
      </div>}
    </section>}

    <section className={box}>
      <h3 className="border-b px-4 py-3 text-sm font-semibold">运行记录</h3>
      {runs.length === 0
        ? <Hollow icon={<FileClock />} text="还没有备份记录。" />
        : <div className="divide-y">{runs.map(r => <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
          <Badge>{runLabel[r.status] ?? r.status}</Badge>
          <div className="min-w-0 flex-1">
            <p className="text-sm">{targets.find(t => t.id === r.targetId)?.name ?? "已删除的目标"} · {mb(r.bytes)}{r.manifest
              ? <span className="text-muted-foreground"> · {typeof r.manifest.notes === "number" ? `${r.manifest.notes} 篇笔记` : typeof r.manifest.users === "number" ? `${r.manifest.users} 个用户` : ""}</span>
              : null}</p>
            <p className="truncate text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}{r.finishedAt ? ` → ${new Date(r.finishedAt).toLocaleTimeString()}` : ""}{r.checksumSha256 ? ` · sha256 ${r.checksumSha256.slice(0, 12)}…` : ""}{r.remotePath ? ` · ${r.remotePath}` : ""}</p>
            {r.error && <p className="mt-1 text-xs text-destructive">{r.error}</p>}
          </div>
        </div>)}</div>}
    </section>
    <section className={box}>
      <h3 className="border-b px-4 py-3 text-sm font-semibold">恢复与演练记录</h3>
      {restoreRuns.length === 0 ? <Hollow icon={<RotateCcw />} text="还没有恢复或演练记录。" /> : <div className="divide-y">{restoreRuns.map(r => <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3"><Badge>{r.drill ? "演练" : "恢复"} · {r.status}</Badge><div className="min-w-0 flex-1"><p className="text-sm">{r.mode} · {Object.entries(r.stats ?? {}).map(([key, count]) => `${key} ${count}`).join(" · ")}</p><p className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}{r.finishedAt ? ` → ${new Date(r.finishedAt).toLocaleTimeString()}` : ""}</p>{r.error && <p className="text-xs text-destructive">{r.error}</p>}</div></div>)}</div>}
    </section>
  </div>;
}
