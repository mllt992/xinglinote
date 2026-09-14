import { and,eq,isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.ts";
import { folders,notebooks,notes } from "../db/schema.ts";
import { importFolderPath,norm,parseFront,resolveTargetFolderSegs } from "./import-plan-path.ts";

export { importFolderPath,norm,parseFront,resolveTargetFolderSegs } from "./import-plan-path.ts";

export const importInput=z.object({
  files:z.array(z.object({path:z.string().max(500),content:z.string().max(2000000)})).min(1).max(500),
  mode:z.enum(["skip","rename","overwrite"]).default("rename"),
  createFolders:z.boolean().default(true),
  /** 挂到已有文件夹下；null/省略 = 笔记本根。相对路径（zip 目录）再叠在它下面。 */
  targetFolderId:z.string().uuid().nullable().optional(),
});
export type ImportInput=z.infer<typeof importInput>;

export type PlanItem={sourcePath:string;folderPath:string[];folderKey:string;title:string;originalTitle:string;action:"create"|"rename"|"overwrite"|"skip";body:string};

/** 先把整批算成一份计划：要建哪些目录、哪些新建、哪些撞名、撞名按 mode 怎么处置。 */
export async function planImport(nb:typeof notebooks.$inferSelect,input:ImportInput){
  const liveFolders=await db.select().from(folders).where(and(eq(folders.notebookId,nb.id),isNull(folders.trashedAt)));
  const liveNotes=await db.select().from(notes).where(and(eq(notes.notebookId,nb.id),isNull(notes.trashedAt)));
  const targetSegs=resolveTargetFolderSegs(
    liveFolders.map(f=>({id:f.id,title:f.title,parentId:f.parentId??null})),
    input.targetFolderId,
  );
  const folderKey=(segs:string[])=>segs.map(norm).join("/");
  const existingKey=new Map<string,string>();                        // 目录路径 -> 已有 folder id
  for(const f of liveFolders){
    const segs:string[]=[];let cur:typeof f|undefined=f;const seen=new Set<string>();
    while(cur&&!seen.has(cur.id)){seen.add(cur.id);segs.unshift(cur.title);cur=cur.parentId?liveFolders.find(x=>x.id===cur!.parentId):undefined;}
    existingKey.set(folderKey(segs),f.id);
  }
  const newFolders:Array<{path:string[];parentKey:string|null;key:string}>=[];
  const takenTitles=new Map<string,Set<string>>();                   // 目录 key -> 该目录下已占用的标题
  const takeSet=(key:string)=>{
    if(!takenTitles.has(key)){
      const id=existingKey.get(key)??null;
      takenTitles.set(key,new Set(liveNotes.filter(n=>(n.folderId??null)===id).map(n=>norm(n.title))));
    }
    return takenTitles.get(key)!;
  };
  const items:PlanItem[]=[];
  for(const file of input.files){
    const parts=file.path.split(/[\\/]/).filter(p=>p&&p!=="."&&p!=="..");
    const name=parts.pop()??"未命名";
    const dirs=importFolderPath(file.path,targetSegs,input.createFolders);
    const front=parseFront(file.content);
    const title=(front.title??name.replace(/\.(md|markdown)$/i,"")).trim()||"未命名";
    let key="";
    for(let d=0;d<dirs.length;d++){
      const segs=dirs.slice(0,d+1),k=folderKey(segs);
      if(!existingKey.has(k)&&!newFolders.some(x=>x.key===k))newFolders.push({path:segs,parentKey:d?folderKey(dirs.slice(0,d)):null,key:k});
      key=k;
    }
    const taken=takeSet(key);
    let finalTitle=title;
    let action:PlanItem["action"]="create";
    if(taken.has(norm(title))){
      if(input.mode==="skip")action="skip";
      else if(input.mode==="overwrite")action="overwrite";
      else{action="rename";for(let i=2;taken.has(norm(finalTitle));i++)finalTitle=title+" "+i;}
    }
    if(action==="create"||action==="rename")taken.add(norm(finalTitle));
    items.push({sourcePath:file.path,folderPath:dirs,folderKey:key,title:finalTitle,originalTitle:title,action,body:front.body});
  }
  return{items,newFolders,existingKey,targetFolderPath:targetSegs};
}
