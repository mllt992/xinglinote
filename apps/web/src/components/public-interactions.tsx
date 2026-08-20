import{useEffect,useState}from'react';import{MessageSquare,PencilLine,Reply,Send}from'lucide-react';import{api}from'../api';import{Button}from'./ui/button';import{Input}from'./ui/input';import{Textarea}from'./ui/textarea';import{Badge}from'./ui/badge';import{useToast}from'./ui/toast';import{FormError}from'./ui/form-error';

type Comment={id:string;body:string;parentId:string|null;author:string;createdAt:string;editedAt:string|null;mine:boolean;editableUntil:string};
type Challenge={question:string;token:string};

/** 分享页与文档站底部的互动区：评论一层回复、5 分钟内可改、访客要过一道算术题。 */
export function PublicInteractions({noteId,shareToken,siteNotebookId,commentsEnabled,correctionsEnabled,bodyMd}:{noteId:string;shareToken?:string;siteNotebookId?:string;commentsEnabled:boolean;correctionsEnabled:boolean;bodyMd:string}){
  const source=shareToken?`shareToken=${shareToken}`:`siteNotebookId=${siteNotebookId}`;
  const toast=useToast();
  const[comments,setComments]=useState<Comment[]>([]);const[body,setBody]=useState("");const[name,setName]=useState("");
  const[sendErr,setSendErr]=useState("");const[fixErr,setFixErr]=useState("");const[editErr,setEditErr]=useState("");
  const[replyTo,setReplyTo]=useState<Comment|null>(null);const[editing,setEditing]=useState<Comment|null>(null);const[draft,setDraft]=useState("");
  const[challenge,setChallenge]=useState<Challenge|null>(null);const[answer,setAnswer]=useState("");
  const[fixOpen,setFixOpen]=useState(false);const[fix,setFix]=useState({originalExcerpt:"",suggested:"",comment:""});
  const load=()=>api<{comments:Comment[]}>(`/api/v1/public/notes/${noteId}/comments?${source}`).then(d=>setComments(d.comments)).catch(()=>setComments([]));
  const newChallenge=()=>api<Challenge>("/api/v1/public/captcha").then(c=>{setChallenge(c);setAnswer("")}).catch(()=>setChallenge(null));
  useEffect(()=>{void load();void newChallenge()},[noteId,source]);
  const roots=comments.filter(c=>!c.parentId);
  const repliesOf=(id:string)=>comments.filter(c=>c.parentId===id).sort((a,b)=>+new Date(a.createdAt)-+new Date(b.createdAt));
  const editable=(c:Comment)=>c.mine&&new Date(c.editableUntil).getTime()>Date.now();

  async function send(e:React.FormEvent){
    e.preventDefault();setSendErr("");
    try{
      const d=await api<{status:string}>(`/api/v1/public/notes/${noteId}/comments?${source}`,{method:"POST",body:JSON.stringify({body,parentId:replyTo?.id??null,guestName:name||undefined,challengeToken:challenge?.token,challengeAnswer:answer||undefined})});
      // 验证码 token 现在是一次性的，发完就换一题
      void newChallenge();
      setBody("");setReplyTo(null);
      if(d.status==="pending")toast.success("评论已提交","等待作者审核后才会公开显示。");else toast.success("评论已发布");
      void newChallenge();void load();
    }catch(x){setSendErr((x as Error).message);void newChallenge();}
  }

  return <section className="mx-auto mt-16 max-w-3xl border-t pt-10">
    <div className="flex flex-wrap items-center gap-3">
      <h2 className="text-xl font-semibold">评论</h2><Badge>{comments.length}</Badge>
      {correctionsEnabled&&<Button variant="outline" size="sm" className="ml-auto" onClick={()=>setFixOpen(v=>!v)}><PencilLine/>发现错误？提个纠错</Button>}
    </div>

    {correctionsEnabled&&fixOpen&&<form className="mt-5 space-y-3 rounded-xl border bg-muted/30 p-4" onSubmit={async e=>{e.preventDefault();setFixErr("");
      // 纠错和评论走同一套访客门槛：服务端现在也要验证码了
      try{await api(`/api/v1/public/notes/${noteId}/corrections?${source}`,{method:"POST",body:JSON.stringify({...fix,guestName:name||undefined,challengeToken:challenge?.token,challengeAnswer:answer||undefined})});setFix({originalExcerpt:"",suggested:"",comment:""});setFixOpen(false);setAnswer("");void newChallenge();toast.success("纠错已提交","等待作者审核，接受后会直接改到正文。")}catch(x){setFixErr((x as Error).message);void newChallenge()}}}>
      <p className="text-xs text-muted-foreground">把原文里要改的那一段原样粘进来，作者接受后会直接打补丁到正文。</p>
      <Textarea required value={fix.originalExcerpt} onChange={e=>setFix({...fix,originalExcerpt:e.target.value})} placeholder="原文片段（必须能在正文里找到）" className="min-h-16"/>
      <Textarea value={fix.suggested} onChange={e=>setFix({...fix,suggested:e.target.value})} placeholder="建议改成" className="min-h-16"/>
      <Input value={fix.comment} onChange={e=>setFix({...fix,comment:e.target.value})} placeholder="说明（可选）"/>
      {challenge&&<div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">访客请作答：{challenge.question}</span><Input className="w-24" value={answer} onChange={e=>setAnswer(e.target.value)} inputMode="numeric" placeholder="答案"/><Button type="button" variant="ghost" size="sm" onClick={()=>void newChallenge()}>换一题</Button></div>}
      <div className="flex gap-2"><Button size="sm" disabled={!fix.originalExcerpt.trim()||!bodyMd.includes(fix.originalExcerpt.trim())}>提交纠错</Button><Button size="sm" variant="ghost" type="button" onClick={()=>setFixOpen(false)}>取消</Button>
        {fix.originalExcerpt.trim()&&!bodyMd.includes(fix.originalExcerpt.trim())&&<span className="self-center text-xs text-destructive">这段文字在正文里找不到</span>}</div>
      <FormError>{fixErr}</FormError>
    </form>}

    <div className="mt-5 space-y-4">{roots.length===0?<p className="text-sm text-muted-foreground">还没有公开评论。</p>:roots.map(c=><div key={c.id} className="rounded-xl bg-muted/50 p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><b className="text-foreground">{c.author}</b><span>{new Date(c.createdAt).toLocaleString()}</span>{c.editedAt&&<Badge>已编辑</Badge>}
        <span className="ml-auto flex gap-1">{commentsEnabled&&<Button variant="ghost" size="sm" onClick={()=>{setReplyTo(c);setEditing(null)}}><Reply/>回复</Button>}
          {editable(c)&&<Button variant="ghost" size="sm" onClick={()=>{setEditErr("");setEditing(c);setDraft(c.body);setReplyTo(null)}}><PencilLine/>编辑</Button>}</span></div>
      {editing?.id===c.id
        ? <form className="mt-2 space-y-2" onSubmit={async e=>{e.preventDefault();setEditErr("");try{await api(`/api/v1/public/comments/${c.id}`,{method:"PATCH",body:JSON.stringify({body:draft})});setEditing(null);toast.success("评论已更新");void load()}catch(x){setEditErr((x as Error).message)}}}>
            <Textarea value={draft} onChange={e=>setDraft(e.target.value)} className="min-h-16"/><div className="flex gap-2"><Button size="sm">保存</Button><Button size="sm" variant="ghost" type="button" onClick={()=>setEditing(null)}>取消</Button><span className="self-center text-[11px] text-muted-foreground">发布后 5 分钟内可改</span></div><FormError>{editErr}</FormError></form>
        : <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{c.body}</p>}
      {repliesOf(c.id).map(r=><div key={r.id} className="mt-3 border-l-2 border-border pl-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><b className="text-foreground">{r.author}</b><span>{new Date(r.createdAt).toLocaleString()}</span>{r.editedAt&&<Badge>已编辑</Badge>}</div>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-6">{r.body}</p></div>)}
    </div>)}</div>

    {commentsEnabled?<form className="mt-6 space-y-3" onSubmit={send}>
      {replyTo&&<p className="flex items-center gap-2 text-xs text-muted-foreground"><MessageSquare className="size-3.5"/>正在回复 <b>{replyTo.author}</b><Button type="button" variant="ghost" size="sm" onClick={()=>setReplyTo(null)}>取消</Button></p>}
      <Input value={name} onChange={e=>setName(e.target.value)} placeholder="访客昵称（登录用户可留空）"/>
      <Textarea value={body} onChange={e=>setBody(e.target.value)} placeholder={replyTo?`回复 ${replyTo.author}…`:"写下评论…"} maxLength={2000}/>
      {challenge&&<div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">访客请作答：{challenge.question}</span><Input className="w-24" value={answer} onChange={e=>setAnswer(e.target.value)} inputMode="numeric" placeholder="答案"/><Button type="button" variant="ghost" size="sm" onClick={()=>void newChallenge()}>换一题</Button></div>}
      <FormError>{sendErr}</FormError>
      <div className="flex items-center gap-3"><Button disabled={!body.trim()}><Send/>发表评论</Button></div>
    </form>:<p className="mt-6 text-sm text-muted-foreground">这条链接关闭了评论。</p>}
  </section>;
}
