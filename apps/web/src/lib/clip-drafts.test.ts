import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginClip,clipPending,endClip,emptyClip,readClipDrafts,removeClipDraft,writeClipDraft } from './clip-drafts.ts';
class Store{map=new Map<string,string>();get length(){return this.map.size;}key(i:number){return [...this.map.keys()][i]??null;}getItem(k:string){return this.map.get(k)??null;}setItem(k:string,v:string){this.map.set(k,v);}removeItem(k:string){this.map.delete(k);}}
test('剪藏请求跨组件只提交一次，晚返回不移除另一条草稿或另一个账号',()=>{
 const storage=new Store(),a=emptyClip(),b=emptyClip();writeClipDraft(storage,'a',a);writeClipDraft(storage,'a',b);writeClipDraft(storage,'b',a);
 assert.ok(beginClip('a',a.id));assert.equal(beginClip('a',a.id),false);assert.ok(clipPending('a',a.id));assert.equal(removeClipDraft(storage,'a',a.id),false);endClip('a',a.id);removeClipDraft(storage,'a',a.id);
 assert.deepEqual(readClipDrafts(storage,'a').map(x=>x.id),[b.id]);assert.equal(readClipDrafts(storage,'b').length,1);
});
test('临时存储失败仍保留内存草稿与冻结重试快照',()=>{
 const storage=new Store(),a=emptyClip();a.input.url='https://example.com';a.attempt={notebookId:'n',input:{...a.input},folderId:null,selectedImages:[]};storage.setItem=()=>{throw Error('quota');};assert.equal(writeClipDraft(storage,'quota',a),false);assert.equal(readClipDrafts(storage,'quota')[0]?.attempt?.input.url,a.input.url);
});
test('五条上限不继续累积持久草稿；已存在项仍可保存',()=>{
 const storage=new Store(),user='bounded';const rows=Array.from({length:5},emptyClip);for(const row of rows)assert.equal(writeClipDraft(storage,user,row),true);assert.equal(writeClipDraft(storage,user,emptyClip()),false);assert.equal(readClipDrafts(storage,user).length,5);assert.equal(writeClipDraft(storage,user,{...rows[0]!,input:{...rows[0]!.input,title:'继续整理'}}),true);
});
