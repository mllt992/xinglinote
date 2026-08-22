import{useEffect,useMemo,useRef,useState}from'react';import{useSearchParams}from'react-router-dom';import{parseMentions}from'@kb/shared';import{FileText,Flag,Globe2,Heart,ImagePlus,MessageSquare,MoreHorizontal,NotebookPen,Paperclip,Pencil,RefreshCw,Send,Star,Trash2,X}from'lucide-react';import{api}from'../api';import{cn}from'../lib/utils';import{openLightbox}from'../lib/lightbox';import{Button}from'./ui/button';import{Textarea}from'./ui/textarea';import{Input}from'./ui/input';import{Badge}from'./ui/badge';import{Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle}from'./ui/dialog';import{DropdownMenu,DropdownMenuContent,DropdownMenuItem,DropdownMenuTrigger}from'./ui/dropdown-menu';import{useConfirm}from'./ui/confirm';import{useToast}from'./ui/toast';import{FormError}from'./ui/form-error';
import{FeedComments}from'./feed-comments';
import{MentionField}from'./mention-field';
import{type MentionAgent}from'./mention-text';
import{MarkdownView}from'../MarkdownView';
import{FEED_REFRESH_EVENT,formatFeedUpdateLabel,readOpenComments,updatesPath,writeFeedSeen,writeOpenComments,type FeedUpdateCounts}from'./feed-updates';

export type PostAsset={id:string;filename:string;mime:string;bytes:number;kind:"image"|"video"|"file";url:string};
export type FeedPost={id:string;body:string;visibility:string;workspaceId:string|null;createdAt:string;editedAt:string|null;mine:boolean;author:{handle:string;displayName:string}|null;note:{id:string;title:string}|null;likes:number;liked:boolean;comments?:number;favorited?:boolean;status?:string;moderationQueued?:boolean;moderationReason?:string|null;appealable?:boolean;appealing?:boolean;assets?:PostAsset[];tags?:string[]};
const ACCEPT="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,application/pdf,text/plain,text/markdown,application/zip";
function formatSize(n:number){if(n<1024)return`${n} B`;if(n<1024*1024)return`${(n/1024).toFixed(1)} KB`;return`${(n/1024/1024).toFixed(1)} MB`;}
export function PostAssetGrid({assets}:{assets:PostAsset[]}){
  if(!assets.length)return null;
  const images=assets.filter(a=>a.kind==="image");
  const rest=assets.filter(a=>a.kind!=="image");
  return <div className="mt-3 space-y-2">
    {images.length>0&&<div className={cn("grid gap-2",images.length===1?"grid-cols-1":"grid-cols-2")}>
      {images.map(a=><button key={a.id} type="button" onClick={()=>openLightbox(a.url,a.filename)} className="overflow-hidden rounded-xl border bg-muted">
        <img src={a.url} alt={a.filename} className="max-h-72 w-full object-cover"/>
      </button>)}
    </div>}
    {rest.map(a=>a.kind==="video"
      ?<video key={a.id} src={a.url} controls preload="metadata" className="w-full rounded-xl border bg-black"/>
      :<a key={a.id} href={a.url} download={a.filename} className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm hover:bg-muted">
        <FileText className="size-4 shrink-0"/><span className="min-w-0 truncate">{a.filename}</span>
        <span className="ml-auto text-xs text-muted-foreground">{formatSize(a.bytes)}</span>
      </a>)}
  </div>;
}
const REPORT_REASONS:Array<[string,string]>=[["spam","垃圾广告与引流"],["abuse","辱骂人身攻击"],["illegal","违法违禁"],["porn","色情低俗"],["other","其他"]];
type Held={held:boolean;queued?:boolean;message:string|null};
/** 审核中 / 待人工 / 被驳回的帖子只有作者自己看得到，标一下省得他以为发失败了。 */
function HeldNote({post,onAppeal}:{post:FeedPost;onAppeal?:(p:FeedPost)=>void}){
  if(!post.status||post.status==="visible")return null;
  const queued=!!post.moderationQueued;
  const pending=post.status==="pending_review";
  const label=queued?"审核中":post.appealing?"申诉处理中":pending?"待人工审核":"已下架";
  const hint=post.moderationReason??(queued?"正在审核，通过后会公开显示。":post.appealing?"已提交申诉，等管理员再看一遍。":pending?"AI 拿不准，等管理员再看一眼。":"AI 判定不通过，已下架。有异议可以申诉。");
  return <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
    <Badge className={pending||queued||post.appealing?"border-transparent bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)]":"border-transparent bg-destructive/10 text-destructive"}>{label}</Badge>
    <span>{hint}</span>
    <span className="text-muted-foreground/70">只有你自己看得到这条</span>
    {post.appealable&&onAppeal&&<Button size="sm" variant="outline" className="ml-auto h-7 px-2 text-xs" onClick={()=>onAppeal(post)}>申诉</Button>}
  </div>;
}
type Nb={id:string;title:string};

