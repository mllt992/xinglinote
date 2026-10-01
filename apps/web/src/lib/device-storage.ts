import type { NoteDraft } from "./note-save";

/** 内容仅在用户明确同意「可信设备」后落盘；API 和分享页绝不进 SW 缓存。 */
export const DEVICE_PREFIX = "xingli.device.v1:";
export const SNAPSHOT_TTL = 7 * 86400000;
export type DeviceSnapshot = { kind: "note" | "today"; id: string; title: string; text: string; href: string; savedAt: number };
export type LocalNoteDraft = NoteDraft & { workspaceId: string; savedAt: number };
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const sameDraft = (a: NoteDraft, b: NoteDraft) => a.title === b.title && a.bodyMd === b.bodyMd && a.aiIndex === b.aiIndex && a.published === b.published && JSON.stringify(a.tags ?? []) === JSON.stringify(b.tags ?? []);
function parse<T>(value: string | null, fallback: T): T { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } }

export class DeviceStorage {
  private drafts = new Map<string, LocalNoteDraft | null>();
  private diskSeen = new Map<string, string | null>();
  private userId: string | null = null;
  private generation = 0;
  private observedAuthVersion: string | null;
  constructor(private storage: StorageLike | null) { this.observedAuthVersion = this.get("authVersion"); }
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
    if (this.userId !== id) this.generation++;
    this.userId = id;
    if (id && this.enabled(id)) this.put("active", { id }); else this.remove("active");
  }
  logout() {
    this.identify(null); this.generation++;
    this.put("authVersion", `${Date.now()}:${Math.random()}`);
    this.observedAuthVersion = this.get("authVersion");
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
  draft(id: string): LocalNoteDraft | null {
    this.syncLogout();
    if (!this.userId) return null;
    const key = this.draftKey(id);
    if (this.drafts.has(key)) return this.drafts.get(key) ?? null;
    const raw = this.get(`draft:${key}`);
    this.diskSeen.set(key, raw);
    const value = parse<LocalNoteDraft | null>(raw, null);
    const valid = value && value.id === id && typeof value.title === "string" && typeof value.bodyMd === "string" && typeof value.workspaceId === "string" && Number.isInteger(value.version) && value.version >= 1 ? value : null;
    this.drafts.set(key, valid);
    return valid;
  }
  saveDraft(value: LocalNoteDraft, user = this.userId): "persisted" | "memory" | "failed" {
    this.syncLogout();
    if (!user || user !== this.userId) return "failed";
    const key = this.draftKey(value.id);
    if (!this.diskSeen.has(key)) this.diskSeen.set(key, this.get(`draft:${key}`));
    // 永远先写内存；QuotaExceeded 后不能把磁盘上的旧稿反灌回来。
    this.drafts.set(key, value);
    if (!this.enabled()) return "memory";
    const persisted = this.put(`draft:${key}`, value);
    if (persisted) this.diskSeen.set(key, JSON.stringify(value));
    const ids = parse<unknown>(this.get(`draft-index:${user}`), []);
    const indexed = this.put(`draft-index:${user}`, [...new Set([value.id, ...(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [])])]);
    return persisted && indexed ? "persisted" : "failed";
  }
  /** 迟到的 A 请求只能确认 A 发送的正文；不会清掉继续输入的 B。 */
  acknowledge(sent: NoteDraft, user = this.userId) {
    if (!user || user !== this.userId) return false;
    const current = this.draft(sent.id);
    if (!current || !sameDraft(current, sent)) return false;
    const key = this.draftKey(sent.id);
    // 另一标签已写入不同快照时，不让本标签迟到的成功回包删掉它。
    if (this.diskSeen.has(key) && this.get(`draft:${key}`) !== this.diskSeen.get(key)) return false;
    this.discardDraft(sent.id); return true;
  }
  listDrafts(): LocalNoteDraft[] {
    if (!this.identity()) return [];
    const ids = parse<unknown>(this.get(`draft-index:${this.userId}`), []);
    const known = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
    const memory = [...this.drafts.keys()].filter(k => k.startsWith(`${this.userId}:`)).map(k => k.slice(this.userId!.length + 1));
    return [...new Set([...known, ...memory])].map(id => this.draft(id)).filter((d): d is LocalNoteDraft => !!d).sort((a, b) => b.savedAt - a.savedAt);
  }
  discardDraft(id: string) { if (!this.userId) return; const key = this.draftKey(id); this.drafts.set(key, null); this.remove(`draft:${key}`); this.diskSeen.set(key, null); }
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
