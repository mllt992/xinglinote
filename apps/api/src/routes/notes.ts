import { Hono } from "hono";
import { and, asc, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { canEditNote, canReadNote, recencyBoost, scoreNote, tokenize, type WsRole } from "@kb/core";
import { fail, nextSortKey } from "@kb/shared";
import { db } from "../db/client.ts";
import { attachments, auditLogs, folders, notebookMembers, notebooks, notes, noteVersions, users, workspaceMembers, workspaces } from "../db/schema.ts";
import { ok } from "../http.ts";
import { writeNoteFile } from "../lib/files.ts";
import { currentUser } from "../lib/session.ts";
import { memberRole } from "../lib/workspace.ts";
import { backlinksFor, rebuildLinks, snippetAround } from "../lib/links.ts";
import { assertUserStorage, textBytes } from "../lib/quota.ts";
import { noteAccess } from "../lib/note-access.ts";
import { notebookAccess } from "../lib/notebook-access.ts";
import { purgeFolder,purgeNotebook,purgeNotes,restoreFolder,restoreFolderId,restoreNotebook,restoreTitle,trashFolder,trashNotebook } from "../lib/trash.ts";

export const knowledge = new Hono();

async function requireUser(c: Parameters<typeof currentUser>[0]) {
  const user = await currentUser(c);
  if (!user) throw fail("UNAUTHENTICATED", "未登录");
  return user;
}

async function loadNotebook(notebookId: string) {
  const [nb] = await db.select().from(notebooks).where(eq(notebooks.id, notebookId));
  if (!nb || nb.trashedAt) throw fail("NOT_FOUND", "笔记本不存在");
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, nb.workspaceId));
  if (!ws) throw fail("NOT_FOUND", "工作区不存在");
  return { nb, ws };
}

knowledge.get("/workspaces", async (c) => {
  const user = await requireUser(c);
  const { workspaceMembers } = await import("../db/schema.ts");
  const mine = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, user.id));
  const ids = mine.map((m) => m.workspaceId);
  if (!ids.length) return ok(c, { workspaces: [] });
  const list = await db.select().from(workspaces);
  return ok(c, {
    workspaces: list
      .filter((w) => ids.includes(w.id))
      .map((w) => ({
        id: w.id,
        name: w.name,
        slug: w.slug,
        kind: w.kind,
        frozen: w.frozen,
        deletionScheduledAt: w.deletionScheduledAt,
        role: mine.find((m) => m.workspaceId === w.id)?.role,
      })),
  });
});

knowledge.get("/workspaces/:id/notebooks", async (c) => {
  const user = await requireUser(c);
  const id = c.req.param("id");
  const role = await memberRole(id, user.id);
  if (!role) throw fail("FORBIDDEN", "不是该工作区成员");
  const list = await db.select().from(notebooks).where(and(eq(notebooks.workspaceId, id), isNull(notebooks.trashedAt)));
  const visible=[];for(const nb of list){try{await notebookAccess(nb.id,user.id,"read");visible.push(nb);}catch{}}
  return ok(c, { notebooks: visible });
});

knowledge.get("/notebooks/:id/tree", async (c) => {
  const user = await requireUser(c);
  const {notebook:nb}=await notebookAccess(c.req.param("id"),user.id,"read");
  const dirs = await db.select().from(folders).where(and(eq(folders.notebookId, nb.id), isNull(folders.trashedAt)));
  const ns = await db
    .select()
    .from(notes)
    .where(and(eq(notes.notebookId, nb.id), isNull(notes.trashedAt)))
    .orderBy(asc(notes.sortKey), desc(notes.createdAt));
  let canEdit = true;
  try { await notebookAccess(nb.id, user.id, "edit"); } catch { canEdit = false; }
  return ok(c, {
    folders: dirs,
    canEdit,
    notes: ns.map((n) => ({ id: n.id, title: n.title, folderId: n.folderId, sortKey: n.sortKey, createdAt: n.createdAt, updatedAt: n.updatedAt })),
  });
});

