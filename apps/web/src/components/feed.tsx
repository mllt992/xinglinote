import{useEffect,useRef,useState}from'react';import{Globe2,Heart,MoreHorizontal,NotebookPen,Pencil,Send,Trash2}from'lucide-react';import{api}from'../api';import{Button}from'./ui/button';import{Textarea}from'./ui/textarea';import{Input}from'./ui/input';import{Badge}from'./ui/badge';import{Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle}from'./ui/dialog';import{DropdownMenu,DropdownMenuContent,DropdownMenuItem,DropdownMenuTrigger}from'./ui/dropdown-menu';import{useConfirm}from'./ui/confirm';import{useToast}from'./ui/toast';import{FormError}from'./ui/form-error';

export type FeedPost={id:string;body:string;visibility:string;workspaceId:string|null;createdAt:string;editedAt:string|null;mine:boolean;author:{handle:string;displayName:string}|null;note:{id:string;title:string}|null;likes:number;liked:boolean;status?:string;moderationReason?:string|null};
type Held={held:boolean;message:string|null};
/** 待审 / 被驳回的帖子只有作者自己看得到，标一下省得他以为发失败了。 */
function HeldNote({post}:{post:FeedPost}){
  if(!post.status||post.status==="visible")return null;
  const pending=post.status==="pending_review";
  return <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
    <Badge className={pending?"border-transparent bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)]":"border-transparent bg-destructive/10 text-destructive"}>{pending?"待人工审核":"已驳回"}</Badge>
    <span>{post.moderationReason??(pending?"AI 审核没通过，管理员看过之后才会公开。":"管理员驳回了这条内容，可以改完再发。")}</span>
    <span className="text-muted-foreground/70">只有你自己看得到这条</span>
  </div>;
}
type Nb={id:string;title:string};

