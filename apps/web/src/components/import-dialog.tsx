import{useEffect,useMemo,useState}from'react';import{FileDown,Folder,FolderTree,Upload}from'lucide-react';import{flattenFolders,folderTitlePath,type TreeFolder}from'@kb/shared';import{api}from'../api';import{Button}from'./ui/button';import{Badge}from'./ui/badge';import{Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle}from'./ui/dialog';import{useToast}from'./ui/toast';import{cn}from'../lib/utils';import{readMarkdownZip}from'../lib/zip';import{takeInputFiles}from'../lib/file-input';

type Mode="skip"|"rename"|"overwrite";
type PlanItem={sourcePath:string;folder:string;title:string;originalTitle:string;action:"create"|"rename"|"overwrite"|"skip"};
type Plan={targetFolder:string|null;newFolders:string[];items:PlanItem[];summary:Record<Mode|"create",number>};
const MODES:Array<{v:Mode;title:string;desc:string}>=[
  {v:"rename",title:"改名保留",desc:"撞名的另存为「标题 2」，两份都在。"},
  {v:"skip",title:"跳过",desc:"撞名的不导入，保留库里现有的。"},
  {v:"overwrite",title:"覆盖",desc:"用导入的正文覆盖同名笔记，旧内容进版本历史。"},
];
const actionLabel:Record<PlanItem["action"],string>={create:"新建",rename:"改名",overwrite:"覆盖",skip:"跳过"};

