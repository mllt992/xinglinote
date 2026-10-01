import assert from "node:assert/strict";
import test from "node:test";
import { DeviceStorage, DEVICE_PREFIX, SNAPSHOT_TTL, type LocalNoteDraft } from "./device-storage.ts";
class MemoryStorage {
  values = new Map<string, string>(); full = false;
  get length() { return this.values.size; }
  key(index:number) { return [...this.values.keys()][index]??null; }
  getItem(k: string) { return this.values.get(k) ?? null; }
  setItem(k: string, v: string) { if (this.full) throw new Error("quota"); this.values.set(k, v); }
  removeItem(k: string) { this.values.delete(k); }
}
const draft = (bodyMd = "本机新文字"): LocalNoteDraft => ({ id: "note-a", title: "标题", bodyMd, version: 1, aiIndex: true, published: false, workspaceId: "workspace-a", savedAt: Date.now() });
test("默认不落正文，显式同意才落盘，账号与登出隔离", () => {
  const storage = new MemoryStorage(), device = new DeviceStorage(storage);
  device.identify("alice"); assert.equal(device.saveDraft(draft()), "memory");
  assert.equal([...storage.values.keys()].some(k => k.includes("draft:")), false);
  assert.equal(device.consent(true), true); assert.equal(device.saveDraft(draft()), "persisted");
  device.snapshot({ kind: "note", id: "a", title: "私密", text: "私密正文", href: "/app", savedAt: Date.now() });
  assert.equal(device.snapshots().length, 1); device.logout();
  assert.equal(storage.getItem(DEVICE_PREFIX + "active"), null); assert.equal(device.draft("note-a"), null);
  device.identify("bob"); assert.equal(device.draft("note-a"), null); assert.equal(device.snapshots().length, 0);
  device.identify("alice"); assert.equal(device.draft("note-a")?.bodyMd, "本机新文字"); assert.equal(device.snapshots().length, 0);
});
test("迟到成功不能清掉继续输入；存储满后读内存而非旧盘稿", () => {
  const storage = new MemoryStorage(), device = new DeviceStorage(storage);
  device.identify("alice"); device.consent(true); device.saveDraft(draft("旧稿"));
  storage.full = true; assert.equal(device.saveDraft(draft("新稿")), "failed");
  assert.equal(device.draft("note-a")?.bodyMd, "新稿"); assert.equal(device.acknowledge(draft("旧稿")), false);
  assert.equal(device.acknowledge(draft("新稿")), true); assert.equal(device.draft("note-a"), null);
});
test("重载恢复、快照按数量/时间/体积有界，旧账号响应不可写新账号", () => {
  const storage = new MemoryStorage(), device = new DeviceStorage(storage); const now = Date.now();
  device.identify("alice"); device.consent(true); device.saveDraft(draft());
  for (let i = 0; i < 15; i++) device.snapshot({ kind: "note", id: `${i}`, title: `${i}`, text: "正文", href: "/app", savedAt: now });
  for (let i = 0; i < 5; i++) device.snapshot({ kind: "today", id: `${i}`, title: "今天", text: "事项", href: "/app", savedAt: now });
  assert.equal(device.snapshots().length, 13); assert.equal(device.snapshots(now + SNAPSHOT_TTL + 1).length, 0);
  assert.equal(device.snapshot({ kind: "note", id: "oversize", title: "大文件", text: "字".repeat(250001), href: "/app", savedAt: now }), false);
  const reloaded = new DeviceStorage(storage); reloaded.identify("alice"); assert.equal(reloaded.draft("note-a")?.bodyMd, "本机新文字");
  reloaded.identify("bob"); reloaded.consent(true);
  assert.equal(reloaded.snapshot({ kind: "note", id: "late", title: "a", text: "a", href: "/app", savedAt: now }, "alice"), false);
  assert.equal(reloaded.saveDraft(draft(), "alice"), "failed"); assert.equal(reloaded.acknowledge(draft(), "alice"), false);
});
test("隐私模式与损坏存储不阻断编辑，不误称持久化成功", () => {
  const device = new DeviceStorage(null); device.identify("alice"); assert.equal(device.consent(true), false);
  assert.equal(device.saveDraft(draft()), "memory"); assert.equal(device.draft("note-a")?.title, "标题");
  const storage = new MemoryStorage(); storage.values.set(DEVICE_PREFIX + "draft:alice:note-a", "{bad");
  const other = new DeviceStorage(storage); other.identify("alice"); assert.equal(other.draft("note-a"), null);
});
test("另一标签登出会拒绝旧响应与旧身份写入，但保留未同步稿", () => {
  const storage = new MemoryStorage(), a = new DeviceStorage(storage), b = new DeviceStorage(storage);
  a.identify("alice"); b.identify("alice"); a.consent(true); b.saveDraft(draft());
  const epoch = b.epoch(); a.logout();
  assert.notEqual(b.epoch(), epoch); assert.equal(b.identity(), null); assert.equal(b.saveDraft(draft("迟到文字"), "alice"), "failed");
  b.identify("alice"); assert.equal(b.draft("note-a")?.bodyMd, "本机新文字");
});
test("草稿索引可在原笔记失权/删除后导出，登出不误删，新账号看不到", () => {
  const storage = new MemoryStorage(), device = new DeviceStorage(storage); device.identify("alice"); device.consent(true);
  device.saveDraft(draft()); device.saveDraft({ ...draft("另一篇"), id: "note-b" }); device.logout();
  const reloaded = new DeviceStorage(storage); reloaded.identify("bob"); assert.equal(reloaded.listDrafts().length, 0);
  reloaded.identify("alice"); assert.equal(reloaded.listDrafts().length, 2); reloaded.discardDraft("note-a"); assert.deepEqual(reloaded.listDrafts().map(d => d.id), ["note-b"]);
});
test("另一标签的新草稿不会被本标签的迟到成功回包删除", () => {
  const storage = new MemoryStorage(), a = new DeviceStorage(storage), b = new DeviceStorage(storage);
  a.identify("alice"); b.identify("alice"); a.consent(true);
  a.saveDraft(draft("请求中的旧稿")); b.saveDraft(draft("另一个标签的新稿"));
  assert.equal(a.acknowledge(draft("请求中的旧稿")), true);
  const reloaded = new DeviceStorage(storage); reloaded.identify("alice"); assert.equal(reloaded.draft("note-a")?.bodyMd, "另一个标签的新稿");
});

