import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, sql } from "../db/client.ts";
import { calendarItems, notes, notebooks, sessions, users, workspaceMembers, workspaces } from "../db/schema.ts";
import { calendarRoutes } from "../routes/calendar.ts";
import { onError } from "../http.ts";
import { hashSecret } from "./tokens.ts";
import { DEFAULT_TZ, localDayWindow, syncNoteTasks } from "./calendar.ts";

test("移动任务真实回写：今天边界、改期、勾选与笔记 ACL", { skip: !process.env.KB_TEST_DATABASE_URL }, async () => {
  assert.equal(process.env.DATABASE_URL, process.env.KB_TEST_DATABASE_URL);
  assert.ok(new URL(process.env.KB_TEST_DATABASE_URL!).pathname.endsWith('_test'));
  const id = { owner: randomUUID(), other: randomUUID(), ws: randomUUID(), nb: randomUUID(), note: randomUUID() };
  const token = randomBytes(24).toString('base64url'), otherToken = randomBytes(24).toString('base64url');
  try {
    await db.insert(users).values([id.owner, id.other].map((user, i) => ({ id: user, email: `${user}@example.invalid`, handle: `t${user.replaceAll('-', '').slice(0, 20)}`, displayName: `验收${i}`, passwordHash: 'not-a-login' })));
    await db.insert(workspaces).values({ id: id.ws, slug: `test-${id.ws}`, name: '日历测试', kind: 'normal', ownerId: id.owner });
    await db.insert(workspaceMembers).values([{workspaceId:id.ws,userId:id.owner,role:'owner'},{workspaceId:id.ws,userId:id.other,role:'editor'}]);
    await db.insert(notebooks).values({ id: id.nb, workspaceId:id.ws,slug:'private',title:'私密',visibility:'private',createdBy:id.owner });
    await db.insert(notes).values({ id:id.note,workspaceId:id.ws,notebookId:id.nb,title:'来源',bodyMd:'不应丢失的开头\n- [ ] 来源任务 @2026-10-01 ^tk-1234abcd\n结尾',createdBy:id.owner,updatedBy:id.owner });
    await db.insert(sessions).values([{userId:id.owner,tokenHash:hashSecret(token),expiresAt:new Date(Date.now()+60000)},{userId:id.other,tokenHash:hashSecret(otherToken),expiresAt:new Date(Date.now()+60000)}]);
    await syncNoteTasks(id.note);
    const [task]=await db.select().from(calendarItems).where(eq(calendarItems.sourceNoteId,id.note));
    assert.ok(task);
    const app=new Hono();app.onError(onError);app.route('/api/v1',calendarRoutes);
    const request=(path:string,body?:unknown,credential=token)=>app.request(`http://local/api/v1${path}`,{method:body?'POST':'GET',headers:{cookie:`kb_session=${credential}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    assert.equal((await request(`/calendar/items/${task.id}/complete`,{done:true},otherToken)).status,404);
    assert.equal((await request(`/calendar/items/${task.id}/reschedule`,{startsAt:'2026-10-03T16:00:00.000Z'})).status,200);
    let [note]=await db.select().from(notes).where(eq(notes.id,id.note));
    assert.ok(note.bodyMd.includes('@2026-10-04'));
    assert.ok(note.bodyMd.includes('不应丢失的开头'));
    await syncNoteTasks(id.note);
    let [saved]=await db.select().from(calendarItems).where(eq(calendarItems.id,task.id));
    assert.equal(saved.dueAt?.toISOString(),'2026-10-03T16:00:00.000Z');
    assert.equal((await request(`/calendar/items/${task.id}/complete`,{done:true})).status,200);
    [note]=await db.select().from(notes).where(eq(notes.id,id.note));assert.ok(note.bodyMd.includes('- [x] 来源任务'));
    await syncNoteTasks(id.note);
    [saved]=await db.select().from(calendarItems).where(eq(calendarItems.id,task.id));assert.equal(saved.status,'done');
    const {from,to}=localDayWindow(new Date(),DEFAULT_TZ);
    await db.insert(calendarItems).values([
      {workspaceId:id.ws,kind:'task',title:'今天边界内',source:'manual',dueAt:from,createdBy:id.owner,updatedBy:id.owner},
      {workspaceId:id.ws,kind:'task',title:'明天边界外',source:'manual',dueAt:to,createdBy:id.owner,updatedBy:id.owner},
      {workspaceId:id.ws,kind:'task',title:'昨天逾期',source:'manual',dueAt:new Date(from.getTime()-1),createdBy:id.owner,updatedBy:id.owner},
    ]);
    const today=await (await request(`/workspaces/${id.ws}/today`)).json() as { data: { canEdit: boolean; items: Array<{title:string}>; overdue:Array<{title:string}> } };
    assert.equal(today.data.canEdit,true);
    assert.ok(today.data.items.some((r:{title:string})=>r.title==='今天边界内'));
    assert.ok(!today.data.items.some((r:{title:string})=>r.title==='明天边界外'));
    assert.ok(today.data.overdue.some((r:{title:string})=>r.title==='昨天逾期'));
    const other=await (await request(`/workspaces/${id.ws}/today`,undefined,otherToken)).json() as { data: { notes:Array<{id:string}>; items:Array<{sourceNoteId:string}>; overdue:Array<{sourceNoteId:string}> } };
    assert.ok(!other.data.notes.some((r:{id:string})=>r.id===id.note));
    assert.ok(![...other.data.items,...other.data.overdue].some((r:{sourceNoteId:string})=>r.sourceNoteId===id.note));
  } finally { await sql.end(); }
});