knowledge.patch("/notebooks/:id/notes/order", async (c) => {
  const user = await requireUser(c);
  const { notebook: nb } = await notebookAccess(c.req.param("id"), user.id, "edit");
  const body = z.object({ noteIds: z.array(z.string().uuid()).min(1).max(2000) }).parse(await c.req.json());
  if (new Set(body.noteIds).size !== body.noteIds.length) throw fail("VALIDATION", "笔记顺序不能重复");
  const rows = await db.select({ id: notes.id }).from(notes).where(and(eq(notes.notebookId, nb.id), isNull(notes.trashedAt), inArray(notes.id, body.noteIds)));
  if (rows.length !== body.noteIds.length) throw fail("VALIDATION", "只能排列当前笔记本里的笔记");
  await db.transaction(async (tx) => {
    for (let i = 0; i < body.noteIds.length; i++) {
      await tx.update(notes).set({ sortKey: i }).where(eq(notes.id, body.noteIds[i]!));
    }
  });
  return ok(c, { noteIds: body.noteIds });
});

knowledge.post("/notes", async (c) => {
  const user = await requireUser(c);
  const body = z.object({ notebookId: z.string().uuid(), folderId: z.string().uuid().nullish(), title: z.string().min(1).max(200).optional() }).parse(await c.req.json());
  const {notebook:nb,workspace:ws}=await notebookAccess(body.notebookId,user.id,"edit");
  const title = body.title?.trim() || "未命名";
  await assertUserStorage(user.id, textBytes(title, ""));
  const existing = await db.select({ sortKey: notes.sortKey }).from(notes).where(and(eq(notes.notebookId, nb.id), isNull(notes.trashedAt)));
  const [note] = await db
    .insert(notes)
    .values({
      workspaceId: ws.id,
      notebookId: nb.id,
      folderId: body.folderId ?? null,
      sortKey: nextSortKey(existing.map((n) => n.sortKey)),
      title,
      bodyMd: "",
      aiIndex: nb.defaultAiIndex,
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning();
  await db.insert(noteVersions).values({
    noteId: note.id,
    version: 1,
    title: note.title,
    bodyMd: "",
    editorId: user.id,
    source: "ui",
  });
  await writeNoteFile({ ...note, noteId: note.id });
  return ok(c, note, 201);
});

knowledge.get("/notes/:id", async (c) => {
  const user = await requireUser(c);
  const {note}=await noteAccess(c.req.param("id"),user.id,"read");
  let canEdit=true;try{await noteAccess(note.id,user.id,"edit");}catch{canEdit=false;}
  return ok(c, { ...note, canEdit });
});

knowledge.patch("/notes/:id", async (c) => {
  const user = await requireUser(c);
  const body = z
    .object({
      expectedVersion: z.number().int(),
      bodyMd: z.string().optional(),
      title: z.string().min(1).max(200).optional(),
      published: z.boolean().optional(),
      aiIndex: z.boolean().optional(),
      tags: z.array(z.string().min(1).max(40)).max(30).optional(),
      force: z.boolean().optional(),
      source:z.enum(["ui","ai_accept"]).optional(),
    })
    .parse(await c.req.json());
  const {note}=await noteAccess(c.req.param("id"),user.id,"edit");
  if (note.version !== body.expectedVersion && !body.force) {
    throw fail("CONFLICT_VERSION", "别人刚保存了更新");
  }
  if (note.version !== body.expectedVersion && body.force) {
    const [already] = await db.select().from(noteVersions).where(and(eq(noteVersions.noteId, note.id), eq(noteVersions.version, note.version)));
    if (!already) await db.insert(noteVersions).values({ noteId: note.id, version: note.version, title: note.title, bodyMd: note.bodyMd, editorId: note.updatedBy, source: "ui" });
  }
  const nextTitle = body.title ?? note.title;
  const nextBody = body.bodyMd ?? note.bodyMd;
  await assertUserStorage(note.createdBy, textBytes(nextTitle, nextBody) - textBytes(note.title, note.bodyMd));
  const next = {
    title: nextTitle,
    bodyMd: nextBody,
    published: body.published ?? note.published,
    aiIndex: body.aiIndex ?? note.aiIndex,
    tags: body.tags ? [...new Set(body.tags.map(t => t.trim()).filter(Boolean))] : (note.tags as string[]),
    version: note.version + 1,
    updatedBy: user.id,
    updatedAt: new Date(),
  };
  const [saved] = await db.update(notes).set(next).where(eq(notes.id, note.id)).returning();
  await db.insert(noteVersions).values({
    noteId: note.id,
    version: saved.version,
    title: saved.title,
    bodyMd: saved.bodyMd,
    editorId: user.id,
    source: body.source??"ui",
  });
  await writeNoteFile({ ...saved, noteId: saved.id });
  await rebuildLinks(saved.id, saved.workspaceId, saved.bodyMd);
  return ok(c, saved);
});

knowledge.post("/workspaces", async (c) => {
  const user = await requireUser(c);
  const body = z.object({ name: z.string().min(1).max(40) }).parse(await c.req.json());
  const slug = `w-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const { workspaceMembers } = await import("../db/schema.ts");
  const [ws] = await db.insert(workspaces).values({ name: body.name.trim(), slug, kind: "normal", ownerId: user.id }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: "owner" });
  const [nb] = await db.insert(notebooks).values({ workspaceId: ws.id, slug: "inbox", title: "收件箱", createdBy: user.id }).returning();
  return ok(c, { workspace: ws, notebook: nb }, 201);
});

knowledge.post("/workspaces/:id/notebooks", async (c) => {
  const user = await requireUser(c);
  const workspaceId = c.req.param("id");
  const role = await memberRole(workspaceId, user.id);
  if (role !== "owner" && role !== "admin") throw fail("FORBIDDEN", "只有管理员能创建笔记本");
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (ws?.frozen) throw fail("FORBIDDEN", "工作区已冻结，暂时只读");
  const body = z.object({ title: z.string().min(1).max(80), visibility: z.enum(["open", "private", "restricted"]).default("open") }).parse(await c.req.json());
  const slug = `nb-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const [nb] = await db.insert(notebooks).values({ workspaceId, slug, title: body.title.trim(), visibility: body.visibility, createdBy: user.id }).returning();
  return ok(c, nb, 201);
});

knowledge.patch("/notebooks/:id", async (c) => {
  const user = await requireUser(c);
  const { nb, ws } = await loadNotebook(c.req.param("id"));
  const role = await memberRole(ws.id, user.id);
  if (role !== "owner" && role !== "admin" && nb.createdBy !== user.id) throw fail("FORBIDDEN", "无权修改笔记本");
  const body = z.object({ title: z.string().min(1).max(80).optional(), defaultAiIndex: z.boolean().optional(), visibility:z.enum(["open","private","restricted"]).optional() }).parse(await c.req.json());
  const [saved] = await db.update(notebooks).set({ title: body.title ?? nb.title, defaultAiIndex: body.defaultAiIndex ?? nb.defaultAiIndex,visibility:body.visibility??nb.visibility }).where(eq(notebooks.id, nb.id)).returning();
  return ok(c, saved);
});

knowledge.get("/notebooks/:id/members",async c=>{const user=await requireUser(c);const{nb,ws}=await loadNotebook(c.req.param("id"));const role=await memberRole(ws.id,user.id);if(role!=="owner"&&role!=="admin"&&nb.createdBy!==user.id)throw fail("FORBIDDEN","无权管理笔记本权限");const rows=await db.select().from(notebookMembers).where(eq(notebookMembers.notebookId,nb.id));return ok(c,{members:rows});});
knowledge.put("/notebooks/:id/members",async c=>{const user=await requireUser(c);const{nb,ws}=await loadNotebook(c.req.param("id"));const role=await memberRole(ws.id,user.id);if(role!=="owner"&&role!=="admin"&&nb.createdBy!==user.id)throw fail("FORBIDDEN","无权管理笔记本权限");if(ws.frozen)throw fail("FORBIDDEN","工作区已冻结");const body=z.object({members:z.array(z.object({userId:z.string().uuid(),role:z.enum(["view","edit"])})).max(500)}).parse(await c.req.json());const workspaceUsers=await db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId,ws.id));if(body.members.some(m=>!workspaceUsers.some(w=>w.userId===m.userId)))throw fail("VALIDATION","白名单成员必须先加入工作区");await db.transaction(async tx=>{await tx.delete(notebookMembers).where(eq(notebookMembers.notebookId,nb.id));if(body.members.length)await tx.insert(notebookMembers).values(body.members.filter(m=>m.userId!==nb.createdBy).map(m=>({notebookId:nb.id,userId:m.userId,role:m.role})));});return ok(c,{});});

