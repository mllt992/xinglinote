import type { NoteDraft } from "./note-save";

/** 内容仅在用户明确同意「可信设备」后落盘；API 和分享页绝不进 SW 缓存。 */
export const DEVICE_PREFIX = "xingli.device.v1:";
export const SNAPSHOT_TTL = 7 * 86400000;
export type DeviceSnapshot = { kind: "note" | "today"; id: string; title: string; text: string; href: string; savedAt: number };
export type LocalNoteDraft = NoteDraft & { workspaceId: string; savedAt: number; draftBranch?: string; draftWriter?: string; draftSequence?: number };
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
const sameDraft = (a: NoteDraft, b: NoteDraft) => a.title === b.title && a.bodyMd === b.bodyMd && a.aiIndex === b.aiIndex && a.published === b.published && JSON.stringify(a.tags ?? []) === JSON.stringify(b.tags ?? []);
function parse<T>(value: string | null, fallback: T): T { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } }

type DraftCrypto = Pick<Crypto, "getRandomValues"> | null | undefined;
/** randomUUID 只在安全上下文可用；普通 HTTP/LAN 仍应正常加载应用。 */
export function newDraftId(source: DraftCrypto = globalThis.crypto): string | null {
  try { if(!source?.getRandomValues)return null;const bytes=source.getRandomValues(new Uint8Array(16));return Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join(""); } catch { return null; }
}

