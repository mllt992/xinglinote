import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { BookmarkPlus, Clipboard, Download, Link2, LoaderCircle, Scissors, ShieldCheck, X } from 'lucide-react';
import { api, type Me } from '../api';
import { beginClip,clipPending,emptyClip,endClip,readClipDrafts,removeClipDraft,subscribeClips,writeClipDraft,type ClipDraft,type ClipInput } from '../lib/clip-drafts';
import { Button } from './ui/button';
import { useConfirm } from './ui/confirm';
import { Input } from './ui/input';
import { DEVICE_PREFIX } from '../lib/device-storage';
import { clipBookmarklet } from '../lib/clip-bookmarklet';

type Target={id:string;title:string};
type Preview={title:string;bodyMd:string;excerpt:string;images:{url:string;alt:string}[];warnings:string[]};
const field='w-full min-w-0 rounded-lg border border-border bg-background p-2.5 text-sm';
const store=()=>sessionStorage;
function drafts(user:string){try{return readClipDrafts(store(),user);}catch{return [];}}
function exportDraft(row:ClipDraft){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(row,null,2)],{type:'application/json'}));a.href=url;a.download='xingli-clip-draft.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

export function ClipCapturePage(){
 const location=useLocation(),[me,setMe]=useState<Me|null|undefined>();
 useEffect(()=>{let sequence=0,controller:AbortController|null=null;const check=()=>{const generation=++sequence;controller?.abort();controller=new AbortController();setMe(undefined);api<Me>('/api/v1/me',{signal:controller.signal}).then(value=>{if(generation===sequence)setMe(value);}).catch(()=>{if(generation===sequence)setMe(null);});};const storage=(e:StorageEvent)=>{if(e.key===null||e.key===DEVICE_PREFIX+'authVersion')check();};const visible=()=>{if(document.visibilityState==='visible')check();};check();window.addEventListener('storage',storage);window.addEventListener('focus',check);window.addEventListener('kb:me-updated',check);document.addEventListener('visibilitychange',visible);return()=>{sequence++;controller?.abort();window.removeEventListener('storage',storage);window.removeEventListener('focus',check);window.removeEventListener('kb:me-updated',check);document.removeEventListener('visibilitychange',visible);};},[]);
 return <main className="min-h-screen bg-background text-foreground"><header className="flex items-center justify-between border-b p-4"><Link className="font-semibold" to="/app">星璃笔记</Link><span className="text-sm text-muted-foreground">存到星璃</span></header><div className="mx-auto max-w-4xl p-4 sm:p-7"><h1 className="flex items-center gap-2 text-2xl font-semibold"><Scissors />网页剪藏</h1><p className="mt-2 text-sm text-muted-foreground">正文、来源与选中的图片，保存成可以继续整理的 Markdown。</p>{me===undefined?<p className="mt-6">正在检查登录状态…</p>:!me?<section className="mt-6 space-y-3 rounded-xl border p-5"><h2 className="font-medium">先登录，再确认保存位置</h2><p className="text-sm">收到的内容仅暂存在当前标签页，尚未写入任何账号。登录会回到这里；关闭此标签页会丢失临时剪藏。</p><Link className="underline" to={`/login?next=${encodeURIComponent('/capture'+location.search+location.hash)}`}>登录并继续剪藏</Link></section>:<ClipComposer key={me.id} user={me} />}</div></main>;
}
function ClipComposer({user}:{user:Me}){
 const confirm=useConfirm();
 const location=useLocation(),[rows,setRows]=useState(()=>drafts(user.id)),[row,setRow]=useState<ClipDraft>(()=>drafts(user.id)[0]??emptyClip()),[spaces,setSpaces]=useState<{id:string;name:string}[]>([]),[books,setBooks]=useState<Target[]>([]),[folders,setFolders]=useState<Target[]>([]),[preview,setPreview]=useState<Preview|null>(null),[error,setError]=useState(''),[storageError,setStorageError]=useState(false),[loading,setLoading]=useState(false),[tick,setTick]=useState(0);
 const mounted=useRef(true),current=useRef(row),previewController=useRef<AbortController|null>(null);current.current=row;
 const busy=clipPending(user.id,row.id),frozen=busy||!!row.attempt||!!row.saved;
 const persist=(value:ClipDraft)=>{let success=false;try{success=writeClipDraft(store(),user.id,value);}catch{}if(mounted.current){setStorageError(!success);setRows(drafts(user.id));}return success;};
 const change=(value:ClipDraft)=>{current.current=value;setRow(value);persist(value);};
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;previewController.current?.abort();};},[]);
 useEffect(()=>subscribeClips(()=>{if(!mounted.current)return;setTick(n=>n+1);const next=drafts(user.id);setRows(next);const match=next.find(d=>d.id===current.current.id);if(match?.attempt||match?.saved)setRow(match);}),[user.id]);
 useEffect(()=>{const controller=new AbortController();api<{workspaces:{id:string;name:string}[]}>('/api/v1/workspaces',{signal:controller.signal}).then(x=>setSpaces(x.workspaces)).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[]);
 useEffect(()=>{
  const controller=new AbortController();setBooks([]);if(row.workspaceId)api<{notebooks:Target[]}>(`/api/v1/workspaces/${row.workspaceId}/clip-targets`,{signal:controller.signal}).then(x=>setBooks(x.notebooks)).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();
 },[row.workspaceId]);
 useEffect(()=>{const controller=new AbortController();setFolders([]);if(row.notebookId)api<{folders:Target[]}>(`/api/v1/notebooks/${row.notebookId}/clip-folders`,{signal:controller.signal}).then(x=>setFolders(x.folders)).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[row.notebookId]);
 useEffect(()=>{
  const incoming=/^#clip=([a-f0-9]{32})$/.exec(location.hash)?.[1];
  if(incoming)try{
   const key='kb.clip.incoming:'+incoming,raw=store().getItem(key);if(!raw)return;
   if(drafts(user.id).length>=5){setError('已有 5 条临时剪藏，请先保存或丢弃一条，再刷新接收新内容');return;}
   const packet=JSON.parse(raw) as ClipInput,next={...emptyClip(),input:{...packet,mode:'article' as const}};
   change(next);if(persist(next)){store().removeItem(key);history.replaceState(history.state,'','/capture');}else setError('临时存储不足，收到的正文仍在此页；请先导出或保存，勿关闭页面');setPreview(null);
  }catch{setError('无法接收剪藏，请重新操作或手动粘贴来源链接');}
  else if(location.search){const params=new URLSearchParams(location.search);const text=params.get('text')??'',url=params.get('url')||text.match(/https?:\/\/\S+/)?.[0];if(url&&drafts(user.id).length<5){change({...emptyClip(),input:{url,title:params.get('title')??'',mode:'link',selection:false}});history.replaceState(history.state,'','/capture');}}
 // 每个传入片段只接收一次；编辑状态不触发重放。
 },[location.hash,location.search,user.id]);
 useEffect(()=>{if(!busy&&!storageError)return;const before=(e:BeforeUnloadEvent)=>e.preventDefault();window.addEventListener('beforeunload',before);return()=>window.removeEventListener('beforeunload',before);},[busy,storageError]);
 const editInput=(patch:Partial<ClipInput>)=>{previewController.current?.abort();setPreview(null);setLoading(false);change({...row,input:{...row.input,...patch}});};
 async function inspect(){previewController.current?.abort();const controller=new AbortController();previewController.current=controller;const id=row.id;setLoading(true);setError('');try{const data=await api<Preview>('/api/v1/clips/preview',{method:'POST',body:JSON.stringify({...row.input,expectedUserId:user.id}),signal:controller.signal});if(!mounted.current||current.current.id!==id||controller.signal.aborted)return;setPreview(data);if(!row.input.title)change({...current.current,input:{...current.current.input,title:data.title}});}catch(e){if(!controller.signal.aborted&&mounted.current)setError((e as Error).message);}finally{if(mounted.current&&!controller.signal.aborted)setLoading(false);}}
 async function save(){
  const snapshot=current.current;if(!snapshot.input.url||!beginClip(user.id,snapshot.id))return;persist(snapshot);setError('');
  try{
   let attempt=snapshot.attempt;
   if(!attempt){let notebookId=snapshot.notebookId;if(!notebookId){if(snapshot.workspaceId)throw Error('请选择该工作区的笔记本');const inbox=await api<{id:string}>('/api/v1/me/clip-inbox',{method:'POST',body:JSON.stringify({expectedUserId:user.id})});notebookId=inbox.id;}
    attempt={notebookId,input:{...snapshot.input},folderId:snapshot.folderId||null,selectedImages:[...snapshot.selectedImages]};persist({...snapshot,attempt});if(mounted.current&&current.current.id===snapshot.id)setRow({...snapshot,attempt});
   }
   const saved=await api<{id:string;workspaceId:string;warnings:string[]}>(`/api/v1/notebooks/${attempt.notebookId}/clips`,{method:'POST',body:JSON.stringify({...attempt.input,expectedUserId:user.id,captureId:snapshot.id,folderId:attempt.folderId,selectedImages:attempt.selectedImages})});
   const done={...snapshot,attempt,saved};persist(done);if(mounted.current&&current.current.id===snapshot.id){setRow(done);setPreview(null);}
  }catch(e){if(['FORBIDDEN','UNAUTHENTICATED'].includes((e as {code?:string}).code??''))window.dispatchEvent(new Event('kb:me-updated'));if(mounted.current&&current.current.id===snapshot.id)setError(`${(e as Error).message}。草稿已保留；重试使用同一份内容，不会重复创建。`);}
  finally{endClip(user.id,snapshot.id);}
 }
 function createNew(copy=false){if(rows.length>=5){setError('最多保留 5 条临时剪藏，请先移除已保存项或导出后丢弃');return;}const next=copy?{...emptyClip(),input:{...row.input},workspaceId:row.workspaceId,notebookId:row.notebookId,folderId:row.folderId,selectedImages:[...row.selectedImages]}:emptyClip();change(next);setPreview(null);setError('');}
 async function discard(){const id=row.id;if(busy||!await confirm({title:row.saved?'移除临时副本？':'丢弃临时剪藏？',description:row.saved?'服务器笔记不会删除。':'尚未保存的内容将从当前标签页移除，建议先导出。',destructive:true}))return;removeClipDraft(store(),user.id,id);if(!mounted.current)return;const next=drafts(user.id);setRows(next);if(current.current.id===id){setRow(next[0]??emptyClip());setPreview(null);}}
 return <div className="mt-6 space-y-4" data-pending={tick}>
  <div className="rounded-xl border border-border bg-muted/30 p-4 text-sm"><p className="flex items-start gap-2"><ShieldCheck className="size-4 shrink-0"/>仅临时保存在当前标签页、当前账号下，明文且不跨设备同步。点击保存后进入服务器笔记本，并标记「待整理」；不会自动公开。未登录时保留传入片段，关闭标签页前请保存或导出。</p></div>
  {storageError&&<p role="alert" className="rounded-lg border border-destructive p-3 text-sm">浏览器临时存储不可用，当前内容仅在内存。请保持此页打开并保存或导出。</p>}
  {rows.length>0&&<div className="flex flex-wrap gap-2" aria-label="临时剪藏队列">{rows.map(d=><button key={d.id} className={`max-w-full truncate rounded-lg border px-3 py-2 text-sm ${d.id===row.id?'bg-muted font-semibold':''}`} onClick={()=>{previewController.current?.abort();setLoading(false);setRow(d);setPreview(null);setError('');}}>{d.saved?'已保存 · ':clipPending(user.id,d.id)?'保存中 · ':''}{d.input.title||d.input.url||'新剪藏'}</button>)}</div>}
  <section className="space-y-4 rounded-xl border p-4 sm:p-5">
   <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">1. 来源内容</h2><Button variant="outline" size="sm" onClick={()=>createNew()}>新建剪藏</Button></div>
   <label className="block space-y-1 text-sm"><span>来源链接</span><Input aria-label="来源链接" type="url" value={row.input.url} disabled={frozen} onChange={e=>editInput({url:e.target.value,html:undefined,selection:false})} placeholder="粘贴网页或微信公众号文章 URL" /></label>
   <label className="block space-y-1 text-sm"><span>标题（可选）</span><Input aria-label="剪藏标题" value={row.input.title} disabled={frozen} maxLength={160} onChange={e=>editInput({title:e.target.value})}/></label>
   {row.input.html&&<p className="text-xs text-muted-foreground">已收到浏览器{row.input.selection?'选中片段':'正文'}，无需服务器重新访问来源页面。</p>}
   <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={row.input.mode==='link'} disabled={frozen} onChange={e=>editInput({mode:e.target.checked?'link':'article'})}/>只存链接（来源需登录、验证或不可读取时）</label>
   <Button variant="outline" disabled={frozen||loading||!row.input.url} onClick={()=>void inspect()}>{loading?<LoaderCircle className="animate-spin"/>:<Clipboard/>}提取并预览</Button>
  </section>
  <section className="space-y-4 rounded-xl border p-4 sm:p-5"><h2 className="font-semibold">2. 保存位置</h2><div className="grid gap-3 sm:grid-cols-3">
   <label className="space-y-1 text-sm">工作区<select aria-label="剪藏工作区" className={field} value={row.workspaceId} disabled={frozen} onChange={e=>change({...row,workspaceId:e.target.value,notebookId:'',folderId:''})}><option value="">个人收件箱（私密）</option>{spaces.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
   <label className="space-y-1 text-sm">笔记本<select aria-label="剪藏笔记本" className={field} value={row.notebookId} disabled={frozen||!row.workspaceId} onChange={e=>change({...row,notebookId:e.target.value,folderId:''})}><option value="">{row.workspaceId?'请选择可写笔记本':'收件箱'}</option>{books.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
   <label className="space-y-1 text-sm">目录<select aria-label="剪藏目录" className={field} value={row.folderId} disabled={frozen||!row.notebookId} onChange={e=>change({...row,folderId:e.target.value})}><option value="">根目录</option>{folders.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
  </div><p className="text-xs text-muted-foreground">只列出你可写的笔记本；正文和附件共同计入配额。AI 索引遵循目标笔记本默认设置，新建个人收件箱默认关闭。</p></section>
  {preview&&<section className="space-y-3 rounded-xl border p-4 sm:p-5"><h2 className="font-semibold">正文预览</h2><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-sm" data-testid="clip-preview">{preview.bodyMd}</pre>{preview.images.length>0&&<fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">选择要保存的图片（最多 10 张；不自动加载外部图片）</legend>{preview.images.map(image=><label key={image.url} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" disabled={frozen} checked={row.selectedImages.includes(image.url)} onChange={e=>change({...row,selectedImages:e.target.checked?[...row.selectedImages,image.url]:row.selectedImages.filter(x=>x!==image.url)})}/><span className="min-w-0 break-all">{image.alt}<span className="block text-xs text-muted-foreground">{image.url}</span></span></label>)}</fieldset>}{preview.warnings.map(w=><p key={w} className="text-xs text-muted-foreground">{w}</p>)}</section>}
  {error&&<p role="alert" className="rounded-lg border border-destructive p-3 text-sm">{error}</p>}
  {row.saved?<section className="rounded-xl border border-primary/40 p-5" role="status"><h2 className="font-semibold">已存到星璃</h2><Link className="mt-2 inline-block underline" to={`/w/${row.saved.workspaceId}/n/${row.saved.id}`}>打开已保存笔记</Link>{row.saved.warnings.map(w=><p key={w} className="mt-2 break-words text-sm text-muted-foreground">{w}</p>)}</section>:row.attempt&&!busy&&<p className="text-sm text-muted-foreground">这份内容已冻结用于安全重试。若需要修改，请新建副本；旧请求可能已经成功，请先重试确认，避免重复整理。</p>}
  <div className="flex flex-wrap gap-2"><Button disabled={busy||!!row.saved||!row.input.url||!!row.workspaceId&&!row.notebookId} onClick={()=>void save()}>{busy?<LoaderCircle className="animate-spin"/>:<BookmarkPlus/>}{busy?'正在保存…':row.attempt?'重试同一份剪藏':'确认保存到星璃'}</Button><Button variant="outline" onClick={()=>exportDraft(row)}><Download/>导出草稿</Button>{row.attempt&&!busy&&!row.saved&&<Button variant="outline" onClick={()=>createNew(true)}>新建可编辑副本</Button>}<Button variant="ghost" disabled={busy} onClick={()=>void discard()}><X/>{row.saved?'移除临时副本':'丢弃'}</Button></div>
  <details className="rounded-xl border p-4 text-sm"><summary className="cursor-pointer font-medium">浏览器扩展与剪藏书签</summary><p className="mt-3 text-muted-foreground">Chrome / Edge 扩展构建包可按说明加载。仅在你点按钮时读取当前标签页，不需要常驻网站权限。</p><p className="mt-3"><a className="underline" href="/xingli-clipper.zip" download>下载 Chrome / Edge 扩展包（含安装说明）</a></p><p className="mt-3">无扩展时，将下面链接拖到书签栏。在来源网页点击，先选择文章片段可只剪选中部分。来源页面的安全策略可能阻止书签，此时可用扩展或粘贴 URL。</p><a className="mt-3 inline-flex items-center gap-2 rounded-lg border p-2 underline" ref={el=>{el?.setAttribute("href",clipBookmarklet(window.location.origin));}} onClick={e=>e.preventDefault()}><Link2 className="size-4"/>存到星璃</a><p className="mt-3 text-xs text-muted-foreground">手机可在此页粘贴微信文章 URL。PWA 系统分享支持依浏览器而异；读取失败时可只存链接。不会绕过来源登录、验证码或付费限制。</p></details>
 </div>;
}
