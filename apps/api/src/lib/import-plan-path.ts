import { fail, FOLDER_DEPTH_LIMIT } from "@kb/shared";

const MAX_FOLDER_DEPTH=FOLDER_DEPTH_LIMIT;
export const norm=(s:string)=>s.normalize("NFKC").trim().replace(/\s+/g," ").toLowerCase();

/** 单篇 md 的 frontmatter：title 用得上，外来 id 一律丢掉，正文去掉这一段。 */
export function parseFront(raw:string){
  const m=raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if(!m)return{title:null as string|null,body:raw};
  const line=m[1].split(/\r?\n/).map(l=>l.match(/^title:\s*(.+)$/)).find(Boolean);
  const title=line?.[1]?.trim().replace(/^["']|["']$/g,"")||null;
  return{title,body:raw.slice(m[0].length).replace(/^\s*\n/,"")};
}

/** 从 live 文件夹列表解析目标目录的标题路径（根→自身）。找不到则抛 VALIDATION。 */
export function resolveTargetFolderSegs(
  liveFolders:Array<{id:string;title:string;parentId:string|null}>,
  targetFolderId:string|null|undefined,
):string[]{
  if(!targetFolderId)return[];
  const byId=new Map(liveFolders.map(f=>[f.id,f]));
  if(!byId.has(targetFolderId))throw fail("VALIDATION","目标文件夹不存在或不属于当前笔记本");
  const segs:string[]=[];
  const seen=new Set<string>();
  let cur:typeof liveFolders[number]|undefined=byId.get(targetFolderId);
  while(cur&&!seen.has(cur.id)){
    seen.add(cur.id);
    segs.unshift(cur.title);
    cur=cur.parentId?byId.get(cur.parentId):undefined;
  }
  return segs;
}

/**
 * 相对路径叠在目标目录下，总深度不超过 8。
 * createFolders=false 时只落到目标目录，不按 zip 再建子目录。
 */
export function importFolderPath(
  filePath:string,
  targetSegs:string[],
  createFolders:boolean,
):string[]{
  const parts=filePath.split(/[\\/]/).filter(p=>p&&p!=="."&&p!=="..");
  parts.pop(); // 去掉文件名
  const room=Math.max(0,MAX_FOLDER_DEPTH-targetSegs.length);
  const relative=createFolders?parts.slice(0,room):[];
  return[...targetSegs,...relative];
}