export class DeviceStorage {
  private drafts = new Map<string, LocalNoteDraft | null>();
  private ownDisk = new Map<string, string>();
  private source = new Map<string, string>();
  private edited = new Set<string>();
  private writer: string | null;
  private sequence = 0;
  private userId: string | null = null;
  private generation = 0;
  private observedAuthVersion: string | null;
  constructor(private storage: StorageLike | null, private cryptoSource: DraftCrypto = globalThis.crypto) { this.observedAuthVersion = this.get("authVersion"); this.writer=newDraftId(cryptoSource); }
  private syncLogout() {
    const version = this.get("authVersion");
    if (version !== this.observedAuthVersion) { this.observedAuthVersion = version; this.userId = null; this.generation++; }
  }
  identity() { this.syncLogout(); return this.userId; }
  epoch() { this.syncLogout(); return this.generation; }
  private get(key: string) { try { return this.storage?.getItem(DEVICE_PREFIX + key) ?? null; } catch { return null; } }
  private put(key: string, value: unknown) { try { if (!this.storage) return false; this.storage.setItem(DEVICE_PREFIX + key, JSON.stringify(value)); return true; } catch { return false; } }
  private remove(key: string) { try { this.storage?.removeItem(DEVICE_PREFIX + key); } catch { /* 清理失败也不重新展示旧身份 */ } }
  enabled(id = this.userId) { return !!id && this.get(`consent:${id}`) === "true"; }
  /** 只接受服务器 /me 的身份。换账号清快照，未同步草稿仍留在原账号名下。 */
  identify(id: string | null) {
    const previous = this.userId ?? parse<{ id: string } | null>(this.get("active"), null)?.id;
    if (previous && previous !== id) this.remove(`snapshots:${previous}`);
    const changed = this.userId !== id;
    if (changed) this.generation++;
    this.userId = id;
    if (id && this.enabled(id)) this.put("active", { id }); else this.remove("active");
    if (changed) deviceChanged();
  }
  logout() {
    this.identify(null); this.generation++;
    this.put("authVersion", `${Date.now()}:${Math.random()}`);
    this.observedAuthVersion = this.get("authVersion");
    deviceChanged();
  }
  consent(enabled: boolean) {
    const id = this.userId; if (!id) return false;
    if (!enabled) { this.remove(`consent:${id}`); this.remove(`snapshots:${id}`); this.remove("active"); return true; }
    const ok = this.put(`consent:${id}`, true) && this.put("active", { id });
    if (!ok) { this.remove(`consent:${id}`); this.remove("active"); }
    return ok;
  }
  snapshots(now = Date.now()): DeviceSnapshot[] {
    if (!this.userId || !this.enabled()) return [];
    const raw = parse<unknown>(this.get(`snapshots:${this.userId}`), []);
    const rows = Array.isArray(raw) ? raw.filter((s): s is DeviceSnapshot => !!s && typeof s === "object" && (s.kind === "note" || s.kind === "today") && typeof s.id === "string" && typeof s.text === "string" && typeof s.title === "string" && typeof s.href === "string" && s.savedAt > now - SNAPSHOT_TTL && s.savedAt <= now + 60000) : [];
    if (Array.isArray(raw) && rows.length !== raw.length) this.put(`snapshots:${this.userId}`, rows);
    return rows;
  }
  snapshot(value: DeviceSnapshot, expectedUser = this.userId) {
    this.syncLogout();
    if (!this.userId || expectedUser !== this.userId || !this.enabled() || value.text.length > 250000) return false;
    let rows = [value, ...this.snapshots().filter(s => !(s.kind === value.kind && s.id === value.id))];
    rows = rows.filter((s, i) => rows.slice(0, i).filter(x => x.kind === s.kind).length < (s.kind === "note" ? 10 : 3));
    while (JSON.stringify(rows).length > 1000000) rows.pop();
    return this.put(`snapshots:${this.userId}`, rows);
  }
  forgetSnapshot(id: string) { if (this.userId) this.put(`snapshots:${this.userId}`, this.snapshots().filter(s => s.id !== id)); }
  clearSnapshots() { if (this.userId) this.remove(`snapshots:${this.userId}`); }
  private draftKey(id: string, user = this.userId) { return `${user}:${id}`; }
  private diskDrafts(id?: string): LocalNoteDraft[] {
    if (!this.userId || !this.storage) return [];
    const prefix = `draft:${this.userId}:`, rows: LocalNoteDraft[] = [];
    try {
      for (let i=0;i<this.storage.length;i++) {
        const full=this.storage.key(i);if(!full?.startsWith(DEVICE_PREFIX+prefix))continue;
        const branch=full.slice(DEVICE_PREFIX.length),value=parse<LocalNoteDraft|null>(this.storage.getItem(full),null);
        if (!value || (id && value.id!==id) || typeof value.id!=="string" || typeof value.title!=="string" || typeof value.bodyMd!=="string" || typeof value.workspaceId!=="string" || !Number.isInteger(value.version) || value.version<1) continue;
        rows.push({...value,draftBranch:branch});
      }
    } catch { /* 存储不可读时保留当前内存稿 */ }
    // 一次写入中途崩溃可留下同一写者的新旧快照，恢复较新的完整快照。
    const byWriter=new Map<string,LocalNoteDraft>();
    for(const row of rows){const key=`${row.id}:${row.draftWriter??row.draftBranch}`,previous=byWriter.get(key);if(!previous||(row.draftSequence??0)>(previous.draftSequence??0)||((row.draftSequence??0)===(previous.draftSequence??0)&&row.savedAt>previous.savedAt))byWriter.set(key,row);}
    return [...byWriter.values()].sort((a,b)=>b.savedAt-a.savedAt);
  }
  draft(id: string): LocalNoteDraft | null {
    this.syncLogout();if(!this.userId)return null;
    const key=this.draftKey(id);if(this.drafts.has(key))return this.drafts.get(key)??null;
    const value=this.diskDrafts(id)[0]??null;this.drafts.set(key,value);
    if(value?.draftBranch)this.source.set(key,value.draftBranch);
    return value;
  }
  saveDraft(value: LocalNoteDraft, user = this.userId): "persisted" | "memory" | "failed" {
    this.syncLogout();if(!user||user!==this.userId)return "failed";
    const key=this.draftKey(value.id),revision=newDraftId(this.cryptoSource),branch=this.writer&&revision?`draft:${user}:${value.id}:${this.writer}:${revision}`:undefined;
    const next={...value,draftBranch:branch,draftWriter:this.writer??undefined,draftSequence:++this.sequence};
    // 每个实例写入自己的不可变快照。另一个标签的同篇草稿永远不被覆盖。
    this.drafts.set(key,next);this.edited.add(key);
    if(!this.enabled())return "memory";
    if(!branch)return "failed";
    const disk=this.diskDrafts();
    if(JSON.stringify(next).length>1_000_000 || (disk.length>=100&&!this.ownDisk.has(key)))return "failed";
    if(!this.put(branch,next))return "failed";
    const previous=this.ownDisk.get(key);this.ownDisk.set(key,branch);
    // 只清理本实例自己写过的旧、不可变快照；先保证新快照已持久化。
    if(previous&&previous!==branch)this.remove(previous);
    return "persisted";
  }
  /** 迟到回包只确认发送正文与该次读取的确切快照，不删除其它分支的后续修订。 */
  acknowledge(sent: NoteDraft, user = this.userId) {
    if(!user||user!==this.identity())return false;
    const key=this.draftKey(sent.id),current=this.draft(sent.id);
    if(!current||!sameDraft(current,sent))return false;
    if(current.draftBranch)this.remove(current.draftBranch);
    const source=this.source.get(key);if(source&&source!==current.draftBranch)this.remove(source);
    const own=this.ownDisk.get(key);if(own&&own!==current.draftBranch)this.remove(own);
    this.source.delete(key);this.ownDisk.delete(key);this.edited.delete(key);this.drafts.set(key,null);return true;
  }
  listDrafts(): LocalNoteDraft[] {
    if(!this.identity())return [];
    const rows=this.diskDrafts();
    for(const [key,value] of this.drafts){if(!value||!key.startsWith(`${this.userId}:`)||!this.edited.has(key))continue;const index=rows.findIndex(row=>row.id===value.id&&row.draftWriter===this.writer);if(index>=0)rows.splice(index,1);rows.push(value);}
    return rows.sort((a,b)=>b.savedAt-a.savedAt);
  }
  /** 传入 UI 展示的不可变分支；确认期间别人写的新快照不会被误删。 */
  discardDraft(id: string, branch?: string) {
    if(!this.identity())return;
    const key=this.draftKey(id),current=this.draft(id),target=branch??current?.draftBranch;
    if(target && (target===`draft:${this.userId}:${id}`||target.startsWith(`draft:${this.userId}:${id}:`)))this.remove(target);
    if(!branch||branch===current?.draftBranch){this.drafts.set(key,null);this.edited.delete(key);this.source.delete(key);this.ownDisk.delete(key);}
  }
}