test("两标签先打开同篇，再分别输入：保存与显式丢弃只处理指定分支",()=>{
 const storage=new MemoryStorage(),a=new DeviceStorage(storage),b=new DeviceStorage(storage);a.identify("alice");b.identify("alice");a.consent(true);
 assert.equal(a.draft("note-a"),null);assert.equal(b.draft("note-a"),null);
 b.saveDraft(draft("B 独有文字"));const shownB=b.draft("note-a")!;
 a.saveDraft(draft("A 独有文字"));assert.equal(a.acknowledge(draft("A 独有文字")),true);
 const reloaded=new DeviceStorage(storage);reloaded.identify("alice");assert.equal(reloaded.draft("note-a")?.bodyMd,"B 独有文字");
 b.saveDraft(draft("B 更新文字"));reloaded.discardDraft("note-a",shownB.draftBranch);
 const final=new DeviceStorage(storage);final.identify("alice");assert.equal(final.draft("note-a")?.bodyMd,"B 更新文字");
});
test("恢复旧分支后保存，不会确认另一个标签后来写的新修订",()=>{
 const storage=new MemoryStorage(),a=new DeviceStorage(storage),b=new DeviceStorage(storage);a.identify("alice");b.identify("alice");a.consent(true);a.saveDraft(draft("原草稿"));
 assert.equal(b.draft("note-a")?.bodyMd,"原草稿");b.saveDraft(draft("恢复后编辑"));a.saveDraft(draft("原标签又输入"));assert.equal(b.acknowledge(draft("恢复后编辑")),true);
 const next=new DeviceStorage(storage);next.identify("alice");assert.equal(next.draft("note-a")?.bodyMd,"原标签又输入");
});

test("分支数与单篇大小上限只拒绝新持久化，不清除未同步内容",()=>{
 const storage=new MemoryStorage();
 for(let i=0;i<100;i++){const d=new DeviceStorage(storage);d.identify("alice");d.consent(true);assert.equal(d.saveDraft({...draft(`分支 ${i}`),id:`note-${i}`}),"persisted");}
 const extra=new DeviceStorage(storage);extra.identify("alice");assert.equal(extra.saveDraft({...draft("额外正文"),id:"note-extra"}),"failed");assert.equal(extra.draft("note-extra")?.bodyMd,"额外正文");
 const reload=new DeviceStorage(storage);reload.identify("alice");assert.equal(reload.listDrafts().length,100);assert.equal(extra.saveDraft({...draft("x".repeat(1_000_001)),id:"big"}),"failed");
});
