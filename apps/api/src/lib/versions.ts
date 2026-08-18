import { desc,eq,inArray,sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { noteVersions } from "../db/schema.ts";

const KEEP_RECENT=100,DAY=86400000,KEEP_DAILY_DAYS=90;

/**
 * 规格 03 的版本保留策略：最近 100 版全留；再往前每天留一版，留到 90 天；更早的删掉。
 * 返回删掉的条数，方便审计与验收。
 */
export async function pruneNoteVersions(now=Date.now()){
  const busy=await db.select({noteId:noteVersions.noteId}).from(noteVersions).groupBy(noteVersions.noteId).having(sql`count(*) > ${KEEP_RECENT}`);
  const horizon=now-KEEP_DAILY_DAYS*DAY;
  let removed=0;
  for(const {noteId} of busy){
    const all=await db.select().from(noteVersions).where(eq(noteVersions.noteId,noteId)).orderBy(desc(noteVersions.version));
    const doomed:string[]=[];const keptDays=new Set<number>();
    all.forEach((v,i)=>{
      if(i<KEEP_RECENT)return;                                  // 最近 100 版原样留着
      const at=new Date(v.createdAt).getTime();
      if(at<horizon)return void doomed.push(v.id);              // 90 天以前的不再留
      const day=Math.floor(at/DAY);
      if(keptDays.has(day))return void doomed.push(v.id);       // 同一天只留最新那一版
      keptDays.add(day);
    });
    for(let i=0;i<doomed.length;i+=200)await db.delete(noteVersions).where(inArray(noteVersions.id,doomed.slice(i,i+200)));
    removed+=doomed.length;
  }
  return removed;
}
