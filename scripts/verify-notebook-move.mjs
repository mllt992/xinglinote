// 笔记本跨工作区搬迁的验收：内容、附件、搜索归属、双链、权限、slug 撞车。
// 用两个**新建**的工作区，各自的第一本都叫 inbox，正好把 (workspace_id, slug) 撞车这条也覆盖到。
import { KB_EMAIL, KB_PASSWORD, TEST_PASSWORD } from './creds.mjs';
const base=(process.env.KB_BASE_URL??'http://127.0.0.1:12098')+'/api/v1';
async function request(path,options={},cookie=""){const r=await fetch(base+path,{...options,headers:{"content-type":"application/json",...(cookie?{cookie}:{}),...(options.headers||{})}});const set=r.headers.get("set-cookie");const json=await r.json();if(!r.ok||!json.ok){const e=new Error(json.error?.message||`HTTP ${r.status}`);e.status=r.status;throw e;}return{data:json.data,cookie:set?.split(";")[0]||cookie};}
async function upload(path,cookie,name,mime,bytes){const form=new FormData();form.append("file",new Blob([bytes],{type:mime}),name);const r=await fetch(base+path,{method:"POST",headers:{cookie},body:form});const json=await r.json();if(!r.ok||!json.ok)throw new Error(json.error?.message||`HTTP ${r.status}`);return json.data;}
const suffix=crypto.randomUUID().replaceAll("-","").slice(0,8);

const admin=(await request("/auth/login",{method:"POST",body:JSON.stringify({email:KB_EMAIL,password:KB_PASSWORD})})).cookie;
const src=(await request("/workspaces",{method:"POST",body:JSON.stringify({name:`搬迁验收源-${suffix}`})},admin)).data;
const dst=(await request("/workspaces",{method:"POST",body:JSON.stringify({name:`搬迁验收目标-${suffix}`})},admin)).data;

// 待搬的这本：一个目录、一篇带正文的笔记、一个附件。
const folder=(await request("/folders",{method:"POST",body:JSON.stringify({notebookId:src.notebook.id,title:"资料"})},admin)).data;
const note=(await request("/notes",{method:"POST",body:JSON.stringify({notebookId:src.notebook.id,folderId:folder.id,title:`搬家的笔记${suffix}`})},admin)).data;
await request(`/notes/${note.id}`,{method:"PATCH",body:JSON.stringify({expectedVersion:note.version,bodyMd:"正文在这里，搬完还得读得出来。"})},admin);
// 1x1 PNG，够过魔数复核。
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64");
const att=await upload(`/notes/${note.id}/attachments`,admin,"pixel.png","image/png",png);

// 留在原区、指向被搬走那篇的双链——搬完必须断掉，不然反向链接会跨区漏标题。
const keep=(await request(`/workspaces/${src.workspace.id}/notebooks`,{method:"POST",body:JSON.stringify({title:"留守本"})},admin)).data;
const guide=(await request("/notes",{method:"POST",body:JSON.stringify({notebookId:keep.id,title:"指路人"})},admin)).data;
await request(`/notes/${guide.id}`,{method:"PATCH",body:JSON.stringify({expectedVersion:guide.version,bodyMd:`见 [[搬家的笔记${suffix}]]`})},admin);
const backlinksBefore=(await request(`/notes/${note.id}/backlinks`,{},admin)).data.items.length;

// 非管理员搬不动：拿一个绑在源区、角色 editor 的新账号试。
const code=(await request("/admin/registration-codes",{method:"POST",body:JSON.stringify({quantity:1,maxUses:1,skipEmailVerification:true,bindWorkspaceId:src.workspace.id,bindRole:"editor"})},admin)).data.codes[0];
const member=(await request("/auth/register",{method:"POST",body:JSON.stringify({email:`move-${suffix}@example.test`,password:TEST_PASSWORD,handle:`move${suffix}`,displayName:"搬迁验收成员",registrationCode:code})})).cookie;
let editorBlocked=false;
try{await request(`/notebooks/${src.notebook.id}/move`,{method:"POST",body:JSON.stringify({workspaceId:dst.workspace.id})},member)}catch(e){editorBlocked=e.status===403;}

const moved=(await request(`/notebooks/${src.notebook.id}/move`,{method:"POST",body:JSON.stringify({workspaceId:dst.workspace.id})},admin)).data;

const srcList=(await request(`/workspaces/${src.workspace.id}/notebooks`,{},admin)).data.notebooks;
const dstList=(await request(`/workspaces/${dst.workspace.id}/notebooks`,{},admin)).data.notebooks;
const tree=(await request(`/notebooks/${src.notebook.id}/tree`,{},admin)).data;
const reread=(await request(`/notes/${note.id}`,{},admin)).data;
const fileRes=await fetch(`${base}/attachments/${att.id}`,{headers:{cookie:admin}});
const fileBytes=Buffer.from(await fileRes.arrayBuffer());
const inDst=(await request(`/search?q=搬家的笔记${suffix}&workspaceId=${dst.workspace.id}`,{},admin)).data.hits;
const inSrc=(await request(`/search?q=搬家的笔记${suffix}&workspaceId=${src.workspace.id}`,{},admin)).data.hits;
const backlinksAfter=(await request(`/notes/${note.id}/backlinks`,{},admin)).data.items.length;
let sameWorkspaceRejected=false;
try{await request(`/notebooks/${src.notebook.id}/move`,{method:"POST",body:JSON.stringify({workspaceId:dst.workspace.id})},admin)}catch(e){sameWorkspaceRejected=e.status===422;}

const result={
  editorBlocked,
  slugChanged:moved.moved.slugChanged,                      // 两边的第一本都叫 inbox，必然要换
  movedNoteCount:moved.moved.notes===1,
  goneFromSource:!srcList.some(x=>x.id===src.notebook.id),
  landedInTarget:dstList.some(x=>x.id===src.notebook.id),
  treeIntact:tree.folders.length===1&&tree.notes.length===1,
  bodyIntact:reread.bodyMd.includes("搬完还得读得出来"),
  workspaceRewritten:reread.workspaceId===dst.workspace.id,
  attachmentReadable:fileRes.ok&&fileBytes.equals(png),
  searchFollows:inDst.some(h=>h.id===note.id)&&!inSrc.some(h=>h.id===note.id),
  backlinkDroppedAcrossWorkspaces:backlinksBefore===1&&backlinksAfter===0,
  sameWorkspaceRejected,
};
console.log(JSON.stringify(result,null,2));
if(!Object.values(result).every(Boolean))process.exitCode=1;