/** 广场与圈子共用一套时间线。scope=workspace 时发的是圈子动态。 */
export function FeedView({scope,workspaceId,workspaces,canPost,onOpenNote,onLoaded}:{scope:"public"|"workspace";workspaceId?:string;workspaces:Array<{id:string;name:string}>;canPost:boolean;onOpenNote?:(workspaceId:string,noteId:string)=>void;onLoaded?:(posts:FeedPost[])=>void}){
  const askConfirm=useConfirm();const toast=useToast();
  const[posts,setPosts]=useState<FeedPost[]>([]);const[body,setBody]=useState("");const[err,setErr]=useState("");const[dlgErr,setDlgErr]=useState("");const[busy,setBusy]=useState(false);
  const[editing,setEditing]=useState<FeedPost|null>(null);const[draft,setDraft]=useState("");
  const[promote,setPromote]=useState<FeedPost|null>(null);const[target,setTarget]=useState({workspaceId:"",notebookId:"",title:""});const[books,setBooks]=useState<Nb[]>([]);
  const path=scope==="public"?"/api/v1/feed/public":`/api/v1/feed/workspaces/${workspaceId}`;
  /** 单条动态的点赞、编辑、删除就地改这一条：整条时间线重拉会闪一下、丢滚动位置，点个赞不该付这个代价。
      listRef 只经 apply 写入，所以连点两下也不会拿到上一次渲染的旧列表。 */
  const listRef=useRef<FeedPost[]>([]);
  const apply=(next:FeedPost[])=>{listRef.current=next;setPosts(next);onLoaded?.(next)};
  const patchOne=(id:string,fn:(p:FeedPost)=>FeedPost)=>apply(listRef.current.map(p=>p.id===id?fn(p):p));
  const dropOne=(id:string)=>apply(listRef.current.filter(p=>p.id!==id));
  const load=()=>api<{posts:FeedPost[]}>(path).then(d=>apply(d.posts)).catch(e=>toast.error("加载动态失败",(e as Error).message));
  useEffect(()=>{void load()},[path]);
  useEffect(()=>{if(!target.workspaceId)return setBooks([]);api<{notebooks:Nb[]}>(`/api/v1/workspaces/${target.workspaceId}/notebooks`).then(d=>{setBooks(d.notebooks);setTarget(t=>({...t,notebookId:d.notebooks[0]?.id??""}))}).catch(()=>setBooks([]))},[target.workspaceId]);

  async function submit(){
    if(!body.trim())return;setBusy(true);setErr("");
    try{
      if(scope==="public"){
        const scan=await api<{links:Array<{title:string;publiclyVisible:boolean}>}>("/api/v1/posts/leak-check",{method:"POST",body:JSON.stringify({body})});
        const leaked=scan.links.filter(l=>!l.publiclyVisible).map(l=>l.title);
        if(leaked.length&&!await askConfirm({title:"这条动态里有对外看不到的链接",description:<>发到广场后，下面这些链接会退化成纯文本，读者点不开：<span className="mt-2 block font-medium text-foreground">{leaked.join("、")}</span></>,confirmText:"仍然发布"})){setBusy(false);return;}
      }
      const created=await api<{moderation?:Held}>("/api/v1/posts",{method:"POST",body:JSON.stringify({body,visibility:scope,...(scope==="workspace"?{workspaceId}:{})})});
      if(created.moderation?.held)toast.success("已提交，等待人工审核",created.moderation.message??undefined);
      setBody("");await load();
    }catch(e){setErr((e as Error).message)}finally{setBusy(false)}
  }
  async function like(p:FeedPost){try{const d=await api<{liked:boolean}>(`/api/v1/posts/${p.id}/like`,{method:"POST"});patchOne(p.id,x=>({...x,liked:d.liked,likes:Math.max(0,x.likes+(d.liked?1:-1))}))}catch(e){toast.error("操作失败",(e as Error).message)}}
  async function remove(p:FeedPost){if(!await askConfirm({title:"删除这条动态？",description:"动态和它收到的点赞会一起删除，不可恢复。已经转正成笔记的内容不受影响。",confirmText:"删除",destructive:true}))return;try{await api(`/api/v1/posts/${p.id}`,{method:"DELETE"});toast.success("已删除这条动态");dropOne(p.id)}catch(e){toast.error("删除失败",(e as Error).message)}}
  async function toSquare(p:FeedPost){
    try{const d=await api<{strippedLinks:string[];moderation?:Held}>(`/api/v1/posts/${p.id}/publish-to-square`,{method:"POST",body:JSON.stringify({})});
      if(d.moderation?.held)toast.success("已提交到广场，等待人工审核",d.moderation.message??undefined);
      else toast.success("已复制到广场",d.strippedLinks.length?`${d.strippedLinks.length} 个不公开的链接写成了纯文本。`:"圈子里这条不动。");}
    catch(e){const message=(e as Error).message;
      if(message.includes("确认后会写成纯文本")&&await askConfirm({title:"复制到广场？",description:message,confirmText:"继续复制"})){try{await api(`/api/v1/posts/${p.id}/publish-to-square`,{method:"POST",body:JSON.stringify({confirmStripLinks:true})});toast.success("已复制到广场");}catch(x){toast.error("复制失败",(x as Error).message)}}
      else toast.error("复制失败",message);}
  }
  async function doPromote(){
    if(!promote||!target.notebookId)return;setBusy(true);setDlgErr("");
    try{const d=await api<{noteId:string;workspaceId:string;title:string}>(`/api/v1/posts/${promote.id}/promote`,{method:"POST",body:JSON.stringify({notebookId:target.notebookId,title:target.title.trim()||undefined})});
      setPromote(null);toast.success(`已转正为笔记《${d.title}》`);onOpenNote?.(d.workspaceId,d.noteId);
    }catch(e){setDlgErr((e as Error).message)}finally{setBusy(false)}
  }

  return <div className="space-y-4">
    {canPost&&<div className="rounded-2xl border bg-background p-4">
      <Textarea value={body} onChange={e=>setBody(e.target.value)} maxLength={5000} placeholder={scope==="public"?"发到广场，实例里所有人可见。可以用 [[双链]] 引用已公开的笔记。":"发到本工作区的圈子，只有成员看得到。"} className="min-h-24"/>
      <FormError className="mt-3">{err}</FormError>
      <div className="mt-3 flex items-center gap-3"><Button disabled={busy||!body.trim()} onClick={submit}><Send/>{busy?"发布中…":"发布"}</Button><span className="text-xs text-muted-foreground">{body.length}/5000</span></div>
    </div>}
    {posts.length===0?<div className="rounded-2xl border border-dashed py-14 text-center"><span className="mx-auto grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground"><Globe2 className="size-5"/></span><p className="mt-3 text-sm font-medium">还没有动态</p><p className="mt-1 text-xs text-muted-foreground">{scope==="public"?"第一条公开动态还没出现。":"圈子里的碎片想法可以先发这里，之后再转正为笔记。"}</p></div>
    :posts.map(p=><article key={p.id} className="rounded-2xl border bg-background p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <b className="text-sm text-foreground">{p.author?.displayName??"已注销用户"}</b>
        {p.author&&<a className="hover:underline" href={`/u/${p.author.handle}`}>@{p.author.handle}</a>}
        <span>{new Date(p.createdAt).toLocaleString()}</span>{p.editedAt&&<Badge>已编辑</Badge>}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={()=>void like(p)}><Heart className={p.liked?"fill-current":""}/>{p.likes||""}</Button>
          {(p.mine||scope==="workspace")&&<DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="更多操作"><MoreHorizontal/></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
            {p.mine&&<DropdownMenuItem onSelect={()=>{setDlgErr("");setEditing(p);setDraft(p.body)}}><Pencil/>编辑</DropdownMenuItem>}
            <DropdownMenuItem onSelect={()=>{setDlgErr("");setPromote(p);setTarget({workspaceId:workspaceId??workspaces[0]?.id??"",notebookId:"",title:""})}}><NotebookPen/>转正为笔记</DropdownMenuItem>
            {p.mine&&p.visibility==="workspace"&&<DropdownMenuItem onSelect={()=>void toSquare(p)}><Globe2/>公开到广场</DropdownMenuItem>}
            {p.mine&&<DropdownMenuItem className="text-destructive" onSelect={()=>void remove(p)}><Trash2/>删除</DropdownMenuItem>}
          </DropdownMenuContent></DropdownMenu>}
        </div>
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-7">{p.body}</p>
      <HeldNote post={p}/>
      {p.note&&<button className="mt-3 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs hover:bg-muted" onClick={()=>p.workspaceId&&onOpenNote?.(p.workspaceId,p.note!.id)}><NotebookPen className="size-3.5"/>{p.note.title}</button>}
    </article>)}

    <Dialog open={!!editing} onOpenChange={v=>{if(!v)setEditing(null);setDlgErr("")}}><DialogContent>
      <DialogHeader><DialogTitle>编辑动态</DialogTitle><DialogDescription>改完会标上「已编辑」。</DialogDescription></DialogHeader>
      <Textarea value={draft} onChange={e=>setDraft(e.target.value)} className="min-h-32" maxLength={5000}/>
      <FormError>{dlgErr}</FormError>
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={()=>setEditing(null)}>取消</Button><Button disabled={busy||!draft.trim()} onClick={async()=>{if(!editing)return;setBusy(true);try{const d=await api<{editedAt?:string;status?:string;moderation?:Held}>(`/api/v1/posts/${editing.id}`,{method:"PATCH",body:JSON.stringify({body:draft})});if(d.moderation?.held)toast.success("改动已提交，等待人工审核",d.moderation.message??undefined);patchOne(editing.id,x=>({...x,body:draft,editedAt:d.editedAt??new Date().toISOString(),status:d.status??x.status,moderationReason:d.moderation?.message??null}));setEditing(null)}catch(e){setDlgErr((e as Error).message)}finally{setBusy(false)}}}>保存</Button></div>
    </DialogContent></Dialog>

    <Dialog open={!!promote} onOpenChange={v=>{if(!v)setPromote(null);setDlgErr("")}}><DialogContent>
      <DialogHeader><DialogTitle className="flex items-center gap-2"><NotebookPen className="size-5"/>转正为笔记</DialogTitle><DialogDescription>动态原文会存成一篇新笔记，文首自动带上出处。</DialogDescription></DialogHeader>
      <div className="grid gap-3">
        <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">工作区</span><select className="h-9 rounded-lg border bg-background px-3 text-sm" value={target.workspaceId} onChange={e=>setTarget({...target,workspaceId:e.target.value,notebookId:""})}>{workspaces.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
        <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">笔记本</span><select className="h-9 rounded-lg border bg-background px-3 text-sm" value={target.notebookId} onChange={e=>setTarget({...target,notebookId:e.target.value})}>{books.map(b=><option key={b.id} value={b.id}>{b.title}</option>)}</select></label>
        <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">标题（留空取正文第一行）</span><Input value={target.title} onChange={e=>setTarget({...target,title:e.target.value})}/></label>
      </div>
      <FormError>{dlgErr}</FormError>
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={()=>setPromote(null)}>取消</Button><Button disabled={busy||!target.notebookId} onClick={doPromote}>{busy?"创建中…":"创建笔记"}</Button></div>
    </DialogContent></Dialog>
  </div>;
}