knowledge.delete("/notebooks/:id", async (c) => {
  const user = await requireUser(c);
  const { nb, ws } = await loadNotebook(c.req.param("id"));
  const role = await memberRole(ws.id, user.id);
  if (role !== "owner" && role !== "admin") throw fail("FORBIDDEN", "无权删除笔记本");
  if (ws.frozen) throw fail("FORBIDDEN", "工作区已冻结，暂时只读");
  await trashNotebook(nb.id,user.id);
  return ok(c, {});
});

knowledge.post("/folders", async (c) => {
  const user = await requireUser(c);
  const body = z.object({ notebookId: z.string().uuid(), parentId: z.string().uuid().nullable().optional(), title: z.string().min(1).max(100) }).parse(await c.req.json());
  const {notebook:nb,workspace:ws}=await notebookAccess(body.notebookId,user.id,"edit");
  const [folder] = await db.insert(folders).values({ workspaceId: ws.id, notebookId: nb.id, parentId: body.parentId ?? null, title: body.title.trim() }).returning();
  return ok(c, folder, 201);
});

knowledge.patch("/folders/:id", async (c) => {
  const user = await requireUser(c);
  const [folder] = await db.select().from(folders).where(eq(folders.id, c.req.param("id")));
  if (!folder || folder.trashedAt) throw fail("NOT_FOUND", "目录不存在");
  await notebookAccess(folder.notebookId,user.id,"edit");
  const body = z.object({ title: z.string().min(1).max(100).optional(), parentId: z.string().uuid().nullable().optional() }).parse(await c.req.json());
  const [saved] = await db.update(folders).set({ title: body.title ?? folder.title, parentId: body.parentId === undefined ? folder.parentId : body.parentId }).where(eq(folders.id, folder.id)).returning();
  return ok(c, saved);
});

