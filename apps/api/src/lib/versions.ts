import { desc,eq,inArray,sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { noteVersions } from "../db/schema.ts";
import { mergeableNoteVersion } from "./note-version-merge.ts";

type VersionDb = Pick<typeof db, "select" | "insert" | "update">;

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
      if(v.name?.trim())return;                                 // 用户钉住的快照不裁
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

/**
 * 写入一条历史，或按 03 §2.4 合并进 5 分钟内同一 source 的上一版。
 * `matchEditor: false` 给协同房间：一处落库、不限最后动手的人。
 */
export async function recordNoteVersion(tx: VersionDb, opts: {
  noteId: string;
  version: number;
  previousVersion: number;
  title: string;
  bodyMd: string;
  editorId: string;
  source: string;
  matchEditor?: boolean;
  /** 强制覆盖别人那一版时不要合并，否则刚推进历史的对方快照会被改成覆盖后的正文。 */
  merge?: boolean;
}) {
  const recent = opts.merge === false ? [] : await tx.select({
    id: noteVersions.id,
    version: noteVersions.version,
    source: noteVersions.source,
    editorId: noteVersions.editorId,
    createdAt: noteVersions.createdAt,
    name: noteVersions.name,
  }).from(noteVersions).where(eq(noteVersions.noteId, opts.noteId)).orderBy(desc(noteVersions.version)).limit(5);
  const merge = mergeableNoteVersion(recent, {
    currentVersion: opts.previousVersion,
    source: opts.source,
    editorId: opts.matchEditor === false ? undefined : opts.editorId,
  });
  if (merge) {
    await tx.update(noteVersions).set({
      version: opts.version,
      title: opts.title,
      bodyMd: opts.bodyMd,
      editorId: opts.editorId,
      createdAt: new Date(),
    }).where(eq(noteVersions.id, merge));
    return;
  }
  await tx.insert(noteVersions).values({
    noteId: opts.noteId,
    version: opts.version,
    title: opts.title,
    bodyMd: opts.bodyMd,
    editorId: opts.editorId,
    source: opts.source,
  });
}