let local: StorageLike | null = null;
try { if (typeof window !== "undefined") local = window.localStorage; } catch { /* 隐私模式仍可编辑 */ }
export const deviceStorage = new DeviceStorage(local);
export function deviceChanged() { if (typeof window !== "undefined") window.dispatchEvent(new Event("kb:device-storage")); }

/** 捕获已认证成功的特定读响应；不缓存附件、搜索、分享或错误响应。 */
export function captureDeviceResponse(path: string, data: unknown, method: string, user: string | null, epoch: number) {
  if (epoch !== deviceStorage.epoch()) return;
  const obj = data as Record<string, unknown> | null;
  if (path === "/api/v1/me") { if (obj && typeof obj.id === "string") deviceStorage.identify(obj.id); return; }
  if (!user || user !== deviceStorage.identity() || method !== "GET" || !obj) return;
  if (/^\/api\/v1\/notes\/[^/?]+$/.test(path) && typeof obj.id === "string" && typeof obj.title === "string" && typeof obj.bodyMd === "string") {
    const ws = typeof obj.workspaceId === "string" ? obj.workspaceId : "";
    deviceStorage.snapshot({ kind: "note", id: obj.id, title: obj.title, text: obj.bodyMd, href: ws ? `/w/${ws}/n/${obj.id}` : "/app", savedAt: Date.now() }, user);
  }
  const today = /^\/api\/v1\/workspaces\/([^/?]+)\/today$/.exec(path);
  if (today && typeof obj.date === "string") {
    const lines = [`${obj.date} · ${String(obj.timezone ?? "")}`];
    for (const [key, label] of [["items", "今天的安排"], ["overdue", "逾期事项"], ["notes", "最近笔记"]]) {
      lines.push(`\n${label}`);
      for (const item of Array.isArray(obj[key]) ? obj[key] as Record<string, unknown>[] : []) lines.push(`• ${String(item.title ?? "")} ${String(item.startsAt ?? item.dueAt ?? "")}`);
    }
    deviceStorage.snapshot({ kind: "today", id: today[1]!, title: `今天 · ${obj.date}`, text: lines.join("\n"), href: `/w/${today[1]}/today`, savedAt: Date.now() }, user);
  }
}
