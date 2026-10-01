export type ClipInput={url:string;title:string;html?:string;selection:boolean;mode:'article'|'link'};
export type ClipAttempt={notebookId:string;input:ClipInput;folderId:string|null;selectedImages:string[]};
export type ClipDraft={id:string;input:ClipInput;workspaceId:string;notebookId:string;folderId:string;selectedImages:string[];attempt?:ClipAttempt;saved?:{id:string;workspaceId:string;warnings:string[]}};
type StorageLike=Pick<Storage,'getItem'|'setItem'|'removeItem'|'key'|'length'>;
const memory=new Map<string,ClipDraft>();
const pending=new Set<string>();
const listeners=new Set<()=>void>();
const emit=()=>listeners.forEach(fn=>fn());
export const clipKey=(user:string,id:string)=>`kb.clip.draft:${user}:${id}`;
export function newClipId(){const a=new Uint8Array(16);crypto.getRandomValues(a);a[6]=(a[6]!&15)|64;a[8]=(a[8]!&63)|128;const s=Array.from(a,n=>n.toString(16).padStart(2,'0')).join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;}
export function emptyClip():ClipDraft{return{id:newClipId(),input:{url:'',title:'',selection:false,mode:'article'},workspaceId:'',notebookId:'',folderId:'',selectedImages:[]};}
export function readClipDrafts(storage:StorageLike,user:string){
 const rows=new Map<string,ClipDraft>();
 try{for(let i=0;i<storage.length;i++){const key=storage.key(i);if(!key?.startsWith(`kb.clip.draft:${user}:`))continue;try{const row=JSON.parse(storage.getItem(key)||'null') as ClipDraft;if(row&&row.id&&row.input)rows.set(row.id,row);}catch{}}}catch{}
 for(const [key,row] of memory)if(key.startsWith(`kb.clip.draft:${user}:`))rows.set(row.id,row);
 return [...rows.values()];
}
export function writeClipDraft(storage:StorageLike,user:string,row:ClipDraft){
 const key=clipKey(user,row.id);if(!readClipDrafts(storage,user).some(d=>d.id===row.id)&&readClipDrafts(storage,user).length>=5)return false;memory.set(key,row);
 try{storage.setItem(key,JSON.stringify(row));return true;}catch{return false;}
}
export function removeClipDraft(storage:StorageLike,user:string,id:string){const key=clipKey(user,id);if(pending.has(key))return false;storage.removeItem(key);memory.delete(key);emit();return true;}
export function beginClip(user:string,id:string){const key=clipKey(user,id);if(pending.has(key))return false;pending.add(key);emit();return true;}
export function endClip(user:string,id:string){pending.delete(clipKey(user,id));emit();}
export function clipPending(user:string,id:string){return pending.has(clipKey(user,id));}
export function subscribeClips(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};}
