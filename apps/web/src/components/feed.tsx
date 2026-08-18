import{useEffect,useState}from'react';import{Globe2,Heart,MoreHorizontal,NotebookPen,Pencil,Send,Trash2}from'lucide-react';import{api}from'../api';import{Button}from'./ui/button';import{Textarea}from'./ui/textarea';import{Input}from'./ui/input';import{Badge}from'./ui/badge';import{Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle}from'./ui/dialog';import{DropdownMenu,DropdownMenuContent,DropdownMenuItem,DropdownMenuTrigger}from'./ui/dropdown-menu';import{useConfirm}from'./ui/confirm';

export type FeedPost={id:string;body:string;visibility:string;workspaceId:string|null;createdAt:string;editedAt:string|null;mine:boolean;author:{handle:string;displayName:string}|null;note:{id:string;title:string}|null;likes:number;liked:boolean};
type Nb={id:string;title:string};

/** 广场与圈子共用一套时间线。scope=workspace 时发的是圈子动态。 */
export function FeedView({scope,workspaceId,workspaces,canPost,onOpenNote}:{scope:"public"|"workspace";workspaceId?:string;workspaces:Array<{id:string;name:string}>;canPost:boolean;onOpenNote?:(workspaceId:string,noteId:string)=>void}){
  const askConfirm=useConfirm();
  const[posts,setPosts]=useState<FeedPost[]>([]);const[body,setBody]=useState("");const[msg,setMsg]=useState("");const[busy,setBusy]=useState(false);
  const[editing,setEditing]=useState<FeedPost|null>(null);const[draft,setDraft]=useState("");
  const[promote,setPromote]=useState<FeedPost|null>(null);const[target,setTarget]=useState({workspaceId:"",notebookId:"",title:""});const[books,setBooks]=useState<Nb[]>([]);
  const path=scope==="public"?"/api/v1/feed/public":`/api/v1/feed/workspaces/${workspaceId}`;
  const load=()=>api<{posts:FeedPost[]}>(path).then(d=>setPosts(d.posts)).catch(e=>setMsg((e as Error).message));
  useEffect(()=>{void load()},[path]);
  useEffect(()=>{if(!target.workspaceId)return setBooks([]);api<{notebooks:Nb[]}>(`/api/v1/workspaces/${target.workspaceId}/notebooks`).then(d=>{setBooks(d.notebooks);setTarget(t=>({...t,notebookId:d.notebooks[0]?.id??""}))}).catch(()=>setBooks([]))},[target.workspaceId]);

  async function submit(){
    if(!body.trim())return;setBusy(true);setMsg("");
    try{
      if(scope==="public"){
        const scan=await api<{links:Array<{title:string;publiclyVisible:boolean}>}>("/api/v1/posts/leak-check",{method:"POST",body:JSON.stringify({body})});
        const leaked=scan.links.filter(l=>!l.publiclyVisible).map(l=>l.title);
        if(leaked.length&&!await askConfirm({title:"这条动态里有对外看不到的链接",description:<>发到广场后，下面这些链接会退化成纯文本，读者点不开：<span className="mt-2 block font-medium text-foreground">{leaked.join("、")}</span></>,confirmText:"仍然发布"})){setBusy(false);return;}
      }
      await api("/api/v1/posts",{method:"POST",body:JSON.stringify({body,visibility:scope,...(scope==="workspace"?{workspaceId}:{})})});
      setBody("");await load();
    }catch(e){setMsg((e as Error).message)}finally{setBusy(false)}
  }
  async function like(p:FeedPost){try{await api(`/api/v1/posts/${p.id}/like`,{method:"POST"});await load()}catch(e){setMsg((e as Error).message)}}
  async function remove(p:FeedPost){if(!await askConfirm({title:"删除这条动态？",description:"动态和它收到的点赞会一起删除，不可恢复。已经转正成笔记的内容不受影响。",confirmText:"删除",destructive:true}))return;try{await api(`/api/v1/posts/${p.id}`,{method:"DELETE"});await load()}catch(e){setMsg((e as Error).message)}}
  async function toSquare(p:FeedPost){
    setMsg("");
    try{const d=await api<{strippedLinks:string[]}>(`/api/v1/posts/${p.id}/publish-to-square`,{method:"POST",body:JSON.stringify({})});setMsg(d.strippedLinks.length?`已复制到广场，${d.strippedLinks.length} 个不公开的链接写成了纯文本`:"已复制到广场，圈子里这条不动");}
    catch(e){const message=(e as Error).message;
      if(message.includes("确认后会写成纯文本")&&await askConfirm({title:"复制到广场？",description:message,confirmText:"继续复制"})){try{await api(`/api/v1/posts/${p.id}/publish-to-square`,{method:"POST",body:JSON.stringify({confirmStripLinks:true})});setMsg("已复制到广场");}catch(x){setMsg((x as Error).message)}}
      else setMsg(message);}
  }
  async function doPromote(){
    if(!promote||!target.notebookId)return;setBusy(true);setMsg("");
    try{const d=await api<{noteId:string;workspaceId:string;title:string}>(`/api/v1/posts/${promote.id}/promote`,{method:"POST",body:JSON.stringify({notebookId:target.notebookId,title:target.title.trim()||undefined})});
      setPromote(null);setMsg(`已转正为笔记《${d.title}》`);onOpenNote?.(d.workspaceId,d.noteId);
    }catch(e){setMsg((e as Error).message)}finally{setBusy(false)}
  }

  return <div className="space-y-4">
    {canPost&&<div className="rounded-2xl border bg-background p-4">
      <Textarea value={body} onChange={e=>setBody(e.target.value)} maxLength={5000} placeholder={scope==="public"?"发到广场，实例里所有人可见。可以用 [[双链]] 引用已公开的笔记。":"发到本工作区的圈子，只有成员看得到。"} className="min-h-24"/>
      <div className="mt-3 flex items-center gap-3"><Button disabled={busy||!body.trim()} onClick={submit}><Send/>{busy?"发布中…":"发布"}</Button><span className="text-xs text-muted-foreground">{body.length}/5000</span></div>
    </div>}
    {msg&&<p className="text-sm text-muted-foreground">{msg}</p>}
    {posts.length===0?<div className="rounded-2xl border py-16 text-center"><span className="mx-auto grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground"><Globe2 className="size-5"/></span><p className="mt-3 text-sm font-medium">还没有动态</p><p className="mt-1 text-xs text-muted-foreground">{scope==="public"?"这里是整个实例的公开时间线。":"圈子里的碎片想法可以先发这里，之后再转正为笔记。"}</p></div>
    :posts.map(p=><article key={p.id} className="rounded-2xl border bg-background p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <b className="text-sm text-foreground">{p.author?.displayName??"已注销用户"}</b>
        {p.author&&<a className="hover:underline" href={`/u/${p.author.handle}`}>@{p.author.handle}</a>}
        <span>{new Date(p.createdAt).toLocaleString()}</span>{p.editedAt&&<Badge>已编辑</Badge>}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={()=>void like(p)}><Heart className={p.liked?"fill-current":""}/>{p.likes||""}</Button>
          {(p.mine||scope==="workspace")&&<DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="更多操作"><MoreHorizontal/></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
            {p.mine&&<DropdownMenuItem onSelect={()=>{setEditing(p);setDraft(p.body)}}><Pencil/>编辑</DropdownMenuItem>}
            <DropdownMenuItem onSelect={()=>{setPromote(p);setTarget({workspaceId:workspaceId??workspaces[0]?.id??"",notebookId:"",title:""})}}><NotebookPen/>转正为笔记</DropdownMenuItem>
            {p.mine&&p.visibility==="workspace"&&<DropdownMenuItem onSelect={()=>void toSquare(p)}><Globe2/>公开到广场</DropdownMenuItem>}
            {p.mine&&<DropdownMenuItem className="text-destructive" onSelect={()=>void remove(p)}><Trash2/>删除</DropdownMenuItem>}
          </DropdownMenuContent></DropdownMenu>}
        </div>
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-7">{p.body}</p>
      {p.note&&<button className="mt-3 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs hover:bg-muted" onClick={()=>p.workspaceId&&onOpenNote?.(p.workspaceId,p.note!.id)}><NotebookPen className="size-3.5"/>{p.note.title}</button>}
    </article>)}

    <Dialog open={!!editing} onOpenChange={v=>{if(!v)setEditing(null)}}><DialogContent>
      <DialogHeader><DialogTitle>编辑动态</DialogTitle><DialogDescription>改完会标上「已编辑」。</DialogDescription></DialogHeader>
      <Textarea value={draft} onChange={e=>setDraft(e.target.value)} className="min-h-32" maxLength={5000}/>
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={()=>setEditing(null)}>取消</Button><Button disabled={busy||!draft.trim()} onClick={async()=>{if(!editing)return;setBusy(true);try{await api(`/api/v1/posts/${editing.id}`,{method:"PATCH",body:JSON.stringify({body:draft})});setEditing(null);await load()}catch(e){setMsg((e as Error).message)}finally{setBusy(false)}}}>保存</Button></div>
    </DialogContent></Dialog>

    <Dialog open={!!promote} onOpenChange={v=>{if(!v)setPromote(null)}}><DialogContent>
      <DialogHeader><DialogTitle className="flex items-center gap-2"><NotebookPen className="size-5"/>转正为笔记</DialogTitle><DialogDescription>动态原文会存成一篇新笔记，文首自动带上出处。</DialogDescription></DialogHeader>
      <div className="grid gap-3">
        <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">工作区</span><select className="h-9 rounded-lg border bg-background px-3 text-sm" value={target.workspaceId} onChange={e=>setTarget({...target,workspaceId:e.target.value,notebookId:""})}>{workspaces.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
        <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">笔记本</span><select className="h-9 rounded-lg border bg-background px-3 text-sm" value={target.notebookId} onChange={e=>setTarget({...target,notebookId:e.target.value})}>{books.map(b=><option key={b.id} value={b.id}>{b.title}</option>)}</select></label>
        <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">标题（留空取正文第一行）</span><Input value={target.title} onChange={e=>setTarget({...target,title:e.target.value})}/></label>
      </div>
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={()=>setPromote(null)}>取消</Button><Button disabled={busy||!target.notebookId} onClick={doPromote}>{busy?"创建中…":"创建笔记"}</Button></div>
    </DialogContent></Dialog>
  </div>;
}
