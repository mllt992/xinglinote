import{useState}from'react';import{FileDown,FolderTree,Upload}from'lucide-react';import{api}from'../api';import{Button}from'./ui/button';import{Badge}from'./ui/badge';import{Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle}from'./ui/dialog';import{useToast}from'./ui/toast';import{FormError}from'./ui/form-error';import{readMarkdownZip}from'../lib/zip';

type Mode="skip"|"rename"|"overwrite";
type PlanItem={sourcePath:string;folder:string;title:string;originalTitle:string;action:"create"|"rename"|"overwrite"|"skip"};
type Plan={newFolders:string[];items:PlanItem[];summary:Record<Mode|"create",number>};
const MODES:Array<{v:Mode;title:string;desc:string}>=[
  {v:"rename",title:"改名保留",desc:"撞名的另存为「标题 2」，两份都在。"},
  {v:"skip",title:"跳过",desc:"撞名的不导入，保留库里现有的。"},
  {v:"overwrite",title:"覆盖",desc:"用导入的正文覆盖同名笔记，旧内容进版本历史。"},
];
const actionLabel:Record<PlanItem["action"],string>={create:"新建",rename:"改名",overwrite:"覆盖",skip:"跳过"};

/** 导入向导：先算一份计划给人看，确认后才写库（规格 06 的 3.2）。 */
export function ImportDialog({notebookId,notebookTitle,open,onOpenChange,onDone}:{notebookId?:string;notebookTitle?:string;open:boolean;onOpenChange:(v:boolean)=>void;onDone:()=>void}){
  const toast=useToast();
  const[files,setFiles]=useState<Array<{path:string;content:string}>>([]);
  const[mode,setMode]=useState<Mode>("rename");const[createFolders,setCreateFolders]=useState(true);
  const[plan,setPlan]=useState<Plan|null>(null);const[busy,setBusy]=useState(false);const[err,setErr]=useState("");

  function reset(){setFiles([]);setPlan(null);setErr("");}
  async function pick(list:FileList){
    setBusy(true);setErr("");
    try{
      const payload:Array<{path:string;content:string}>=[];
      for(const file of Array.from(list))payload.push(...(/\.zip$/i.test(file.name)?await readMarkdownZip(file):[{path:file.name,content:await file.text()}]));
      if(!payload.length)throw new Error("没找到 .md 文件");
      if(payload.length>500)throw new Error(`一次最多 500 篇，这次有 ${payload.length} 篇`);
      setFiles(payload);await preview(payload,mode,createFolders);
    }catch(e){setErr((e as Error).message)}finally{setBusy(false)}
  }
  async function preview(payload=files,m=mode,folders=createFolders){
    if(!notebookId||!payload.length)return;
    setBusy(true);setErr("");
    try{setPlan(await api<Plan>(`/api/v1/notebooks/${notebookId}/import-preview`,{method:"POST",body:JSON.stringify({files:payload,mode:m,createFolders:folders})}));}
    catch(e){setErr((e as Error).message)}finally{setBusy(false)}
  }
  async function run(){
    if(!notebookId||!files.length)return;
    setBusy(true);setErr("");
    try{
      const d=await api<{created:unknown[];overwritten:unknown[];skipped:unknown[];foldersCreated:string[]}>(`/api/v1/notebooks/${notebookId}/import-markdown`,{method:"POST",body:JSON.stringify({files,mode,createFolders})});
      const parts=[`新建 ${d.created.length} 篇`];
      if(d.overwritten.length)parts.push(`覆盖 ${d.overwritten.length} 篇`);
      if(d.skipped.length)parts.push(`跳过 ${d.skipped.length} 篇`);
      if(d.foldersCreated.length)parts.push(`建了 ${d.foldersCreated.length} 个目录`);
      toast.success("导入完成",parts.join("，"));
      reset();onOpenChange(false);onDone();
    }catch(e){setErr((e as Error).message)}finally{setBusy(false)}
  }

  return <Dialog open={open} onOpenChange={v=>{if(!v)reset();onOpenChange(v)}}><DialogContent className="max-h-[86vh] max-w-2xl overflow-auto">
    <DialogHeader><DialogTitle className="flex items-center gap-2"><Upload className="size-5"/>导入到《{notebookTitle??"笔记本"}》</DialogTitle>
      <DialogDescription>选 .md 或整包 .zip。会先算一份计划给你看，确认后才写进库。</DialogDescription></DialogHeader>

    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={busy} onClick={()=>document.getElementById("import-wizard-input")?.click()}><FileDown/>选择文件</Button>
        <input id="import-wizard-input" type="file" multiple accept=".md,.markdown,.zip,text/markdown,application/zip" className="hidden" onChange={e=>{const list=e.target.files;e.target.value="";if(list?.length)void pick(list)}}/>
        {files.length>0&&<span className="text-sm text-muted-foreground">已选 {files.length} 篇</span>}
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs"><input type="checkbox" className="size-3.5 accent-current" checked={createFolders} onChange={e=>{setCreateFolders(e.target.checked);void preview(files,mode,e.target.checked)}}/><FolderTree className="size-3.5"/>按 zip 里的目录建文件夹</label>
      </div>

      <div><p className="mb-1.5 text-xs font-medium text-muted-foreground">同名笔记怎么处理</p>
        <div className="grid gap-2 md:grid-cols-3">{MODES.map(o=><button key={o.v} type="button" onClick={()=>{setMode(o.v);void preview(files,o.v,createFolders)}} className={`rounded-lg border p-3 text-left transition ${mode===o.v?"border-foreground bg-muted":"hover:bg-muted/50"}`}><span className="text-sm font-medium">{o.title}</span><span className="mt-1 block text-xs text-muted-foreground">{o.desc}</span></button>)}</div></div>

      <FormError>{err}</FormError>

      {plan&&<div className="rounded-xl border">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3 text-sm">
          <b>计划</b>
          <Badge>新建 {plan.summary.create}</Badge>
          {plan.summary.rename>0&&<Badge>改名 {plan.summary.rename}</Badge>}
          {plan.summary.overwrite>0&&<Badge>覆盖 {plan.summary.overwrite}</Badge>}
          {plan.summary.skip>0&&<Badge>跳过 {plan.summary.skip}</Badge>}
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
