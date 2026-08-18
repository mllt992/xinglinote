import{useEffect,useState}from'react';import type{ReactNode}from'react';import{BookLock,Check,Copy,Eye,KeyRound,Pencil,Plus,RotateCcw,Trash2,Wrench}from'lucide-react';import{api}from'../api';import{Button}from'./ui/button';import{Input}from'./ui/input';import{Badge}from'./ui/badge';import{Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle}from'./ui/dialog';

export type McpToken={id:string;name:string;workspaceId:string;notebookMode:"inherit"|"allowlist";notebookIds:string[];rw:"read"|"write"|"manage";allowDelete:boolean;requireAiIndex:boolean;allowPrivateNotebooks:boolean;feedPublic:boolean;feedWorkspace:boolean;dailyWriteLimitBytes:number|null;expiresAt:string|null;status:string;lastUsedAt:string|null;createdAt:string};
type Issued={name:string;secret:string;config:unknown;stdioConfig:unknown};
type Nb={id:string;title:string};
const RW=[{v:"read",title:"只读",desc:"检索、读取、问答。不能改任何内容。"},{v:"write",title:"读写",desc:"在只读之上，可新建、追加、修改笔记。"},{v:"manage",title:"全部",desc:"在读写之上，可移动、打标签；勾选后还能删到回收站。"}] as const;
const rwLabel=(v:string)=>RW.find(x=>x.v===v)?.title??v;
const box="rounded-xl border bg-background";