knowledge.delete("/folders/:id", async (c) => {
  const user = await requireUser(c);
  const [folder] = await db.select().from(folders).where(eq(folders.id, c.req.param("id")));
  if (!folder || folder.trashedAt) throw fail("NOT_FOUND", "目录不存在");
  await notebookAccess(folder.notebookId,user.id,"edit");
  await trashFolder(folder.id,user.id);
  return ok(c, {});
});

knowledge.delete("/notes/:id", async (c) => {
  const user = await requireUser(c);
  const {note}=await noteAccess(c.req.param("id"),user.id,"edit");
  await db.update(notes).set({ trashedAt: new Date(),trashedBy:user.id,trashBatchId:crypto.randomUUID() }).where(eq(notes.id, note.id));
  return ok(c, {});
});

knowledge.get("/notes/:id/versions", async (c) => {
  const user = await requireUser(c); const {note}=await noteAccess(c.req.param("id"),user.id,"read"); const rows=await db.select().from(noteVersions).where(eq(noteVersions.noteId,note.id)).orderBy(asc(noteVersions.version)); return ok(c,{total:rows.length,versions:rows.reverse().slice(0,100).map(v=>({id:v.id,version:v.version,title:v.title,bodyMd:v.bodyMd,source:v.source,createdAt:v.createdAt}))});
});
knowledge.post("/notes/:id/versions/:version/restore", async (c) => {
  const user=await requireUser(c);const {note}=await noteAccess(c.req.param("id"),user.id,"edit");const version=Number(c.req.param("version"));const [old]=await db.select().from(noteVersions).where(and(eq(noteVersions.noteId,note.id),eq(noteVersions.version,version)));if(!old)throw fail("NOT_FOUND","版本不存在");await assertUserStorage(note.createdBy,textBytes(old.title,old.bodyMd)-textBytes(note.title,note.bodyMd));const [saved]=await db.update(notes).set({title:old.title,bodyMd:old.bodyMd,version:note.version+1,updatedBy:user.id,updatedAt:new Date()}).where(eq(notes.id,note.id)).returning();await db.insert(noteVersions).values({noteId:note.id,version:saved.version,title:saved.title,bodyMd:saved.bodyMd,editorId:user.id,source:"restore"});await writeNoteFile({...saved,noteId:saved.id});await rebuildLinks(saved.id,saved.workspaceId,saved.bodyMd);return ok(c,saved);
});