/** 导入向导：先算一份计划给人看，确认后才写库（规格 06 的 3.2）。 */
export function ImportDialog({
  notebookId,notebookTitle,folders=[],activeFolderId=null,open,onOpenChange,onDone,
}:{
  notebookId?:string;notebookTitle?:string;folders?:TreeFolder[];activeFolderId?:string|null;
  open:boolean;onOpenChange:(v:boolean)=>void;onDone:()=>void;
}){
  const toast=useToast();
  const[files,setFiles]=useState<Array<{path:string;content:string}>>([]);
  const[mode,setMode]=useState<Mode>("rename");const[createFolders,setCreateFolders]=useState(true);
  const[targetFolderId,setTargetFolderId]=useState<string|null>(null);
  const[plan,setPlan]=useState<Plan|null>(null);const[busy,setBusy]=useState(false);
  const[progress,setProgress]=useState<string|null>(null);
  const folderRows=useMemo(()=>flattenFolders(folders,"name"),[folders]);
  const targetLabel=targetFolderId?folderTitlePath(folders,targetFolderId," / ")||"所选文件夹":"笔记本根目录";

  useEffect(()=>{
    if(!open)return;
    setTargetFolderId(activeFolderId && folders.some(f=>f.id===activeFolderId)?activeFolderId:null);
  },[open,activeFolderId,folders]);

  function reset(){setFiles([]);setPlan(null);setProgress(null);}
  function body(payload:Array<{path:string;content:string}>,m:Mode,foldersFlag:boolean,folderId:string|null){
    return JSON.stringify({files:payload,mode:m,createFolders:foldersFlag,targetFolderId:folderId});
  }
  async function pick(all:File[]){
    if(!notebookId){toast.error("没法导入","请先选中一个笔记本再导入。");return;}
    setBusy(true);setProgress("正在读取文件…");
    try{
      const payload:Array<{path:string;content:string}>=[];
      for(let i=0;i<all.length;i++){
        const file=all[i]!;
        setProgress(`读取文件 ${i+1}/${all.length}：${file.name}`);
        payload.push(...(/\.zip$/i.test(file.name)?await readMarkdownZip(file):[{path:file.name,content:await file.text()}]));
      }
      if(!payload.length)throw new Error("没找到 .md 文件");
      if(payload.length>500)throw new Error(`一次最多 500 篇，这次有 ${payload.length} 篇`);
      setFiles(payload);await preview(payload,mode,createFolders,targetFolderId);
    }catch(e){setPlan(null);toast.error("读取文件失败",(e as Error).message||"文件读不出来，请换个文件再试。")}finally{setBusy(false);setProgress(null)}
  }
  async function preview(payload=files,m=mode,foldersFlag=createFolders,folderId=targetFolderId){
    if(!notebookId||!payload.length)return;
    setBusy(true);setProgress("正在计算导入计划…");
    try{setPlan(await api<Plan>(`/api/v1/notebooks/${notebookId}/import-preview`,{method:"POST",body:body(payload,m,foldersFlag,folderId)}));}
    catch(e){setPlan(null);toast.error("导入预览失败",(e as Error).message||"服务器没有返回导入计划，请稍后再试。")}finally{setBusy(false);setProgress(null)}
  }
  function pickFolder(id:string|null){
    setTargetFolderId(id);
    if(files.length)void preview(files,mode,createFolders,id);
  }
  /** 导入可能要跑几十秒。确认之后立刻放人走，剩下的在后台跑完再用通知汇报。 */
  async function run(){
    if(!notebookId||!files.length)return;
    const payload=files;const m=mode;const foldersFlag=createFolders;const folderId=targetFolderId;
    const n=payload.length;
    reset();onOpenChange(false);
    toast.toast({title:"正在导入…",description:`共 ${n} 篇 → ${targetLabel}。完成后会通知你。`});
    try{
      const d=await api<{created:Array<{title:string}>;overwritten:Array<{title:string}>;skipped:Array<{title:string}>;foldersCreated:string[]}>(`/api/v1/notebooks/${notebookId}/import-markdown`,{method:"POST",body:body(payload,m,foldersFlag,folderId)});
      const parts=[`新建 ${d.created.length} 篇`];
      if(d.overwritten.length)parts.push(`覆盖 ${d.overwritten.length} 篇`);
      if(d.skipped.length)parts.push(`跳过 ${d.skipped.length} 篇`);
      if(d.foldersCreated.length)parts.push(`建了 ${d.foldersCreated.length} 个目录`);
      const detail:string[]=[];
      if(d.skipped.length && d.skipped.length<=5)detail.push(`跳过：${d.skipped.map(x=>x.title).join("、")}`);
      if(d.overwritten.length && d.overwritten.length<=5)detail.push(`覆盖：${d.overwritten.map(x=>x.title).join("、")}`);
      toast.success("导入完成", [parts.join("，"), ...detail].filter(Boolean).join("。"));
      onDone();
    }catch(e){toast.error("导入失败",(e as Error).message||"服务器出错，请稍后再试。")}
  }

  return <Dialog open={open} onOpenChange={v=>{if(!v)reset();onOpenChange(v)}}><DialogContent className="max-h-[86vh] max-w-2xl overflow-auto">
    <DialogHeader><DialogTitle className="flex items-center gap-2"><Upload className="size-5"/>导入到《{notebookTitle??"笔记本"}》</DialogTitle>
      <DialogDescription>选 .md 或整包 .zip。会先算一份计划给你看，确认后才写进库。默认同名改名保留。</DialogDescription></DialogHeader>

    <div className="grid gap-4">
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">放到哪个文件夹<span className="font-normal">（默认当前侧栏选中的文件夹）</span></p>
        <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border p-1.5">
          <button type="button" onClick={()=>pickFolder(null)} className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm",targetFolderId===null?"bg-muted font-medium":"hover:bg-muted/60")}>
            <Folder className="size-3.5 shrink-0"/>笔记本根目录
          </button>
          {folderRows.map(({folder,depth})=>(
            <button key={folder.id} type="button" onClick={()=>pickFolder(folder.id)} style={{paddingLeft:8+depth*14}}
              className={cn("flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left text-sm",targetFolderId===folder.id?"bg-muted font-medium":"hover:bg-muted/60")}>
              <Folder className="size-3.5 shrink-0"/><span className="truncate">{folder.title}</span>
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">当前目标：{targetLabel}。勾选下方「按 zip 目录建文件夹」时，相对路径会挂在此目录下。</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={busy} onClick={()=>document.getElementById("import-wizard-input")?.click()}><FileDown/>选择文件</Button>
        <input id="import-wizard-input" type="file" multiple accept=".md,.markdown,.zip,text/markdown,application/zip" className="hidden" onChange={e=>{const list=takeInputFiles(e.target);if(list.length)void pick(list)}}/>
        {files.length>0&&<span className="text-sm text-muted-foreground">已选 {files.length} 篇</span>}
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs"><input type="checkbox" className="size-3.5 accent-current" checked={createFolders} onChange={e=>{setCreateFolders(e.target.checked);void preview(files,mode,e.target.checked,targetFolderId)}}/><FolderTree className="size-3.5"/>按 zip 里的目录建文件夹</label>
      </div>

      <div><p className="mb-1.5 text-xs font-medium text-muted-foreground">同名笔记怎么处理</p>
        <div className="grid gap-2 md:grid-cols-3">{MODES.map(o=><button key={o.v} type="button" onClick={()=>{setMode(o.v);void preview(files,o.v,createFolders,targetFolderId)}} className={`rounded-lg border p-3 text-left transition ${mode===o.v?"border-foreground bg-muted":"hover:bg-muted/50"}`}><span className="text-sm font-medium">{o.title}</span><span className="mt-1 block text-xs text-muted-foreground">{o.desc}</span></button>)}</div></div>

      {progress&&<p className="text-xs text-muted-foreground">{progress}</p>}

      {plan&&<div className="rounded-xl border">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3 text-sm">
          <b>计划</b>
          <Badge>新建 {plan.summary.create}</Badge>
          {plan.summary.rename>0&&<Badge>改名 {plan.summary.rename}</Badge>}
          {plan.summary.overwrite>0&&<Badge>覆盖 {plan.summary.overwrite}</Badge>}
          {plan.summary.skip>0&&<Badge>跳过 {plan.summary.skip}</Badge>}
          {plan.targetFolder&&<span className="text-xs text-muted-foreground">目标：{plan.targetFolder}</span>}
          {plan.newFolders.length>0&&<span className="text-xs text-muted-foreground">将新建目录：{plan.newFolders.join("、")}</span>}
        </div>
        <div className="max-h-64 divide-y overflow-auto">{plan.items.map(item=><div key={item.sourcePath} className="flex items-center gap-3 px-4 py-2 text-sm">
          <Badge>{actionLabel[item.action]}</Badge>
          <span className="min-w-0 flex-1 truncate">{item.folder?`${item.folder} / `:""}{item.title}{item.action==="rename"&&<span className="text-muted-foreground">（原名 {item.originalTitle}）</span>}</span>
          <span className="hidden truncate text-xs text-muted-foreground sm:block">{item.sourcePath}</span>
        </div>)}</div>
      </div>}

      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={()=>{reset();onOpenChange(false)}}>取消</Button><Button disabled={busy||!plan||plan.items.every(i=>i.action==="skip")} onClick={run}>{busy?"处理中…":`确认导入${plan?` ${plan.items.filter(i=>i.action!=="skip").length} 篇`:""}`}</Button></div>
    </div>
  </DialogContent></Dialog>;
}
