import{useEffect,useMemo,useState}from'react';import{Check,Copy,Link2,Lock,Share2,Trash2}from'lucide-react';import{api}from'../api';import{Button}from'./ui/button';import{Input}from'./ui/input';import{Badge}from'./ui/badge';import{Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle}from'./ui/dialog';import{useConfirm}from'./ui/confirm';import{FormError}from'./ui/form-error';

export type ShareDto={id:string;token:string;targetType:string;targetId:string;headingAnchor:string|null;hasPassword:boolean;expiresAt:string|null;allowRobots:boolean;commentsEnabled:boolean;correctionsEnabled:boolean;showBacklinks:boolean;status:string;createdAt:string};
export type ShareTarget={kind:"note"|"folder"|"attachment"|"notebook";id:string;title:string;bodyMd?:string};
const typeLabel:Record<string,string>={note:"整篇",heading:"某一节",folder:"目录",attachment:"附件",notebook:"整本"};
/** 和后端 headingSlug 同一套规则，锚点两边要能对上。 */
const slug=(t:string)=>t.trim().toLowerCase().replace(/\s+/g,"-").replace(/[^\p{L}\p{N}_-]/gu,"");

function ShareRow({s,url,copied,onCopy,onRevoke}:{s:ShareDto;url:string;copied?:boolean;onCopy?:()=>void;onRevoke?:()=>void}){
  const expired=!!s.expiresAt&&new Date(s.expiresAt).getTime()<Date.now();
  return <div className="flex items-center gap-3 rounded-xl border border-border p-3">
    <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${onCopy?"bg-primary text-primary-foreground":"bg-muted text-muted-foreground"}`}>{s.hasPassword?<Lock className="size-4"/>:<Link2 className="size-4"/>}</span>
    <div className="min-w-0 flex-1"><p className={`truncate font-mono text-xs ${onCopy?"":"text-muted-foreground line-through"}`}>{url}</p>
      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground"><Badge>{typeLabel[s.targetType]??s.targetType}</Badge>
        {s.status==="revoked"?"已撤销":expired?"已过期":s.expiresAt?`到期 ${new Date(s.expiresAt).toLocaleDateString()}`:"永不过期"}
        {s.hasPassword?" · 有密码":" · 无密码"}{s.correctionsEnabled?" · 可纠错":""}</p></div>
    {onCopy&&<Button variant="ghost" size="icon" aria-label="复制链接" onClick={onCopy}>{copied?<Check/>:<Copy/>}</Button>}
    {onRevoke&&<Button variant="ghost" size="icon" aria-label="撤销链接" className="text-destructive" onClick={onRevoke}><Trash2/></Button>}
  </div>;
}

/** 一个目标可以有多条互不影响的链接：密码、有效期、评论纠错开关都各自独立。 */
export function ShareDialog({target,open,onOpenChange}:{target:ShareTarget|null;open:boolean;onOpenChange:(v:boolean)=>void}){
  const[shares,setShares]=useState<ShareDto[]>([]);const[password,setPassword]=useState("");const[days,setDays]=useState("never");const[busy,setBusy]=useState(false);const[copied,setCopied]=useState("");const[err,setErr]=useState("");
  const askConfirm=useConfirm();
  const[anchor,setAnchor]=useState("");const[opts,setOpts]=useState({commentsEnabled:true,correctionsEnabled:false,showBacklinks:false,allowRobots:false});
  const headings=useMemo(()=>target?.kind==="note"&&target.bodyMd?target.bodyMd.split("\n").filter(l=>/^#{1,6}\s/.test(l)).map(l=>({anchor:slug(l.replace(/^#+\s*/,"")),text:l.replace(/^#+\s*/,"").trim()})).filter(h=>h.anchor):[],[target?.bodyMd,target?.kind]);
  const listPath=target?.kind==="note"?`/api/v1/notes/${target.id}/shares`:target?.kind==="notebook"?`/api/v1/notebooks/${target.id}/shares`:null;
  const createPath=target?target.kind==="note"?`/api/v1/notes/${target.id}/shares`:target.kind==="notebook"?`/api/v1/notebooks/${target.id}/shares`:target.kind==="folder"?`/api/v1/folders/${target.id}/shares`:`/api/v1/attachments/${target.id}/shares`:null;
  const load=()=>listPath&&api<{shares:ShareDto[]}>(listPath).then(d=>setShares(d.shares)).catch(()=>setShares([]));
  useEffect(()=>{if(open){setErr("");setAnchor("");void load()}},[open,target?.id]);
  const url=(s:ShareDto)=>`${location.origin}/p/${s.token}`;
  const[showDead,setShowDead]=useState(false);
  // 撤销和过期的链接留着可查，但别和还能用的混在一起。
  const isLive=(s:ShareDto)=>s.status==="active"&&(!s.expiresAt||new Date(s.expiresAt).getTime()>Date.now());
  const live=shares.filter(isLive);const dead=shares.filter(s=>!isLive(s));
  async function revoke(s:ShareDto){
    if(!await askConfirm({title:`撤销《${target?.title}》的这条链接？`,description:"撤销后这条链接立刻失效且不可恢复，已经拿到链接的人也打不开了。需要的话可以再生成一条新的。",confirmText:"撤销链接",destructive:true}))return;
    await api(`/api/v1/shares/${s.id}`,{method:"DELETE"});void load();
  }
  async function copy(s:ShareDto){await navigator.clipboard.writeText(url(s));setCopied(s.id);setTimeout(()=>setCopied(""),1200);}

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-xl">
    <DialogHeader><DialogTitle className="flex items-center gap-2"><Share2 className="size-5"/>分享《{target?.title}》</DialogTitle>
      <DialogDescription>{target?.kind==="notebook"?"整本链接是实时投影，之后在这个本里新建的笔记也会出现。和发布文档站不同：这里不看是否已发布，本里所有未删除的笔记都会进去。":target?.kind==="folder"?"目录链接是实时子树，之后在这个目录下新建的笔记也会出现在链接里。":target?.kind==="attachment"?"附件只能经这条链接下载，不暴露物理路径。":"每条链接相互独立，可以设置密码、有效期或单独撤销。"}</DialogDescription>
      <p className="text-xs text-muted-foreground">这条链接<b className="font-medium">只读</b>，访客能看能评论，但不能编辑。想让人跟你一起写，用顶栏的「协作」。</p></DialogHeader>
    <div className="rounded-xl border border-border bg-muted/30 p-4">
      {target?.kind==="note"&&headings.length>0&&<select className="mb-3 h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none" value={anchor} onChange={e=>setAnchor(e.target.value)}><option value="">分享整篇</option>{headings.map(h=><option key={h.anchor} value={h.anchor}>只分享这一节：{h.text}</option>)}</select>}
      <div className="grid gap-3 sm:grid-cols-[1fr_150px_auto]">
        <Input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="访问密码（可选）" autoComplete="new-password"/>
        <select className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none" value={days} onChange={e=>setDays(e.target.value)}><option value="never">永不过期</option><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option></select>
        <Button disabled={busy} onClick={async()=>{if(!createPath)return;setBusy(true);setErr("");try{const s=await api<ShareDto>(createPath,{method:"POST",body:JSON.stringify({password:password||undefined,expiresInDays:days==="never"?null:Number(days),...(anchor?{headingAnchor:anchor}:{}),...opts})});setShares(v=>[s,...v]);setPassword("");await copy(s);}catch(e){setErr((e as Error).message)}finally{setBusy(false)}}}>{busy?"生成中…":"生成并复制"}</Button>
      </div>
      {target?.kind!=="attachment"&&<div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        {([["commentsEnabled","允许评论"],["correctionsEnabled","允许纠错建议"],["showBacklinks","显示反向链接"],["allowRobots","允许搜索引擎收录"]] as const).map(([k,label])=>
          <label key={k} className="flex cursor-pointer items-center gap-1.5"><input type="checkbox" className="size-3.5 accent-current" checked={opts[k]} onChange={e=>setOpts({...opts,[k]:e.target.checked})}/>{label}</label>)}
      </div>}
      <FormError className="mt-2">{err}</FormError>
    </div>
    {target?.kind==="note"||target?.kind==="notebook"?<div className="max-h-80 space-y-2 overflow-auto">
      {shares.length===0&&<div className="py-10 text-center text-sm text-muted-foreground">还没有分享链接。</div>}
      {live.length>0&&<p className="px-1 text-[11px] font-semibold uppercase tracking-[.12em] text-muted-foreground">生效中 {live.length}</p>}
      {live.map(s=><ShareRow key={s.id} s={s} url={url(s)} copied={copied===s.id} onCopy={()=>void copy(s)} onRevoke={()=>void revoke(s)} />)}
      {dead.length>0&&<>
        <button className="mt-2 w-full rounded-lg px-1 py-1.5 text-left text-[11px] font-semibold uppercase tracking-[.12em] text-muted-foreground hover:bg-muted" onClick={()=>setShowDead(v=>!v)}>
          {showDead?"▾":"▸"} 已失效 {dead.length}
        </button>
        {showDead&&dead.map(s=><ShareRow key={s.id} s={s} url={url(s)} />)}
      </>}
    </div>
    :<p className="text-xs text-muted-foreground">生成的链接已复制到剪贴板。这个目标的全部链接可以在「备份与审计 → 分享」里管理。</p>}
  </DialogContent></Dialog>;
}