knowledge.get("/notes/:id/backlinks", async (c) => {
  const user = await requireUser(c);
  const [note] = await db.select().from(notes).where(eq(notes.id, c.req.param("id")));
  if (!note || note.trashedAt) throw fail("NOT_FOUND", "笔记不存在");
  await noteAccess(note.id,user.id,"read");
  const rows = await backlinksFor(note.id);const visible=[];for(const r of rows){try{await noteAccess(r.id,user.id,"read");visible.push({id:r.id,title:r.title,snippet:snippetAround(r.bodyMd,r.raw)});}catch{}}
  return ok(c, { items: visible });
});

knowledge.get("/search", async (c) => {
  const user = await requireUser(c);
  const q = (c.req.query("q") ?? "").trim().slice(0, 200);
  if (!q) return ok(c, { hits: [], total: 0 });
  const workspaceId = c.req.query("workspaceId"), notebookId = c.req.query("notebookId"), tag = c.req.query("tag");
  const titleOnly = c.req.query("titleOnly") === "1";
  const aiIndex = c.req.query("aiIndex");                       // "1" 只看进大脑的，"0" 只看没进的
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  const memberships = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, user.id));
  const ids = workspaceId ? [workspaceId] : memberships.map(m => m.workspaceId);
  if (workspaceId && !memberships.some(m => m.workspaceId === workspaceId)) throw fail("FORBIDDEN", "不是工作区成员");
  const parts = tokenize(q);
  const scored = [];
  for (const id of ids) {
    const where = [eq(notes.workspaceId, id), isNull(notes.trashedAt)];
    if (notebookId) where.push(eq(notes.notebookId, notebookId));
    if (aiIndex === "1" || aiIndex === "0") where.push(eq(notes.aiIndex, aiIndex === "1"));
    const rows = await db.select().from(notes).where(and(...where));
    // PDF 抽出来的文本也算正文，附件里的内容才搜得到（规格 06 的 4.3）
    const pdfText = new Map<string, string>();
    if (!titleOnly && rows.length) {
      const files = await db.select({ noteId: attachments.noteId, text: attachments.extractedText }).from(attachments)
        .where(and(eq(attachments.workspaceId, id), eq(attachments.extractStatus, "ok"), isNull(attachments.trashedAt)));
      for (const f of files) if (f.text) pdfText.set(f.noteId, `${pdfText.get(f.noteId) ?? ""}\n${f.text}`);
    }
    for (const n of rows) {
      const tags = ((n.tags as string[]) ?? []);
      if (tag && !tags.some(t => t.toLowerCase() === tag.toLowerCase())) continue;
      const base = scoreNote(parts, { title: n.title, tags, body: titleOnly ? "" : n.bodyMd + (pdfText.get(n.id) ?? "") });
      if (!base) continue;
      const body = n.bodyMd.toLowerCase();
      const needle = parts.map(p => p.raw).concat(parts.flatMap(p => p.grams)).find(t => body.includes(t)) ?? "";
      const at = needle ? body.indexOf(needle) : -1;
      scored.push({ note: n, score: base + recencyBoost(n.updatedAt), snippet: at >= 0 ? n.bodyMd.slice(Math.max(0, at - 60), at + 180) : n.bodyMd.slice(0, 180) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const hits = [];
  for (const s of scored) {
    if (hits.length >= offset + limit) break;
    try { await noteAccess(s.note.id, user.id, "read"); hits.push({ id: s.note.id, title: s.note.title, snippet: s.snippet, notebookId: s.note.notebookId, workspaceId: s.note.workspaceId, tags: s.note.tags, score: Math.round(s.score * 100) / 100 }); } catch { /* 无权就当不存在 */ }
  }
  return ok(c, { hits: hits.slice(offset, offset + limit), total: hits.length, hasMore: hits.length >= offset + limit });
});

knowledge.get("/workspaces/:id/trash", async (c) => {
  const user = await requireUser(c);
  const workspaceId = c.req.param("id");
  const role = await memberRole(workspaceId, user.id);
  if (!role) throw fail("FORBIDDEN", "不是工作区成员");
  const canAll=role==="owner"||role==="admin";const allNotes=await db.select().from(notes).where(eq(notes.workspaceId,workspaceId));const allFolders=await db.select().from(folders).where(eq(folders.workspaceId,workspaceId));const allNotebooks=await db.select().from(notebooks).where(eq(notebooks.workspaceId,workspaceId));const own=<T extends {trashedAt:Date|null;trashedBy:string|null}>(rows:T[])=>rows.filter(x=>x.trashedAt&&(canAll||x.trashedBy===user.id));
  const people=await db.select({id:users.id,displayName:users.displayName}).from(users);const who=(id:string|null)=>people.find(p=>p.id===id)?.displayName??"已注销用户";
  const nbTitle=(id:string)=>allNotebooks.find(x=>x.id===id)?.title??"已销毁的笔记本";
  const path=(n:typeof allNotes[number])=>{const parts=[nbTitle(n.notebookId)];let cur=n.folderId?allFolders.find(f=>f.id===n.folderId):undefined;const guard=new Set<string>();while(cur&&!guard.has(cur.id)){guard.add(cur.id);parts.splice(1,0,cur.title);cur=cur.parentId?allFolders.find(f=>f.id===cur!.parentId):undefined;}return parts.join(" / ");};
  const meta=(x:{trashedAt:Date|null;trashedBy:string|null})=>({trashedAt:x.trashedAt,trashedBy:x.trashedBy,trashedByName:who(x.trashedBy),purgeAt:x.trashedAt?new Date(x.trashedAt.getTime()+30*86400000):null});
  return ok(c,{notes:own(allNotes).map(n=>({id:n.id,title:n.title,path:path(n),...meta(n)})),folders:own(allFolders).map(f=>({id:f.id,title:f.title,path:nbTitle(f.notebookId),...meta(f)})),notebooks:own(allNotebooks).map(n=>({id:n.id,title:n.title,path:"整本",...meta(n)}))});
});

knowledge.post("/trash/note/:id/restore", async (c) => {
  const user = await requireUser(c);
  const [note] = await db.select().from(notes).where(eq(notes.id, c.req.param("id")));
  if (!note || !note.trashedAt) throw fail("NOT_FOUND", "回收站中没有这篇笔记");
  const role = await memberRole(note.workspaceId, user.id);
  if (!role || role === "viewer") throw fail("FORBIDDEN", "无权恢复");
  await assertUserStorage(note.createdBy,textBytes(note.title,note.bodyMd));
  if(role!=="owner"&&role!=="admin"&&note.trashedBy!==user.id)throw fail("FORBIDDEN","只能恢复自己删除的内容");
  const title=await restoreTitle(note),folderId=await restoreFolderId(note);
  await db.update(notes).set({ trashedAt: null,trashedBy:null,trashBatchId:null,title,folderId }).where(eq(notes.id, note.id));
  await rebuildLinks(note.id, note.workspaceId, note.bodyMd);
  return ok(c, { title, folderId, renamed: title !== note.title, movedToRoot: !!note.folderId && !folderId });
});
knowledge.post("/trash/folder/:id/restore",async c=>{const user=await requireUser(c);const[f]=await db.select().from(folders).where(eq(folders.id,c.req.param("id")));if(!f?.trashedAt||!f.trashBatchId)throw fail("NOT_FOUND","回收站中没有此目录");const role=await memberRole(f.workspaceId,user.id);if(!role||(role!=="owner"&&role!=="admin"&&f.trashedBy!==user.id))throw fail("FORBIDDEN","无权恢复");const affected=await db.select().from(notes).where(eq(notes.trashBatchId,f.trashBatchId));for(const n of affected)await assertUserStorage(n.createdBy,textBytes(n.title,n.bodyMd));await restoreFolder(f.id,f.trashBatchId);for(const n of affected)await rebuildLinks(n.id,n.workspaceId,n.bodyMd);return ok(c,{});});
knowledge.post("/trash/notebook/:id/restore",async c=>{const user=await requireUser(c);const[nb]=await db.select().from(notebooks).where(eq(notebooks.id,c.req.param("id")));if(!nb?.trashedAt||!nb.trashBatchId)throw fail("NOT_FOUND","回收站中没有此笔记本");const role=await memberRole(nb.workspaceId,user.id);if(role!=="owner"&&role!=="admin")throw fail("FORBIDDEN","只有管理员能恢复笔记本");const affected=await db.select().from(notes).where(eq(notes.trashBatchId,nb.trashBatchId));for(const n of affected)await assertUserStorage(n.createdBy,textBytes(n.title,n.bodyMd));await restoreNotebook(nb.id,nb.trashBatchId);for(const n of affected)await rebuildLinks(n.id,n.workspaceId,n.bodyMd);return ok(c,{});});

async function purgeTarget(c:any,kind:"note"|"folder"|"notebook"){const user=await requireUser(c);const id=c.req.param("id");
  const [row]=kind==="note"?await db.select().from(notes).where(eq(notes.id,id)):kind==="folder"?await db.select().from(folders).where(eq(folders.id,id)):await db.select().from(notebooks).where(eq(notebooks.id,id));
  if(!row||!row.trashedAt)throw fail("NOT_FOUND","回收站里没有这一项");
  const role=await memberRole(row.workspaceId,user.id);
  if(!role||role==="viewer")throw fail("FORBIDDEN","无权销毁");
  if(role!=="owner"&&role!=="admin"&&row.trashedBy!==user.id)throw fail("FORBIDDEN","只能销毁自己删除的内容");
  if(kind==="note")await purgeNotes([id]);else if(kind==="folder")await purgeFolder(id);else await purgeNotebook(id);
  await db.insert(auditLogs).values({userId:user.id,workspaceId:row.workspaceId,actorType:"user",action:`${kind}.purge`,result:"ok",targetType:kind,targetId:id});
  return ok(c,{});}
knowledge.delete("/trash/note/:id",c=>purgeTarget(c,"note"));
knowledge.delete("/trash/folder/:id",c=>purgeTarget(c,"folder"));
knowledge.delete("/trash/notebook/:id",c=>purgeTarget(c,"notebook"));