function Field({title,hint,children}:{title:string;hint?:string;children:ReactNode}){return <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">{title}</span>{children}{hint&&<span className="text-[11px] text-muted-foreground">{hint}</span>}</label>;}
function Check2({checked,onChange,title,desc,disabled}:{checked:boolean;onChange:(v:boolean)=>void;title:string;desc:string;disabled?:boolean}){
  return <label className={`flex items-start gap-2.5 rounded-lg border p-3 ${disabled?"opacity-50":"cursor-pointer hover:bg-muted/50"}`}><input type="checkbox" className="mt-0.5 size-4 accent-current" checked={checked} disabled={disabled} onChange={e=>onChange(e.target.checked)}/><span className="min-w-0"><span className="block text-sm font-medium">{title}</span><span className="block text-xs text-muted-foreground">{desc}</span></span></label>;
}

type Draft={name:string;workspaceId:string;rw:"read"|"write"|"manage";notebookMode:"inherit"|"allowlist";notebookIds:string[];expiresInDays:number|null;limited:boolean;limitMb:number;allowDelete:boolean;requireAiIndex:boolean;allowPrivateNotebooks:boolean;feedPublic:boolean;feedWorkspace:boolean};
const blank=(workspaceId:string):Draft=>({name:"",workspaceId,rw:"read",notebookMode:"inherit",notebookIds:[],expiresInDays:null,limited:false,limitMb:10,allowDelete:false,requireAiIndex:true,allowPrivateNotebooks:false,feedPublic:false,feedWorkspace:false});
const fromToken=(t:McpToken):Draft=>({name:t.name,workspaceId:t.workspaceId,rw:t.rw,notebookMode:t.notebookMode,notebookIds:t.notebookIds??[],expiresInDays:null,limited:t.dailyWriteLimitBytes!=null,limitMb:Math.max(1,Math.round((t.dailyWriteLimitBytes??10485760)/1048576)),allowDelete:t.allowDelete,requireAiIndex:t.requireAiIndex,allowPrivateNotebooks:t.allowPrivateNotebooks,feedPublic:t.feedPublic,feedWorkspace:t.feedWorkspace});

/** 设置 → MCP 钥匙。一把钥匙绑一个工作区，范围、档位、过期、写入额度都在这里定。 */
export function McpPanel({workspaces,defaultWorkspaceId}:{workspaces:Array<{id:string;name:string}>;defaultWorkspaceId?:string}){
  const[tokens,setTokens]=useState<McpToken[]>([]);const[msg,setMsg]=useState("");const[busy,setBusy]=useState(false);
  const[draft,setDraft]=useState<Draft|null>(null);const[editing,setEditing]=useState<McpToken|null>(null);
  const[notebooks,setNotebooks]=useState<Nb[]>([]);const[issued,setIssued]=useState<Issued|null>(null);
  const load=()=>api<{tokens:McpToken[]}>("/api/v1/mcp/tokens").then(d=>setTokens(d.tokens));
  useEffect(()=>{void load()},[]);
  useEffect(()=>{if(!draft?.workspaceId)return setNotebooks([]);api<{notebooks:Nb[]}>(`/api/v1/workspaces/${draft.workspaceId}/notebooks`).then(d=>setNotebooks(d.notebooks)).catch(()=>setNotebooks([]))},[draft?.workspaceId]);

  const wsName=(id:string)=>workspaces.find(w=>w.id===id)?.name??"已退出的工作区";
  function openCreate(){setEditing(null);setMsg("");setDraft(blank(defaultWorkspaceId??workspaces[0]?.id??""));}
  function openEdit(t:McpToken){setEditing(t);setMsg("");setDraft(fromToken(t));}

  async function submit(){
    if(!draft)return;setBusy(true);setMsg("");
    const shared={name:draft.name.trim(),rw:draft.rw,notebookMode:draft.notebookMode,notebookIds:draft.notebookMode==="allowlist"?draft.notebookIds:[],allowDelete:draft.rw==="manage"&&draft.allowDelete,requireAiIndex:draft.requireAiIndex,allowPrivateNotebooks:draft.allowPrivateNotebooks,feedPublic:draft.feedPublic,feedWorkspace:draft.feedWorkspace,dailyWriteLimitBytes:draft.limited?Math.max(1,draft.limitMb)*1048576:null,expiresInDays:draft.expiresInDays};
    try{
      if(editing){await api(`/api/v1/mcp/tokens/${editing.id}`,{method:"PATCH",body:JSON.stringify(shared)});setMsg("已保存。改设置不会换明文，客户端里的配置继续可用。");}
      else{const d=await api<Issued>("/api/v1/mcp/tokens",{method:"POST",body:JSON.stringify({...shared,workspaceId:draft.workspaceId})});setIssued({...d,name:shared.name});}
      setDraft(null);setEditing(null);await load();
    }catch(e){setMsg((e as Error).message)}finally{setBusy(false)}
  }
  async function rotate(t:McpToken){
    if(!confirm(`轮换《${t.name}》？旧明文立刻失效，所有用它的客户端都要换配置。`))return;
    setMsg("");try{const d=await api<Issued>(`/api/v1/mcp/tokens/${t.id}/rotate`,{method:"POST"});setIssued({...d,name:t.name});await load();}catch(e){setMsg((e as Error).message)}
  }
  async function revoke(t:McpToken){
    if(!confirm(`吊销《${t.name}》？立刻失效且不可恢复，需要的话请新建一把。`))return;
    setMsg("");try{await api(`/api/v1/mcp/tokens/${t.id}`,{method:"DELETE"});await load();}catch(e){setMsg((e as Error).message)}
  }

  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-3"><p className="text-sm text-muted-foreground">一把钥匙只活在一个工作区，权限不会超过你自己在那个区的权限。</p><Button size="sm" onClick={openCreate} disabled={!workspaces.length}><Plus/>新建钥匙</Button></div>
    {msg&&<p className="text-sm text-muted-foreground">{msg}</p>}

    {tokens.length===0?<div className={`${box} py-12 text-center`}><span className="mx-auto grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground"><KeyRound className="size-5"/></span><p className="mt-3 text-sm font-medium">还没有钥匙</p><p className="mt-1 text-xs text-muted-foreground">建一把就能让 Cursor、Claude Desktop 这类客户端读写你的知识库。</p></div>
    :<div className="space-y-2">{tokens.map(t=><div key={t.id} className={`${box} flex flex-wrap items-center gap-3 p-4`}>
      <span className="grid size-10 place-items-center rounded-lg bg-muted"><KeyRound className="size-4"/></span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{t.name}<Badge>{rwLabel(t.rw)}</Badge>{t.allowDelete&&<Badge>可删除</Badge>}{t.allowPrivateNotebooks&&<Badge>含私密本</Badge>}{(t.feedPublic||t.feedWorkspace)&&<Badge>可发动态</Badge>}</p>
        <p className="text-xs text-muted-foreground">{wsName(t.workspaceId)} · {t.notebookMode==="inherit"?"跟随我的权限":`指定 ${t.notebookIds?.length??0} 个笔记本`} · 每日写入{t.dailyWriteLimitBytes==null?"不限":` ${Math.round(t.dailyWriteLimitBytes/1048576)} MB`} · {t.lastUsedAt?`最后使用 ${new Date(t.lastUsedAt).toLocaleString()}`:"从未使用"}{t.expiresAt?` · ${new Date(t.expiresAt).toLocaleDateString()} 过期`:""}</p>
      </div>
      <Button variant="ghost" size="sm" onClick={()=>openEdit(t)}><Pencil/>编辑</Button>
      <Button variant="outline" size="sm" onClick={()=>void rotate(t)}><RotateCcw/>轮换</Button>
      <Button variant="ghost" size="icon" aria-label="吊销" onClick={()=>void revoke(t)}><Trash2/></Button>
    </div>)}</div>}

    <Dialog open={!!draft} onOpenChange={v=>{if(!v){setDraft(null);setEditing(null)}}}><DialogContent className="max-h-[86vh] max-w-2xl overflow-auto">
      <DialogHeader><DialogTitle className="flex items-center gap-2"><KeyRound className="size-5"/>{editing?"编辑钥匙":"新建 MCP 钥匙"}</DialogTitle><DialogDescription>{editing?"改权限即时生效，明文不变；换绑工作区请新建一把。":"明文只在创建后显示一次，关掉就看不到了。"}</DialogDescription></DialogHeader>
      {draft&&<div className="grid gap-4">
        <div className="grid gap-3 md:grid-cols-2">
          <Field title="名称"><Input value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})} placeholder="Cursor 上的助手"/></Field>
          <Field title="工作区" hint={editing?"钥匙绑定的工作区不能改":undefined}><select className="h-9 rounded-lg border bg-background px-3 text-sm disabled:opacity-60" disabled={!!editing} value={draft.workspaceId} onChange={e=>setDraft({...draft,workspaceId:e.target.value,notebookIds:[]})}>{workspaces.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>
        </div>

        <div><p className="mb-1.5 text-xs font-medium text-muted-foreground">权限档位</p><div className="grid gap-2 md:grid-cols-3">{RW.map(o=><button key={o.v} type="button" onClick={()=>setDraft({...draft,rw:o.v,allowDelete:o.v==="manage"&&draft.allowDelete})} className={`rounded-lg border p-3 text-left transition ${draft.rw===o.v?"border-foreground bg-muted":"hover:bg-muted/50"}`}><span className="flex items-center gap-1.5 text-sm font-medium">{draft.rw===o.v&&<Check className="size-3.5"/>}{o.title}</span><span className="mt-1 block text-xs text-muted-foreground">{o.desc}</span></button>)}</div></div>

        <div><p className="mb-1.5 text-xs font-medium text-muted-foreground">笔记本范围</p>
          <div className="grid gap-2 md:grid-cols-2">
            <button type="button" onClick={()=>setDraft({...draft,notebookMode:"inherit"})} className={`rounded-lg border p-3 text-left transition ${draft.notebookMode==="inherit"?"border-foreground bg-muted":"hover:bg-muted/50"}`}><span className="flex items-center gap-1.5 text-sm font-medium">{draft.notebookMode==="inherit"&&<Check className="size-3.5"/>}跟随我的权限</span><span className="mt-1 block text-xs text-muted-foreground">以后新增的笔记本自动包含在内。</span></button>
            <button type="button" onClick={()=>setDraft({...draft,notebookMode:"allowlist"})} className={`rounded-lg border p-3 text-left transition ${draft.notebookMode==="allowlist"?"border-foreground bg-muted":"hover:bg-muted/50"}`}><span className="flex items-center gap-1.5 text-sm font-medium">{draft.notebookMode==="allowlist"&&<Check className="size-3.5"/>}指定笔记本</span><span className="mt-1 block text-xs text-muted-foreground">只给勾选的这几本，新建的本子不会自动进来。</span></button>
          </div>
          {draft.notebookMode==="allowlist"&&<div className="mt-2 max-h-44 overflow-auto rounded-lg border p-1">{notebooks.length===0?<p className="p-3 text-xs text-muted-foreground">这个工作区还没有笔记本。</p>:notebooks.map(n=><label key={n.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-muted"><input type="checkbox" className="size-4 accent-current" checked={draft.notebookIds.includes(n.id)} onChange={e=>setDraft({...draft,notebookIds:e.target.checked?[...draft.notebookIds,n.id]:draft.notebookIds.filter(x=>x!==n.id)})}/><BookLock className="size-3.5 text-muted-foreground"/><span className="truncate">{n.title}</span></label>)}</div>}
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <Field title="有效期"><select className="h-9 rounded-lg border bg-background px-3 text-sm" value={draft.expiresInDays??""} onChange={e=>setDraft({...draft,expiresInDays:e.target.value?Number(e.target.value):null})}><option value="">永不过期</option><option value="30">30 天</option><option value="90">90 天</option><option value="365">365 天</option></select></Field>
          <Field title="每日写入上限" hint={draft.limited?undefined:"默认不限。担心 Agent 跑飞时再设一个。"}>
            <div className="flex items-center gap-2"><select className="h-9 rounded-lg border bg-background px-3 text-sm" value={draft.limited?"limited":"unlimited"} onChange={e=>setDraft({...draft,limited:e.target.value==="limited"})}><option value="unlimited">不限</option><option value="limited">限制为</option></select>{draft.limited&&<><Input type="number" min={1} max={1024} className="w-24" value={draft.limitMb} onChange={e=>setDraft({...draft,limitMb:Number(e.target.value)})}/><span className="text-sm text-muted-foreground">MB / 天</span></>}</div>
          </Field>
        </div>

        <div className="grid gap-2 md:grid-cols-3">
          <Check2 checked={draft.allowDelete} disabled={draft.rw!=="manage"} onChange={v=>setDraft({...draft,allowDelete:v})} title="允许删除" desc={draft.rw==="manage"?"注册 trash_note，删到回收站。":"只有「全部」档位能开。"}/>
          <Check2 checked={draft.requireAiIndex} onChange={v=>setDraft({...draft,requireAiIndex:v})} title="遵守 AI 索引开关" desc="关掉 ai_index 的笔记对这把钥匙隐形。"/>
          <Check2 checked={draft.allowPrivateNotebooks} onChange={v=>setDraft({...draft,allowPrivateNotebooks:v})} title="允许私密笔记本" desc="默认不给，即使你本人能看。"/>
          <Check2 checked={draft.feedWorkspace} onChange={v=>setDraft({...draft,feedWorkspace:v})} title="可发工作区动态" desc="开了才注册 post_to_feed 工具。"/>
          <Check2 checked={draft.feedPublic} onChange={v=>setDraft({...draft,feedPublic:v})} title="可发广场动态" desc="发到全实例可见的广场，谨慎打开。"/>
        </div>

        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={()=>{setDraft(null);setEditing(null)}}>取消</Button><Button disabled={busy||!draft.name.trim()||!draft.workspaceId||(draft.notebookMode==="allowlist"&&!draft.notebookIds.length)} onClick={submit}>{busy?"提交中…":editing?"保存":"创建并显示明文"}</Button></div>
      </div>}
    </DialogContent></Dialog>

    <SecretDialog issued={issued} onClose={()=>setIssued(null)}/>
  </div>;
}

function CopyBlock({title,hint,value}:{title:string;hint:string;value:string}){
  const[done,setDone]=useState(false);
  return <div className={box}><div className="flex items-center gap-2 border-b px-3 py-2"><p className="flex-1 text-xs font-medium">{title}</p><Button variant="ghost" size="sm" onClick={()=>{void navigator.clipboard.writeText(value);setDone(true);setTimeout(()=>setDone(false),1500)}}>{done?<Check/>:<Copy/>}{done?"已复制":"复制"}</Button></div><pre className="max-h-40 overflow-auto p-3 text-[11px] leading-5">{value}</pre><p className="border-t px-3 py-2 text-[11px] text-muted-foreground">{hint}</p></div>;
}

function SecretDialog({issued,onClose}:{issued:Issued|null;onClose:()=>void}){
  const[shown,setShown]=useState(false);
  useEffect(()=>{setShown(false)},[issued?.secret]);
  return <Dialog open={!!issued} onOpenChange={v=>{if(!v)onClose()}}><DialogContent className="max-h-[86vh] max-w-2xl overflow-auto">
    <DialogHeader><DialogTitle className="flex items-center gap-2"><Wrench className="size-5"/>{issued?.name} 的明文</DialogTitle><DialogDescription>只显示这一次。关掉之后只能轮换，拿不回来。</DialogDescription></DialogHeader>
    {issued&&<div className="grid gap-3">
      <div className="flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3"><code className="min-w-0 flex-1 break-all font-mono text-xs">{shown?issued.secret:`${issued.secret.slice(0,12)}${"•".repeat(24)}`}</code><Button variant="ghost" size="icon" aria-label="显示明文" onClick={()=>setShown(v=>!v)}><Eye/></Button><Button variant="outline" size="sm" onClick={()=>void navigator.clipboard.writeText(issued.secret)}><Copy/>复制</Button></div>
      <CopyBlock title="Cursor / 支持 HTTP 的客户端" hint="粘进客户端的 mcp.json。" value={JSON.stringify(issued.config,null,2)}/>
      <CopyBlock title="Claude Desktop（stdio 桥接）" hint="只支持 stdio 的客户端用这份，需要本机有 npx。" value={JSON.stringify(issued.stdioConfig,null,2)}/>
      <div className="flex justify-end"><Button onClick={onClose}><Check/>我已保存</Button></div>
    </div>}
  </DialogContent></Dialog>;
}