/** 广场与圈子共用一套时间线。scope=workspace 时发的是圈子动态。 */
export function FeedView({scope,workspaceId,workspaces,canPost,signedIn,canModerate,onOpenNote,onLoaded}:{scope:"public"|"workspace";workspaceId?:string;workspaces:Array<{id:string;name:string}>;canPost:boolean;signedIn?:boolean;canModerate?:boolean;onOpenNote?:(workspaceId:string,noteId:string)=>void;onLoaded?:(posts:FeedPost[])=>void}){
  const askConfirm=useConfirm();const toast=useToast();
  const[searchParams,setSearchParams]=useSearchParams();
  const[posts,setPosts]=useState<FeedPost[]>([]);const[body,setBody]=useState("");const[err,setErr]=useState("");const[dlgErr,setDlgErr]=useState("");const[busy,setBusy]=useState(false);
  const[editing,setEditing]=useState<FeedPost|null>(null);const[draft,setDraft]=useState("");
  const[promote,setPromote]=useState<FeedPost|null>(null);const[target,setTarget]=useState({workspaceId:"",notebookId:"",title:""});const[books,setBooks]=useState<Nb[]>([]);
  const[openComments,setOpenCommentsState]=useState<string|null>(()=>searchParams.get("post")||readOpenComments(scope,workspaceId));const[commentTick,setCommentTick]=useState<Record<string,number>>({});
  const setOpenComments=(id:string|null)=>{setOpenCommentsState(id);writeOpenComments(scope,workspaceId,id);};
  const[reporting,setReporting]=useState<FeedPost|null>(null);const[reportReason,setReportReason]=useState("spam");const[reportNote,setReportNote]=useState("");
  const[appealing,setAppealing]=useState<FeedPost|null>(null);const[appealNote,setAppealNote]=useState("");
  const[updates,setUpdates]=useState<FeedUpdateCounts>({newPosts:0,repliedPosts:0});
  const[refreshing,setRefreshing]=useState(false);
  const[fresh,setFresh]=useState<{newIds:Set<string>;repliedIds:Set<string>}|null>(null);
  const[assets,setAssets]=useState<PostAsset[]>([]);const[uploading,setUploading]=useState(false);
  const[agents,setAgents]=useState<MentionAgent[]>([]);
  const[popularTags,setPopularTags]=useState<string[]>([]);
  const mentionHandles=useMemo(()=>agents.map(a=>a.handle),[agents]);
  const activeTag=searchParams.get("tag")?.trim()??"";
  const pickTag=(tag:string|null)=>{
    const next=new URLSearchParams(searchParams);
    if(tag)next.set("tag",tag);else next.delete("tag");
    next.delete("post");
    setSearchParams(next,{replace:true});
  };
  const fileRef=useRef<HTMLInputElement>(null);
  const path=scope==="public"?"/api/v1/feed/public":`/api/v1/feed/workspaces/${workspaceId}`;
  const listPath=activeTag?`${path}?tag=${encodeURIComponent(activeTag)}`:path;
  const tagsPath=scope==="public"?"/api/v1/feed/public/tags":`/api/v1/feed/workspaces/${workspaceId}/tags`;
  /** 单条动态的点赞、编辑、删除就地改这一条：整条时间线重拉会闪一下、丢滚动位置，点个赞不该付这个代价。
      listRef 只经 apply 写入，所以连点两下也不会拿到上一次渲染的旧列表。 */
  const listRef=useRef<FeedPost[]>([]);
  const sinceRef=useRef(new Date().toISOString());
  const apply=(next:FeedPost[])=>{listRef.current=next;setPosts(next);onLoaded?.(next)};
  const patchOne=(id:string,fn:(p:FeedPost)=>FeedPost)=>apply(listRef.current.map(p=>p.id===id?fn(p):p));
  const dropOne=(id:string)=>apply(listRef.current.filter(p=>p.id!==id));
  const rememberSeen=(at:string)=>{sinceRef.current=at;writeFeedSeen(scope,workspaceId,at);setUpdates({newPosts:0,repliedPosts:0});};
  const load=()=>api<{posts:FeedPost[];now?:string}>(listPath).then(d=>{apply(d.posts);rememberSeen(d.now??new Date().toISOString());setFresh(null);}).catch(e=>toast.error("加载动态失败",(e as Error).message));
  async function refreshUpdates(){
    if(refreshing)return;setRefreshing(true);
    try{
      const d=await api<{posts:FeedPost[];now?:string}>(listPath);
      const prev=new Map(listRef.current.map(p=>[p.id,p]));
      const newIds=new Set(d.posts.filter(p=>!prev.has(p.id)).map(p=>p.id));
      const repliedIds=new Set(d.posts.filter(p=>{const old=prev.get(p.id);return!!old&&(p.comments??0)>(old.comments??0);}).map(p=>p.id));
      apply(d.posts);
      rememberSeen(d.now??new Date().toISOString());
      setFresh(newIds.size||repliedIds.size?{newIds,repliedIds}:null);
      if(repliedIds.size)setCommentTick(t=>{const next={...t};for(const id of repliedIds)next[id]=(next[id]??0)+1;return next;});
    }catch(e){toast.error("刷新动态失败",(e as Error).message);}
    finally{setRefreshing(false);}
  }
  useEffect(()=>{void load()},[listPath]);
  useEffect(()=>{api<{tags:Array<{name:string}>}>(tagsPath).then(d=>setPopularTags(d.tags.map(t=>t.name))).catch(()=>setPopularTags([]));},[tagsPath]);
  const deepPost=searchParams.get("post");
  useEffect(()=>{
    setOpenCommentsState(deepPost||readOpenComments(scope,workspaceId));
  },[path,scope,workspaceId,deepPost]);
  useEffect(()=>{
    if(!deepPost)return;
    const el=document.getElementById(`feed-post-${deepPost}`);
    if(el)el.scrollIntoView({block:"nearest",behavior:"smooth"});
  },[deepPost,posts.length]);
  useEffect(()=>{api<{agents:MentionAgent[]}>(`/api/v1/agents?scope=${scope==="public"?"square":"circle"}`).then(d=>setAgents(d.agents)).catch(()=>setAgents([]));},[scope]);
  useEffect(()=>{
    const tick=()=>{
      if(document.visibilityState!=="visible")return;
      api<FeedUpdateCounts>(`${updatesPath(scope,workspaceId)}?since=${encodeURIComponent(sinceRef.current)}`)
        .then(setUpdates).catch(()=>{});
    };
    const timer=window.setInterval(tick,30_000);
    const onVis=()=>{if(document.visibilityState==="visible")tick();};
    const onRefresh=(e:Event)=>{const want=(e as CustomEvent<{scope?:string}>).detail?.scope;if(!want||want===scope)void refreshUpdates();};
    document.addEventListener("visibilitychange",onVis);
    window.addEventListener(FEED_REFRESH_EVENT,onRefresh);
    return()=>{window.clearInterval(timer);document.removeEventListener("visibilitychange",onVis);window.removeEventListener(FEED_REFRESH_EVENT,onRefresh);};
  },[path,scope,workspaceId]);
  useEffect(()=>{if(!fresh)return;const t=window.setTimeout(()=>setFresh(null),12_000);return()=>window.clearTimeout(t);},[fresh]);
  useEffect(()=>{if(!target.workspaceId)return setBooks([]);api<{notebooks:Nb[]}>(`/api/v1/workspaces/${target.workspaceId}/notebooks`).then(d=>{setBooks(d.notebooks);setTarget(t=>({...t,notebookId:d.notebooks[0]?.id??""}))}).catch(()=>setBooks([]))},[target.workspaceId]);

  async function addFiles(list:FileList|File[]){
    const files=[...list];if(!files.length)return;
    if(assets.length+files.length>9){toast.error("一条动态最多 9 个附件");return;}
    setUploading(true);
    try{
      for(const file of files){
        const form=new FormData();form.append("file",file);
        const res=await fetch("/api/v1/posts/attachments",{method:"POST",body:form,credentials:"include",headers:{"X-Requested-With":"fetch"}});
        const json=await res.json() as {ok:true;data:PostAsset}|{ok:false;error:{message:string}};
        if(!json.ok)throw new Error(json.error.message);
        setAssets(v=>[...v,json.data]);
      }
    }catch(e){toast.error("上传失败",(e as Error).message);}
    finally{setUploading(false);if(fileRef.current)fileRef.current.value="";}
  }
  async function dropAsset(a:PostAsset){
    setAssets(v=>v.filter(x=>x.id!==a.id));
    try{await api(`/api/v1/posts/attachments/${a.id}`,{method:"DELETE"});}catch{/* 框里已经拿掉了 */}
  }
  async function submit(){
    if(!body.trim()&&!assets.length)return;setBusy(true);setErr("");
    try{
      if(scope==="public"&&body.trim()){
        const scan=await api<{links:Array<{title:string;publiclyVisible:boolean}>}>("/api/v1/posts/leak-check",{method:"POST",body:JSON.stringify({body})});
        const leaked=scan.links.filter(l=>!l.publiclyVisible).map(l=>l.title);
        if(leaked.length&&!await askConfirm({title:"这条动态里有对外看不到的链接",description:<>发到广场后，下面这些链接会退化成纯文本，读者点不开：<span className="mt-2 block font-medium text-foreground">{leaked.join("、")}</span></>,confirmText:"仍然发布"})){setBusy(false);return;}
      }
      const created=await api<{id?:string;status?:string;moderation?:Held}>("/api/v1/posts",{method:"POST",body:JSON.stringify({body,visibility:scope,attachmentIds:assets.map(a=>a.id),...(scope==="workspace"?{workspaceId}:{})})});
      const called=parseMentions(body).filter(h=>agents.some(a=>a.handle===h));
      if(created.moderation?.queued)toast.success("已发布",created.moderation.message??"审核通过后会公开显示。");
      else if(created.moderation?.held)toast.success("已提交，等待人工审核",created.moderation.message??undefined);
      else if(called.length)toast.success("已发布",`已叫到 ${called.map(h=>`@${h}`).join("、")}，回复会出现在评论里。`);
      else toast.success("已发布");
      setBody("");setAssets([]);await load();
      if(created.id&&called.length&&!created.moderation?.held)setOpenComments(created.id);
    }catch(e){setErr((e as Error).message)}finally{setBusy(false)}
  }
  async function like(p:FeedPost){if(!signedIn){toast.error("请先登录");return;}try{const d=await api<{liked:boolean}>(`/api/v1/posts/${p.id}/like`,{method:"POST"});patchOne(p.id,x=>({...x,liked:d.liked,likes:Math.max(0,x.likes+(d.liked?1:-1))}))}catch(e){toast.error("操作失败",(e as Error).message)}}
  async function favorite(p:FeedPost){if(!signedIn){toast.error("请先登录");return;}const next=!p.favorited;patchOne(p.id,x=>({...x,favorited:next}));try{await api(`/api/v1/posts/${p.id}/favorite`,{method:next?"PUT":"DELETE"});}catch(e){patchOne(p.id,x=>({...x,favorited:!next}));toast.error("收藏失败",(e as Error).message)}}
  async function report(){if(!reporting)return;setBusy(true);setDlgErr("");try{await api(`/api/v1/posts/${reporting.id}/report`,{method:"POST",body:JSON.stringify({reason:reportReason,note:reportNote.trim()||undefined})});toast.success("已收到举报","会先交给 AI 复核，拿不准再转人工。");setReporting(null);setReportNote("");}catch(e){setDlgErr((e as Error).message)}finally{setBusy(false)}}
  async function appeal(){if(!appealing)return;setBusy(true);setDlgErr("");try{await api(`/api/v1/posts/${appealing.id}/appeal`,{method:"POST",body:JSON.stringify({note:appealNote.trim()||undefined})});toast.success("申诉已提交","管理员会再看一遍。");patchOne(appealing.id,x=>({...x,appealable:false,appealing:true}));setAppealing(null);setAppealNote("");}catch(e){setDlgErr((e as Error).message)}finally{setBusy(false)}}
  async function remove(p:FeedPost){if(!await askConfirm({title:"删除这条动态？",description:p.mine?"动态和它收到的点赞会一起删除，不可恢复。已经转正成笔记的内容不受影响。":"这是别人发的。删掉之后时间线上立刻消失，不可恢复。",confirmText:"删除",destructive:true}))return;try{await api(`/api/v1/posts/${p.id}`,{method:"DELETE"});toast.success("已删除这条动态");dropOne(p.id)}catch(e){toast.error("删除失败",(e as Error).message)}}
  async function toSquare(p:FeedPost){
    try{const d=await api<{strippedLinks:string[];moderation?:Held}>(`/api/v1/posts/${p.id}/publish-to-square`,{method:"POST",body:JSON.stringify({})});
      if(d.moderation?.queued)toast.success("已复制到广场",d.moderation.message??"审核通过后会公开显示。");
      else if(d.moderation?.held)toast.success("已提交到广场，等待人工审核",d.moderation.message??undefined);
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
    {activeTag&&<div className="flex items-center gap-2 rounded-xl border bg-background px-3 py-2 text-sm">
      <span>正在看 <b className="text-primary">#{activeTag}</b></span>
      <Button variant="ghost" size="sm" className="ml-auto h-7" onClick={()=>pickTag(null)}>看全部</Button>
    </div>}
    {canPost&&<div className="rounded-2xl border bg-background p-4">
      <MentionField value={body} onChange={setBody} agents={agents} tags={popularTags} maxLength={5000} placeholder={scope==="public"?"发到广场，实例里所有人可见。可以用 [[双链]] 引用已公开的笔记，也可以 @ 智能体、#标签。":"发到本工作区的圈子，只有成员看得到。输入 @ 可叫智能体，# 可加标签。"} className="min-h-24"/>
      {assets.length>0&&<div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {assets.map(a=><div key={a.id} className="relative overflow-hidden rounded-xl border bg-muted">
          {a.kind==="image"?<img src={a.url} alt={a.filename} className="h-28 w-full object-cover"/>
          :a.kind==="video"?<video src={a.url} className="h-28 w-full object-cover" muted/>
          :<div className="flex h-28 flex-col justify-end p-2"><FileText className="size-5 text-muted-foreground"/><p className="mt-1 truncate text-xs">{a.filename}</p><p className="text-[11px] text-muted-foreground">{formatSize(a.bytes)}</p></div>}
          <button type="button" aria-label={`移除 ${a.filename}`} onClick={()=>void dropAsset(a)} className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-background/90 text-muted-foreground hover:text-foreground"><X className="size-3.5"/></button>
        </div>)}
      </div>}
      <FormError className="mt-3">{err}</FormError>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input ref={fileRef} type="file" accept={ACCEPT} multiple className="hidden" onChange={e=>{if(e.target.files)void addFiles(e.target.files);e.target.accept=ACCEPT;}}/>
        <Button type="button" variant="outline" size="sm" disabled={busy||uploading||assets.length>=9} onClick={()=>{if(fileRef.current){fileRef.current.accept="image/png,image/jpeg,image/webp,image/gif";fileRef.current.click();}}}><ImagePlus/>图片</Button>
        <Button type="button" variant="outline" size="sm" disabled={busy||uploading||assets.length>=9} onClick={()=>{if(fileRef.current){fileRef.current.accept="video/mp4,video/webm";fileRef.current.click();}}}><Paperclip/>视频</Button>
        <Button type="button" variant="outline" size="sm" disabled={busy||uploading||assets.length>=9} onClick={()=>{if(fileRef.current){fileRef.current.accept="application/pdf,text/plain,text/markdown,application/zip";fileRef.current.click();}}}><FileText/>文件</Button>
        <Button disabled={busy||uploading||(!body.trim()&&!assets.length)} onClick={submit}><Send/>{busy?"发布中…":uploading?"上传中…":"发布"}</Button>
        <span className="text-xs text-muted-foreground">{body.length}/5000{assets.length?` · ${assets.length}/9 附件`:""}</span>
      </div>
    </div>}
    {(updates.newPosts>0||updates.repliedPosts>0)&&<button type="button" onClick={()=>void refreshUpdates()} disabled={refreshing}
      className="sticky top-2 z-10 flex w-full items-center justify-center gap-2 rounded-xl border bg-background px-3 py-2 text-sm font-medium shadow-sm hover:bg-muted disabled:opacity-70">
      <RefreshCw className={cn("size-4",refreshing&&"animate-spin")}/>
      <span>{formatFeedUpdateLabel(updates)}</span>
      <span className="text-xs font-normal text-muted-foreground">{refreshing?"更新中…":"点击查看"}</span>
    </button>}
    {posts.length===0?<div className="rounded-2xl border border-dashed py-14 text-center"><span className="mx-auto grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground"><Globe2 className="size-5"/></span><p className="mt-3 text-sm font-medium">{activeTag?`还没有 #${activeTag}`:"还没有动态"}</p><p className="mt-1 text-xs text-muted-foreground">{activeTag?"换个标签，或发一条带这个标签的动态。":scope==="public"?"第一条公开动态还没出现。":"圈子里的碎片想法可以先发这里，之后再转正为笔记。"}</p></div>
    :posts.map(p=><article key={p.id} id={`feed-post-${p.id}`} className={cn("rounded-2xl border bg-background p-4", (fresh?.newIds.has(p.id)||fresh?.repliedIds.has(p.id))&&"border-primary/40")}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <b className="text-sm text-foreground">{p.author?.displayName??"已注销用户"}</b>
        {p.author&&<a className="hover:underline" href={`/u/${p.author.handle}`}>@{p.author.handle}</a>}
        <span>{new Date(p.createdAt).toLocaleString()}</span>{p.editedAt&&<Badge>已编辑</Badge>}
        {fresh?.newIds.has(p.id)&&<Badge>新</Badge>}
        {fresh?.repliedIds.has(p.id)&&<Badge>有新回复</Badge>}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={()=>void like(p)}><Heart className={p.liked?"fill-current":""}/>{p.likes||""}</Button>
          <Button variant="ghost" size="sm" aria-expanded={openComments===p.id} aria-controls={`feed-comments-${p.id}`} onClick={()=>setOpenComments(openComments===p.id?null:p.id)}><MessageSquare/>{openComments===p.id?"收起评论":p.comments?`${p.comments} 条评论`:"评论"}</Button>
          <Button variant="ghost" size="sm" aria-label={p.favorited?"取消收藏":"收藏"} onClick={()=>void favorite(p)}><Star className={p.favorited?"fill-current":""}/></Button>
          {(p.mine||scope==="workspace"||signedIn)&&<DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="更多操作"><MoreHorizontal/></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
            {p.mine&&<DropdownMenuItem onSelect={()=>{setDlgErr("");setEditing(p);setDraft(p.body)}}><Pencil/>编辑</DropdownMenuItem>}
            {(p.mine||scope==="workspace")&&<DropdownMenuItem onSelect={()=>{setDlgErr("");setPromote(p);setTarget({workspaceId:workspaceId??workspaces[0]?.id??"",notebookId:"",title:""})}}><NotebookPen/>转正为笔记</DropdownMenuItem>}
            {p.mine&&p.visibility==="workspace"&&<DropdownMenuItem onSelect={()=>void toSquare(p)}><Globe2/>公开到广场</DropdownMenuItem>}
            {(p.mine||canModerate)&&<DropdownMenuItem className="text-destructive" onSelect={()=>void remove(p)}><Trash2/>删除</DropdownMenuItem>}
            {signedIn&&!p.mine&&p.status==="visible"&&<DropdownMenuItem onSelect={()=>{setDlgErr("");setReportReason("spam");setReportNote("");setReporting(p)}}><Flag/>举报</DropdownMenuItem>}
          </DropdownMenuContent></DropdownMenu>}
        </div>
      </div>
      {p.body&&<MarkdownView source={p.body} mode={scope==="public"?"public":"library"} mentionHandles={mentionHandles} hashtags onHashtag={pickTag} className="feed-md mt-3"/>}
      <PostAssetGrid assets={p.assets??[]}/>
      <HeldNote post={p} onAppeal={x=>{setDlgErr("");setAppealNote("");setAppealing(x)}}/>
      {p.note&&<button className="mt-3 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs hover:bg-muted" onClick={()=>p.workspaceId&&onOpenNote?.(p.workspaceId,p.note!.id)}><NotebookPen className="size-3.5"/>{p.note.title}</button>}
      {openComments!==p.id&&(p.comments??0)>0&&<button type="button" className="mt-3 text-left text-xs text-muted-foreground hover:text-foreground" onClick={()=>setOpenComments(p.id)}>查看 {p.comments} 条评论</button>}
      {openComments===p.id&&<FeedComments key={`${p.id}:${commentTick[p.id]??0}`} postId={p.id} signedIn={!!signedIn} agents={agents} onCount={n=>patchOne(p.id,x=>({...x,comments:n}))}/>}
    </article>)}

    <Dialog open={!!editing} onOpenChange={v=>{if(!v)setEditing(null);setDlgErr("")}}><DialogContent>
      <DialogHeader><DialogTitle>编辑动态</DialogTitle><DialogDescription>改完会标上「已编辑」。</DialogDescription></DialogHeader>
      <MentionField value={draft} onChange={setDraft} agents={agents} tags={popularTags} className="min-h-32" maxLength={5000}/>
      <FormError>{dlgErr}</FormError>
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={()=>setEditing(null)}>取消</Button><Button disabled={busy||!draft.trim()} onClick={async()=>{if(!editing)return;setBusy(true);try{const d=await api<{editedAt?:string;status?:string;moderation?:Held}>(`/api/v1/posts/${editing.id}`,{method:"PATCH",body:JSON.stringify({body:draft})});if(d.moderation?.queued)toast.success("改动已提交",d.moderation.message??"审核通过后会公开显示。");else if(d.moderation?.held)toast.success("改动已提交，等待人工审核",d.moderation.message??undefined);patchOne(editing.id,x=>({...x,body:draft,editedAt:d.editedAt??new Date().toISOString(),status:d.status??x.status,moderationQueued:!!d.moderation?.queued,moderationReason:d.moderation?.message??null}));setEditing(null)}catch(e){setDlgErr((e as Error).message)}finally{setBusy(false)}}}>保存</Button></div>
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

    <Dialog open={!!reporting} onOpenChange={v=>{if(!v)setReporting(null);setDlgErr("")}}><DialogContent>
      <DialogHeader><DialogTitle className="flex items-center gap-2"><Flag className="size-5"/>举报这条动态</DialogTitle><DialogDescription>管理员会看到理由和原文。恶意举报会被限制。</DialogDescription></DialogHeader>
      <div className="grid gap-2">{REPORT_REASONS.map(([k,label])=><label key={k} className="flex items-center gap-2 text-sm"><input type="radio" name="report-reason" checked={reportReason===k} onChange={()=>setReportReason(k)}/>{label}</label>)}</div>
      <Textarea value={reportNote} onChange={e=>setReportNote(e.target.value)} maxLength={500} placeholder="补充说明（可选）" className="min-h-20"/>
      <FormError>{dlgErr}</FormError>
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={()=>setReporting(null)}>取消</Button><Button disabled={busy} onClick={()=>void report()}>{busy?"提交中…":"提交举报"}</Button></div>
    </DialogContent></Dialog>

    <Dialog open={!!appealing} onOpenChange={v=>{if(!v)setAppealing(null);setDlgErr("")}}><DialogContent>
      <DialogHeader><DialogTitle>申诉这条下架</DialogTitle><DialogDescription>AI 已经判过一次。申诉会交给管理员再看，说明为什么你认为不该下架。</DialogDescription></DialogHeader>
      <Textarea value={appealNote} onChange={e=>setAppealNote(e.target.value)} maxLength={500} placeholder="申诉理由（可选）" className="min-h-24"/>
      <FormError>{dlgErr}</FormError>
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={()=>setAppealing(null)}>取消</Button><Button disabled={busy} onClick={()=>void appeal()}>{busy?"提交中…":"提交申诉"}</Button></div>
    </DialogContent></Dialog>
  </div>;
}
