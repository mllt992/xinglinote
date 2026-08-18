import{useEffect,useState}from'react';import type{ReactNode}from'react';import{Archive,CloudUpload,Download,FileClock,Link2 as Link2Icon,Lock,Play,Plug,Plus,ShieldAlert,Snowflake,Trash2 as Trash2Icon,Upload}from'lucide-react';import{api}from'../api';import{Button}from'./ui/button';import{Input}from'./ui/input';import{Badge}from'./ui/badge';
const box="rounded-xl border bg-background";
function Field({title,children}:{title:string;children:ReactNode}){return <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">{title}</span>{children}</label>;}
function Hollow({icon,text}:{icon:ReactNode;text:string}){return <div className="py-12 text-center"><span className="mx-auto grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">{icon}</span><p className="mt-3 text-xs text-muted-foreground">{text}</p></div>;}
const mb=(n:number|null)=>n==null?"—":n<1048576?`${(n/1024).toFixed(0)} KB`:`${(n/1048576).toFixed(1)} MB`;

type Target={id:string;name:string;type:string;endpoint:string;prefix:string;schedule:string;retainDaily:number;retainWeekly:number;enabled:boolean;encryptionFingerprint:string|null;lastRunAt:string|null};
type Run={id:string;targetId:string;status:string;bytes:number|null;checksumSha256:string|null;remotePath:string|null;error:string|null;manifest:Record<string,number>|null;startedAt:string|null;finishedAt:string|null;createdAt:string};
const runLabel:Record<string,string>={pending:"排队中",running:"备份中",success:"成功",failed:"失败"};

/** 备份目标与运行历史。测试与运行都是后台任务，所以有在跑的记录时自动轮询。 */
export function BackupPanel({workspaceId}:{workspaceId:string}){
  const[targets,setTargets]=useState<Target[]>([]);const[runs,setRuns]=useState<Run[]>([]);const[msg,setMsg]=useState("");const[open,setOpen]=useState(false);const[busy,setBusy]=useState(false);
  const[f,setF]=useState({name:"",type:"webdav",endpoint:"",prefix:"knowledge",schedule:"manual",retainDaily:7,retainWeekly:4,passphrase:"",username:"",password:"",accessKey:"",secretKey:"",bucket:"",region:""});
  const load=()=>api<{targets:Target[];runs:Run[]}>(`/api/v1/workspaces/${workspaceId}/backups`).then(d=>{setTargets(d.targets);setRuns(d.runs)});
  useEffect(()=>{void load()},[workspaceId]);
  useEffect(()=>{if(!runs.some(r=>r.status==="pending"||r.status==="running"))return;const t=window.setInterval(()=>void load(),3000);return()=>clearInterval(t)},[runs]);
  async function act(path:string,okText:string){setMsg("");try{await api(path,{method:"POST"});setMsg(okText);setTimeout(()=>void load(),1200);}catch(e){setMsg((e as Error).message)}}
  async function create(){setBusy(true);setMsg("");try{
    const credentials=f.type==="webdav"?{username:f.username,password:f.password}:{accessKey:f.accessKey,secretKey:f.secretKey,bucket:f.bucket,region:f.region};
    const d=await api<{encryptionFingerprint:string|null}>(`/api/v1/workspaces/${workspaceId}/backups/targets`,{method:"POST",body:JSON.stringify({name:f.name,type:f.type,endpoint:f.endpoint,prefix:f.prefix,schedule:f.schedule,retainDaily:f.retainDaily,retainWeekly:f.retainWeekly,credentials,...(f.passphrase?{passphrase:f.passphrase}:{})})});
    setMsg(d.encryptionFingerprint?`已创建，加密指纹 ${d.encryptionFingerprint.slice(0,16)}…（恢复时需要同一口令）`:"已创建（未设口令，备份包不加密）");
    setOpen(false);setF({...f,name:"",endpoint:"",passphrase:"",username:"",password:"",accessKey:"",secretKey:"",bucket:"",region:""});await load();
  }catch(e){setMsg((e as Error).message)}finally{setBusy(false)}}

  return <div className="space-y-5">
    <div className="flex items-center justify-between gap-3"><p className="text-sm text-muted-foreground">备份包在服务端加密后再上传，凭据与口令不会回传前端。</p><Button size="sm" onClick={()=>setOpen(v=>!v)}><Plus/>新增目标</Button></div>
    {open&&<div className={`${box} space-y-4 p-5`}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field title="名称"><Input value={f.name} onChange={e=>setF({...f,name:e.target.value})} placeholder="家里的 NAS"/></Field>
        <Field title="类型"><select className="h-9 rounded-lg border bg-background px-3 text-sm" value={f.type} onChange={e=>setF({...f,type:e.target.value})}><option value="webdav">WebDAV</option><option value="s3">S3 兼容</option></select></Field>
        <Field title="地址"><Input value={f.endpoint} onChange={e=>setF({...f,endpoint:e.target.value})} placeholder={f.type==="webdav"?"https://nas.example.com/dav":"https://s3.example.com"}/></Field>
        <Field title="路径前缀"><Input value={f.prefix} onChange={e=>setF({...f,prefix:e.target.value})}/></Field>
        {f.type==="webdav"?<><Field title="用户名"><Input value={f.username} onChange={e=>setF({...f,username:e.target.value})} autoComplete="off"/></Field><Field title="密码"><Input type="password" value={f.password} onChange={e=>setF({...f,password:e.target.value})} autoComplete="new-password"/></Field></>
        :<><Field title="Access Key"><Input value={f.accessKey} onChange={e=>setF({...f,accessKey:e.target.value})} autoComplete="off"/></Field><Field title="Secret Key"><Input type="password" value={f.secretKey} onChange={e=>setF({...f,secretKey:e.target.value})} autoComplete="new-password"/></Field><Field title="Bucket"><Input value={f.bucket} onChange={e=>setF({...f,bucket:e.target.value})}/></Field><Field title="Region"><Input value={f.region} onChange={e=>setF({...f,region:e.target.value})} placeholder="auto"/></Field></>}
        <Field title="频率"><select className="h-9 rounded-lg border bg-background px-3 text-sm" value={f.schedule} onChange={e=>setF({...f,schedule:e.target.value})}><option value="manual">手动</option><option value="daily">每天</option><option value="weekly">每周</option></select></Field>
        <Field title="加密口令（留空则不加密）"><Input type="password" value={f.passphrase} onChange={e=>setF({...f,passphrase:e.target.value})} placeholder="至少 8 位，丢了就恢复不了" autoComplete="new-password"/></Field>
        <Field title="保留最近几天"><Input type="number" min={1} max={365} value={f.retainDaily} onChange={e=>setF({...f,retainDaily:Number(e.target.value)})}/></Field>
        <Field title="保留最近几周"><Input type="number" min={1} max={52} value={f.retainWeekly} onChange={e=>setF({...f,retainWeekly:Number(e.target.value)})}/></Field>
      </div>
      <div className="flex gap-2"><Button disabled={busy||!f.name.trim()||!f.endpoint.trim()} onClick={create}><CloudUpload/>{busy?"创建中…":"创建目标"}</Button><Button variant="ghost" onClick={()=>setOpen(false)}>取消</Button></div>
    </div>}
    {msg&&<p className="text-sm text-muted-foreground">{msg}</p>}

    {targets.length===0?<div className={box}><Hollow icon={<CloudUpload/>} text="还没有备份目标。加一个 WebDAV 或 S3，就能手动或定时把这个工作区打包上传。"/></div>
    :<div className="space-y-2">{targets.map(t=><div key={t.id} className={`${box} flex flex-wrap items-center gap-3 p-4`}>
      <span className="grid size-10 place-items-center rounded-lg bg-muted"><Archive className="size-4"/></span>
      <div className="min-w-0 flex-1"><p className="flex items-center gap-2 text-sm font-medium">{t.name}<Badge>{t.type}</Badge>{t.encryptionFingerprint&&<Badge>已加密</Badge>}</p><p className="truncate text-xs text-muted-foreground">{t.endpoint}/{t.prefix} · {t.schedule==="manual"?"手动":t.schedule==="daily"?"每天":"每周"} · 保留 {t.retainDaily} 天 / {t.retainWeekly} 周{t.lastRunAt?` · 上次 ${new Date(t.lastRunAt).toLocaleString()}`:""}</p></div>
      <Button variant="outline" size="sm" onClick={()=>void act(`/api/v1/backup-targets/${t.id}/test`,"已提交连接测试，稍后看运行记录")}><Plug/>测试连接</Button>
      <Button size="sm" onClick={()=>void act(`/api/v1/backup-targets/${t.id}/run`,"已开始备份")}><Play/>立即备份</Button>
    </div>)}</div>}

    <section className={box}><h3 className="border-b px-4 py-3 text-sm font-semibold">运行记录</h3>
      {runs.length===0?<Hollow icon={<FileClock/>} text="还没有备份记录。"/>:<div className="divide-y">{runs.map(r=><div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
        <Badge>{runLabel[r.status]??r.status}</Badge>
        <div className="min-w-0 flex-1"><p className="text-sm">{targets.find(t=>t.id===r.targetId)?.name??"已删除的目标"} · {mb(r.bytes)}{r.manifest?<span className="text-muted-foreground"> · {r.manifest.notes??0} 篇笔记</span>:null}</p>
          <p className="truncate text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}{r.finishedAt?` → ${new Date(r.finishedAt).toLocaleTimeString()}`:""}{r.checksumSha256?` · sha256 ${r.checksumSha256.slice(0,12)}…`:""}</p>
          {r.error&&<p className="mt-1 text-xs text-destructive">{r.error}</p>}</div>
      </div>)}</div>}
    </section>
  </div>;
}

/** 工作区审计流水：成员变更、备份、MCP 写入都落在这里。 */
export function AuditPanel({workspaceId}:{workspaceId:string}){
  type Log={id:string;actorType:string;action:string;result:string;targetType:string|null;details:unknown;createdAt:string};
  const[logs,setLogs]=useState<Log[]>([]);useEffect(()=>{api<{logs:Log[]}>(`/api/v1/workspaces/${workspaceId}/audit`).then(d=>setLogs(d.logs))},[workspaceId]);
  if(!logs.length)return <div className={box}><Hollow icon={<FileClock/>} text="还没有审计记录。成员变更、备份、MCP 写入都会记在这里。"/></div>;
  return <div className={box}><div className="divide-y">{logs.map(l=><div key={l.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
    <Badge>{l.actorType==="mcp"?"MCP":l.actorType==="system"?"系统":"用户"}</Badge>
    <div className="min-w-0 flex-1"><p className="font-mono text-sm">{l.action}</p><p className="truncate text-xs text-muted-foreground">{new Date(l.createdAt).toLocaleString()}{l.targetType?` · ${l.targetType}`:""}{l.details?` · ${JSON.stringify(l.details)}`:""}</p></div>
    {l.result!=="ok"&&<Badge>{l.result}</Badge>}
  </div>)}</div><p className="border-t px-4 py-2.5 text-xs text-muted-foreground">只显示最近 200 条。</p></div>;
}

/** 明文导出 / 导入：给「我想自己拿走数据」用；加密备份走上面的备份目标。 */
export function TransferPanel({workspaceId,workspaceName}:{workspaceId:string;workspaceName:string}){
  const[msg,setMsg]=useState("");const[busy,setBusy]=useState(false);
  async function exportJson(){setBusy(true);setMsg("");try{
    const res=await fetch(`/api/v1/workspaces/${workspaceId}/export`,{credentials:"include",headers:{"X-Requested-With":"fetch"}});
    if(!res.ok){const j=await res.json().catch(()=>null);throw new Error(j?.error?.message??"导出失败");}
    const url=URL.createObjectURL(await res.blob());const a=document.createElement("a");a.href=url;a.download=`${workspaceName}-导出.json`;a.click();URL.revokeObjectURL(url);setMsg("已下载。文件是明文，请自己保管好。");
  }catch(e){setMsg((e as Error).message)}finally{setBusy(false)}}
  async function importJson(file:File){setBusy(true);setMsg("");try{
    const d=await api<{restoredNotes:number}>(`/api/v1/workspaces/${workspaceId}/restore`,{method:"POST",body:await file.text()});
    setMsg(`已恢复 ${d.restoredNotes} 篇笔记。同 ID 的笔记会跳过，不会覆盖。`);
  }catch(e){setMsg((e as Error).message)}finally{setBusy(false)}}
  return <div className="space-y-3">
    <div className={`${box} flex items-center gap-4 p-5`}><span className="grid size-10 place-items-center rounded-lg bg-muted"><Download className="size-4"/></span><div className="min-w-0 flex-1"><p className="text-sm font-medium">导出工作区</p><p className="text-xs text-muted-foreground">笔记本、目录、笔记正文导出成一个 JSON，不含附件与成员。</p></div><Button variant="outline" disabled={busy} onClick={exportJson}><Download/>导出</Button></div>
    <div className={`${box} flex items-center gap-4 p-5`}><span className="grid size-10 place-items-center rounded-lg bg-muted"><Upload className="size-4"/></span><div className="min-w-0 flex-1"><p className="text-sm font-medium">从导出文件恢复</p><p className="text-xs text-muted-foreground">按笔记 ID 去重；同 ID 的笔记会跳过而不是覆盖。</p></div>
      <Button variant="outline" disabled={busy} onClick={()=>document.getElementById("restore-input")?.click()}><Upload/>选择 JSON</Button>
      <input id="restore-input" type="file" accept="application/json,.json" className="hidden" onChange={e=>{const file=e.target.files?.[0];e.target.value="";if(file)void importJson(file)}}/></div>
    {msg&&<p className="text-sm text-muted-foreground">{msg}</p>}
  </div>;
}

/** 冻结：整个工作区转只读，用来暂停协作，不删数据。 */
export function DangerPanel({workspaceId,frozen,onChanged}:{workspaceId:string;frozen:boolean;onChanged:()=>void}){
  const[busy,setBusy]=useState(false);const[msg,setMsg]=useState("");
  return <div className={`${box} border-destructive/30 p-5`}>
    <div className="flex items-center gap-4"><span className="grid size-10 place-items-center rounded-lg bg-destructive/10 text-destructive">{frozen?<Snowflake className="size-4"/>:<ShieldAlert className="size-4"/>}</span>
      <div className="min-w-0 flex-1"><p className="text-sm font-medium">{frozen?"工作区已冻结":"冻结工作区"}</p><p className="text-xs text-muted-foreground">冻结后所有人只能读，写入、AI 写作与 MCP 写档都会被拒绝；随时可以解冻。</p></div>
      <Button variant={frozen?"outline":"destructive"} disabled={busy} onClick={async()=>{if(!frozen&&!confirm("冻结后这个工作区的所有人都只能读，确定吗？"))return;setBusy(true);setMsg("");try{await api(`/api/v1/workspaces/${workspaceId}/freeze`,{method:"PATCH",body:JSON.stringify({frozen:!frozen})});onChanged()}catch(e){setMsg((e as Error).message)}finally{setBusy(false)}}}>{frozen?"解冻":"冻结"}</Button></div>
    {msg&&<p className="mt-3 text-sm text-destructive">{msg}</p>}
  </div>;
}

type WsShare={id:string;token:string;targetType:string;targetTitle:string;hasPassword:boolean;expiresAt:string|null;commentsEnabled:boolean;correctionsEnabled:boolean;status:string;createdAt:string;mine:boolean};
const shareType:Record<string,string>={note:"整篇",heading:"某一节",folder:"目录",attachment:"附件"};

/** 本区分享总览：Admin/Owner 能收掉别人建的链接。 */
export function SharesPanel({workspaceId}:{workspaceId:string}){
  const[data,setData]=useState<{canManageAll:boolean;shares:WsShare[]}>({canManageAll:false,shares:[]});const[msg,setMsg]=useState("");const[copied,setCopied]=useState("");
  const load=()=>api<typeof data>(`/api/v1/workspaces/${workspaceId}/shares`).then(setData);
  useEffect(()=>{void load()},[workspaceId]);
  const live=data.shares.filter(s=>s.status==="active");
  async function patch(s:WsShare,body:Record<string,unknown>,okText:string){setMsg("");try{await api(`/api/v1/shares/${s.id}`,{method:"PATCH",body:JSON.stringify(body)});setMsg(okText);await load()}catch(e){setMsg((e as Error).message)}}
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">{data.canManageAll?"你是管理员，这里是本工作区的全部分享链接。":"这里是你自己创建的分享链接。"}</p>
    {msg&&<p className="text-sm text-muted-foreground">{msg}</p>}
    {live.length===0?<div className={box}><Hollow icon={<Link2Icon/>} text="本工作区还没有生效中的分享链接。"/></div>
    :<div className="space-y-2">{live.map(s=><div key={s.id} className={`${box} flex flex-wrap items-center gap-3 p-4`}>
      <span className="grid size-10 place-items-center rounded-lg bg-muted">{s.hasPassword?<Lock className="size-4"/>:<Link2Icon className="size-4"/>}</span>
      <div className="min-w-0 flex-1"><p className="flex flex-wrap items-center gap-2 text-sm font-medium">{s.targetTitle}<Badge>{shareType[s.targetType]??s.targetType}</Badge>{!s.mine&&<Badge>他人创建</Badge>}</p>
        <p className="truncate text-xs text-muted-foreground">{s.hasPassword?"有密码":"无密码"} · {s.expiresAt?`到期 ${new Date(s.expiresAt).toLocaleDateString()}`:"永不过期"}{s.correctionsEnabled?" · 可纠错":""} · 建于 {new Date(s.createdAt).toLocaleDateString()}</p></div>
      <Button variant="ghost" size="sm" onClick={()=>{void navigator.clipboard.writeText(`${location.origin}/p/${s.token}`);setCopied(s.id);setTimeout(()=>setCopied(""),1200)}}>{copied===s.id?"已复制":"复制链接"}</Button>
      <select className="h-8 rounded-lg border bg-background px-2 text-xs" value="" onChange={e=>{const v=e.target.value;e.target.value="";if(v==="pw"){const p=prompt("设置新密码（留空表示取消密码）");if(p===null)return;void patch(s,{password:p||null},p?"已改密码":"已取消密码");}else if(v)void patch(s,{expiresInDays:v==="never"?null:Number(v)},"已更新有效期");}}>
        <option value="">改设置…</option><option value="pw">改 / 取消密码</option><option value="7">续期 7 天</option><option value="30">续期 30 天</option><option value="never">改为永不过期</option></select>
      <Button variant="ghost" size="icon" aria-label="撤销" className="text-destructive" onClick={async()=>{if(!confirm(`撤销《${s.targetTitle}》的这条链接？立刻失效且不可恢复。`))return;setMsg("");try{await api(`/api/v1/shares/${s.id}`,{method:"DELETE"});await load()}catch(e){setMsg((e as Error).message)}}}><Trash2Icon/></Button>
    </div>)}</div>}
  </div>;
}
