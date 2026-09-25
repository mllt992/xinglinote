import{useEffect,useRef,useState}from'react';import{useNavigate}from'react-router-dom';import{Clock,Network,PenTool,Search,Star}from'lucide-react';import{api}from'../api';import{Input}from'./ui/input';import{Badge}from'./ui/badge';import{Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle}from'./ui/dialog';

type Brief={id:string;title:string;workspaceId:string;notebookId:string;updatedAt?:string};
type Hit=Brief&{snippet?:string;board?:"mindmap"|"drawio"};
type BoardHit={id:string;kind:"mindmap"|"drawio";title:string;workspaceId:string;notebookId:string;notebookTitle:string;snippet:string};
type Group={key:string;label:string;icon:React.ReactNode;items:Hit[]};

/** Ctrl/⌘+K 快速打开：空查询给收藏与最近，输入后走跨工作区搜索。 */
export function QuickOpen({open,onOpenChange,onPick,workspaceNames}:{open:boolean;onOpenChange:(v:boolean)=>void;onPick:(workspaceId:string,noteId:string)=>void;workspaceNames:Record<string,string>}){
  const nav=useNavigate();const[q,setQ]=useState("");const[hits,setHits]=useState<Hit[]>([]);const[boards,setBoards]=useState<Hit[]>([]);const[favorites,setFavorites]=useState<Brief[]>([]);const[recent,setRecent]=useState<Brief[]>([]);
  const[active,setActive]=useState(0);const[busy,setBusy]=useState(false);
  const timer=useRef<number|null>(null);

  useEffect(()=>{
    if(!open)return;
    setQ("");setHits([]);setBoards([]);setActive(0);
    void api<{notes:Brief[]}>("/api/v1/me/favorites").then(d=>setFavorites(d.notes)).catch(()=>setFavorites([]));
    void api<{notes:Brief[]}>("/api/v1/me/recent").then(d=>setRecent(d.notes)).catch(()=>setRecent([]));
  },[open]);

  useEffect(()=>{
    if(timer.current)clearTimeout(timer.current);
    if(!q.trim()){setHits([]);setBoards([]);return;}
    setBusy(true);
    timer.current=window.setTimeout(async()=>{
      try{const d=await api<{hits:Hit[];mindMaps?:BoardHit[]}>(`/api/v1/search?q=${encodeURIComponent(q)}&limit=20`);setHits(d.hits);setBoards((d.mindMaps??[]).map(b=>({id:b.id,title:b.title,workspaceId:b.workspaceId,notebookId:b.notebookId,snippet:b.snippet,board:b.kind})));}
      catch{setHits([]);setBoards([]);}finally{setBusy(false);setActive(0);}
    },200);
    return()=>{if(timer.current)clearTimeout(timer.current)};
  },[q]);

  const groups:Group[]=q.trim()
    ? [{key:"hits",label:busy?"搜索中…":`笔记（${hits.length}）`,icon:<Search className="size-3.5"/>,items:hits},{key:"boards",label:`思维导图与画板（${boards.length}）`,icon:<Network className="size-3.5"/>,items:boards}]
    : [{key:"fav",label:"收藏",icon:<Star className="size-3.5"/>,items:favorites},{key:"recent",label:"最近打开",icon:<Clock className="size-3.5"/>,items:recent}];
  const flat=groups.flatMap(g=>g.items);
  const choose=(item:Hit)=>{if(item.board)nav(`/w/${item.workspaceId}/mindmaps/${item.id}`);else onPick(item.workspaceId,item.id);onOpenChange(false);};

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-xl p-0">
    <DialogHeader className="sr-only"><DialogTitle>快速打开</DialogTitle><DialogDescription>搜索笔记，或从收藏与最近打开里挑一篇。</DialogDescription></DialogHeader>
    <div className="flex items-center gap-2 border-b px-4 py-3">
      <Search className="size-4 shrink-0 text-muted-foreground"/>
      <Input autoFocus value={q} onChange={e=>setQ(e.target.value)} placeholder="搜全部工作区的笔记、导图和画板…" className="h-8 border-0 px-0 shadow-none focus-visible:ring-0"
        onKeyDown={e=>{
          if(e.key==="ArrowDown"){e.preventDefault();setActive(i=>Math.min(flat.length-1,i+1));}
          else if(e.key==="ArrowUp"){e.preventDefault();setActive(i=>Math.max(0,i-1));}
          else if(e.key==="Enter"&&flat[active]){e.preventDefault();choose(flat[active]);}
        }}/>
      <Badge>Esc 关闭</Badge>
    </div>
    <div className="max-h-96 overflow-auto p-1.5">
      {flat.length===0
        ? <p className="px-3 py-10 text-center text-sm text-muted-foreground">{q.trim()?"没有匹配的笔记、导图或画板。":"还没有收藏或最近打开的笔记。"}</p>
        : groups.filter(g=>g.items.length).map(g=><div key={g.key} className="mb-1">
            <p className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{g.icon}{g.label}</p>
            {g.items.map(item=>{
              const index=flat.indexOf(item);
              return <button key={g.key+item.id} onMouseEnter={()=>setActive(index)} onClick={()=>choose(item)}
                className={`flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left text-sm ${index===active?"bg-muted":"hover:bg-muted/60"}`}>
                {item.board&&(item.board==="drawio"?<PenTool className="mt-0.5 size-4 shrink-0 text-muted-foreground"/>:<Network className="mt-0.5 size-4 shrink-0 text-muted-foreground"/>)}<span className="min-w-0 flex-1"><span className="block truncate">{item.title}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{workspaceNames[item.workspaceId]??"其他工作区"}{item.snippet?` · ${item.snippet.slice(0,60)}`:""}</span></span>
              </button>;
            })}
          </div>)}
    </div>
  </DialogContent></Dialog>;
}

/** 全局快捷键：Ctrl+K / ⌘+K。输入框里也允许触发，因为它本身就是搜索入口。 */
export function useQuickOpenHotkey(setOpen:(v:boolean)=>void){
  useEffect(()=>{
    const onKey=(e:KeyboardEvent)=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();setOpen(true);}};
    window.addEventListener("keydown",onKey);
    return()=>window.removeEventListener("keydown",onKey);
  },[setOpen]);
}
