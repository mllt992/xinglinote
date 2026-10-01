import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { api } from '../api';

export type PublicBoardData={title:string;kind:string;svg:string;version:number;updatedAt:string;links:Array<{title:string;url:string}>};
export function PublicBoard({board}:{board:PublicBoardData}) {
 const [zoom,setZoom]=useState(1),[search,setSearch]=useState('');
 const host=useRef<HTMLDivElement>(null);
 const svg=useMemo(()=>DOMPurify.sanitize(board.svg,{USE_PROFILES:{svg:true},FORBID_TAGS:['a','foreignObject','style','script','metadata','filter'],FORBID_ATTR:['style','onload','onclick']}),[board.svg]);
 useEffect(()=>{host.current?.querySelectorAll('text').forEach(el=>{const hit=!!search.trim()&&el.textContent?.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());el.style.outline=hit?'3px solid #eab308':'';});},[search,svg]);
 return <section className="min-w-0 rounded-xl border bg-background p-3" aria-label="只读导图">
  <div className="flex flex-wrap items-center gap-2"><h2 className="min-w-0 flex-1 break-words font-semibold">{board.title}</h2><span className="text-xs text-muted-foreground">只读 · v{board.version}</span></div>
  <div className="my-3 flex flex-wrap gap-2"><Input aria-label="搜索图中节点" placeholder="搜索图中节点" value={search} onChange={e=>setSearch(e.target.value)} className="min-w-40 flex-1"/><Button variant="outline" aria-label="缩小导图" onClick={()=>setZoom(z=>Math.max(.25,z-.25))}>−</Button><Button variant="outline" onClick={()=>setZoom(1)}>适应</Button><Button variant="outline" aria-label="放大导图" onClick={()=>setZoom(z=>Math.min(4,z+.25))}>+</Button></div>
  <div className="max-h-[70vh] overflow-auto rounded-lg bg-muted/20" tabIndex={0} aria-label="导图画布，可滚动与缩放"><div ref={host} className="public-board-svg origin-top-left [&>svg]:h-auto [&>svg]:w-full" style={{width:`${zoom*100}%`,minWidth:zoom<1?'0':'100%'}} dangerouslySetInnerHTML={{__html:svg}} /></div>
  {!!board.links.length && <nav className="mt-3 flex flex-wrap gap-3" aria-label="已公开的关联笔记">{board.links.map(link=><a key={link.url} className="text-sm underline" href={link.url}>{link.title}</a>)}</nav>}
 </section>;
}
export function PublicSiteBoard({wsSlug,nbSlug,boardId}:{wsSlug:string;nbSlug:string;boardId:string}) {
 const [board,setBoard]=useState<PublicBoardData|null>(null),[error,setError]=useState('');
 useEffect(()=>{let live=true;setBoard(null);setError('');api<PublicBoardData>(`/api/v1/public/sites/${wsSlug}/${nbSlug}/boards/${boardId}`).then(b=>{if(live)setBoard(b);}).catch(()=>{if(live)setError('导图不可用，可能已撤销发布、删除或等待刷新公开预览');});return()=>{live=false;};},[wsSlug,nbSlug,boardId]);
 return error?<p role="status" className="p-6 text-sm text-muted-foreground">{error}</p>:board?<PublicBoard board={board}/>:<p className="p-6 text-sm">正在读取导图…</p>;
}

export function RelatedSiteBoards({wsSlug,nbSlug,noteId}:{wsSlug:string;nbSlug:string;noteId:string}) {
 const [boards,setBoards]=useState<Array<{id:string;title:string}>>([]),[opened,setOpened]=useState<string|null>(null);
 useEffect(()=>{let live=true;setBoards([]);setOpened(null);api<{boards:Array<{id:string;title:string}>}>(`/api/v1/public/sites/${wsSlug}/${nbSlug}/notes/${noteId}/boards`).then(d=>{if(live)setBoards(d.boards);}).catch(()=>{});return()=>{live=false;};},[wsSlug,nbSlug,noteId]);
 if(!boards.length)return null;return <section className="my-8 space-y-3"><h2 className="font-semibold">关联导图</h2><div className="flex flex-wrap gap-2">{boards.map(b=><Button key={b.id} variant="outline" onClick={()=>setOpened(id=>id===b.id?null:b.id)}>{b.title}</Button>)}</div>{opened&&<PublicSiteBoard wsSlug={wsSlug} nbSlug={nbSlug} boardId={opened}/>}</section>;
}
