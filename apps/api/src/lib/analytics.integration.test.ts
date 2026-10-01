import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { WorkspaceAnalytics } from "@kb/shared";

// 只运行在显式授权的临时测试库；无数据库时不加载 db/client。
test("真实 SQL 与 HTTP：统计数字、历史窗口、空范围和所有 ACL 边界", { skip: !process.env.KB_TEST_DATABASE_URL }, async () => {
  assert.equal(process.env.DATABASE_URL, process.env.KB_TEST_DATABASE_URL);
  assert.ok(new URL(process.env.KB_TEST_DATABASE_URL!).pathname.endsWith("_test"));
  const { db, sql } = await import("../db/client.ts");
  const s = await import("../db/schema.ts");
  const { and, eq, inArray } = await import("drizzle-orm");
  const { buildAnalyticsQuery } = await import("./analytics.ts");
  const { analyticsRoutes } = await import("../routes/analytics.ts");
  const { onError } = await import("../http.ts");
  const { hashToken } = await import("./session.ts");
  const { Hono } = await import("hono");
  const user = randomUUID(), author = randomUUID(), outsider = randomUUID(), ws = randomUUID(), foreignWs = randomUUID();
  const ids = { open: randomUUID(), own: randomUUID(), private: randomUUID(), allowed: randomUUID(), restricted: randomUUID(), trash: randomUUID(), foreign: randomUUID(), empty: randomUUID() };
  const noteIds = Object.fromEntries(["a", "b", "own", "allowed", "private", "restricted", "trash", "trashedNote", "foreign"].map(k => [k, randomUUID()]));
  const folder = randomUUID();
  const token = randomUUID();
  const now = new Date("2026-03-01T12:00:00Z");
  const recent = new Date("2026-03-01T10:00:00Z"), first = new Date("2026-02-23T00:00:00Z"), before = new Date("2026-02-22T23:59:59Z");
  const actorIds = [user, author, outsider], workspaceIds = [ws, foreignWs], allNoteIds = Object.values(noteIds);
  try {
    await db.insert(s.users).values(actorIds.map((id, i) => ({ id, email: `analytics-${id}@example.invalid`, handle: `a${id.replaceAll("-", "").slice(0, 20)}`, displayName: `统计测试${i}`, passwordHash: "not-a-login" })));
    await db.insert(s.workspaces).values([{ id: ws, slug: `analytics-${ws}`, name: "统计工作区", kind: "normal", ownerId: user }, { id: foreignWs, slug: `analytics-${foreignWs}`, name: "他人工作区", kind: "normal", ownerId: outsider }]);
    await db.insert(s.workspaceMembers).values([{ workspaceId: ws, userId: user, role: "owner" }, { workspaceId: ws, userId: author, role: "editor" }, { workspaceId: foreignWs, userId: outsider, role: "owner" }]);
    await db.insert(s.notebooks).values(Object.entries(ids).map(([key, id]) => ({
      id, workspaceId: key === "foreign" ? foreignWs : ws, slug: key, title: `${key}-notebook`,
      createdBy: key === "own" ? user : author,
      visibility: key === "private" || key === "own" ? "private" : key === "allowed" || key === "restricted" ? "restricted" : "open",
      sitePublished: key === "open", trashedAt: key === "trash" ? recent : null,
    })));
    await db.insert(s.notebookMembers).values([
      { notebookId: ids.allowed, userId: user, role: "view" },
      // private 即使残留白名单，也不能给工作区 owner 放行。
      { notebookId: ids.private, userId: user, role: "edit" },
    ]);
    await db.insert(s.folders).values([{ id: folder, workspaceId: ws, notebookId: ids.open, title: "研究" }, { workspaceId: ws, notebookId: ids.private, title: "绝密目录" }, { workspaceId: ws, notebookId: ids.open, title: "已删除目录", trashedAt: recent }]);
    const base = { workspaceId: ws, createdBy: author, updatedBy: author, createdAt: recent, updatedAt: recent };
    await db.insert(s.notes).values([
      { ...base, id: noteIds.a, notebookId: ids.open, title: "A", bodyMd: "中文📝", tags: ["红", "红", "蓝", 1], published: true },
      { ...base, id: noteIds.b, notebookId: ids.open, title: "B", bodyMd: "ab", tags: ["红"], folderId: folder, createdAt: before },
      { ...base, id: noteIds.own, notebookId: ids.own, title: "自己的私密", bodyMd: "c", createdBy: user },
      { ...base, id: noteIds.allowed, notebookId: ids.allowed, title: "已授权", bodyMd: "", createdAt: first },
      ...(["private", "restricted", "trash"] as const).map(k => ({ ...base, id: noteIds[k], notebookId: ids[k], title: `绝密-${k}`, bodyMd: "绝密正文", tags: ["绝密标签"] })),
      { ...base, id: noteIds.trashedNote, notebookId: ids.open, title: "已删除笔记", trashedAt: recent },
      { ...base, id: noteIds.foreign, workspaceId: foreignWs, notebookId: ids.foreign, title: "跨区秘密" },
    ]);
    await db.insert(s.noteVersions).values([
      ...[1, 2, 3].map(version => ({ noteId: noteIds.a!, version, title: "A", bodyMd: "无需读取", editorId: author, source: "edit", createdAt: recent })),
      { noteId: noteIds.b!, version: 2, title: "B", bodyMd: "", editorId: author, source: "edit", createdAt: first },
      { noteId: noteIds.b!, version: 1, title: "B", bodyMd: "", editorId: author, source: "create", createdAt: before },
      { noteId: noteIds.private!, version: 2, title: "绝密版本", bodyMd: "", editorId: author, source: "edit", createdAt: recent },
    ]);
    await db.insert(s.attachments).values([
      { workspaceId: ws, noteId: noteIds.a!, filename: "a.png", storedName: "unused", mime: "image/png", bytes: 23, sha256: "0".repeat(64), createdBy: author },
      { workspaceId: ws, noteId: noteIds.b!, filename: "b.pdf", storedName: "unused", mime: "application/pdf", bytes: 17, sha256: "1".repeat(64), createdBy: author },
      { workspaceId: ws, noteId: noteIds.private!, filename: "secret.pdf", storedName: "unused", mime: "application/pdf", bytes: 10000, sha256: "2".repeat(64), createdBy: author },
      { workspaceId: ws, noteId: noteIds.a!, filename: "trash.png", storedName: "unused", mime: "image/png", bytes: 10000, sha256: "3".repeat(64), createdBy: author, trashedAt: recent },
    ]);
    await db.insert(s.links).values([
      ["a", "b"], ["a", "b"], ["a", "own"], ["private", "allowed"], ["allowed", "private"], ["a", "foreign"], ["allowed", "allowed"], ["a", "trashedNote"],
    ].map(([from, to]) => ({ fromNoteId: noteIds[from!]!, targetNoteId: noteIds[to!]!, raw: "[[unused]]", state: "resolved" })));
    await db.insert(s.calendarItems).values([
      { sourceNoteId: noteIds.a, status: "done" }, { sourceNoteId: noteIds.b, status: "open" },
      { sourceNoteId: noteIds.private, status: "done" }, { sourceNoteId: noteIds.a, status: "done", linkState: "detached" },
      { sourceNoteId: noteIds.a, status: "done", source: "manual" },
    ].map(row => ({ workspaceId: ws, createdBy: author, updatedBy: author, title: "任务", kind: "task", source: "note", ...row })));
    const aggregate = async (notebookId?: string, userId = user) => (await db.execute<{ workspace: WorkspaceAnalytics["workspace"] | null; scopeValid: boolean; data: Omit<WorkspaceAnalytics, "workspace"> }>(buildAnalyticsQuery({ workspaceId: ws, userId, notebookId, days: 7, now })))[0]!;
    const row = await aggregate();
    assert.equal(row.workspace!.role, "owner");
    assert.equal(row.scopeValid, true);
    assert.deepEqual(row.data.summary, { notebooks: 4, notes: 4, folders: 1, characters: 6, attachments: 2, images: 1, attachmentBytes: 40, published: 1, created: 3, edited: 2, versions: 4, links: 2, connectedNotes: 3, isolatedNotes: 1, tasks: 2, tasksDone: 1 });
    assert.equal(row.data.trend.length, 7);
    assert.deepEqual(row.data.trend[0], { date: "2026-02-23", created: 1, edited: 1, versions: 1 });
    assert.deepEqual(row.data.trend[1], { date: "2026-02-24", created: 0, edited: 0, versions: 0 });
    assert.deepEqual(row.data.trend[6], { date: "2026-03-01", created: 2, edited: 1, versions: 3 });
    assert.deepEqual(row.data.tags.map(t => [t.title, t.notes]), [["红", 2], ["蓝", 1]]);
    assert.ok(!JSON.stringify(row).includes("绝密"));
    for (const role of ["admin", "viewer", "owner"]) {
      await db.update(s.workspaceMembers).set({ role }).where(and(eq(s.workspaceMembers.workspaceId, ws), eq(s.workspaceMembers.userId, user)));
      assert.deepEqual((await aggregate()).data.summary, row.data.summary, `${role} 不改变笔记本可见性`);
    }
    const month = (await db.execute<{ data: Omit<WorkspaceAnalytics, "workspace"> }>(buildAnalyticsQuery({ workspaceId: ws, userId: user, days: 30, now })))[0]!.data;
    assert.equal(month.trend.length, 30);
    assert.equal(month.summary.created, 4);
    assert.equal(month.summary.versions, 5);
    await db.update(s.notebooks).set({ visibility: "private" }).where(eq(s.notebooks.id, ids.open));
    const afterAclChange = (await aggregate()).data;
    assert.equal(afterAclChange.summary.notes, 2);
    assert.equal(afterAclChange.summary.links, 0);
    assert.equal(afterAclChange.summary.attachments, 0);
    assert.equal(afterAclChange.summary.tasks, 0);
    assert.equal(afterAclChange.tags.length, 0);
    assert.ok(!afterAclChange.notebooks.some(n => n.id === ids.open));
    await db.update(s.notebooks).set({ visibility: "open" }).where(eq(s.notebooks.id, ids.open));
    const own = (await aggregate(ids.own)).data;
    assert.equal(own.summary.notes, 1);
    assert.equal(own.summary.links, 1, "可读跨本连接仍计入单本");
    assert.equal(own.summary.connectedNotes, 1);
    assert.equal(own.summary.isolatedNotes, 0);
    const empty = (await aggregate(ids.empty)).data;
    assert.equal(empty.summary.notes, 0);
    assert.equal(empty.summary.notebooks, 1);
    assert.ok(empty.trend.every(d => d.created === 0 && d.edited === 0 && d.versions === 0));
    for (const id of [ids.private, ids.restricted, ids.trash, ids.foreign, randomUUID()]) assert.equal((await aggregate(id)).scopeValid, false);
    assert.equal((await aggregate(undefined, outsider)).workspace, null, "非成员即使知道 ID 也没有汇总");
    await db.insert(s.sessions).values({ userId: user, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60000) });
    const app = new Hono().onError(onError).route("/api/v1", analyticsRoutes);
    const request = (path: string, authenticated = true) => app.request(path, { headers: authenticated ? { cookie: `kb_session=${token}` } : {} });
    let response = await request(`/api/v1/workspaces/${ws}/analytics?days=7`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal((await request(`/api/v1/workspaces/${ws}/analytics`, false)).status, 401);
    assert.equal((await request(`/api/v1/workspaces/${ws}/analytics?days=365`)).status, 422);
    for (const id of [ids.private, ids.restricted, ids.trash, ids.foreign]) {
      response = await request(`/api/v1/workspaces/${ws}/analytics?notebookId=${id}`);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.ok(!(await response.text()).includes(id));
    }
    await db.delete(s.notebookMembers).where(and(eq(s.notebookMembers.notebookId, ids.allowed), eq(s.notebookMembers.userId, user)));
    assert.equal((await aggregate()).data.summary.notes, 3, "撤销本级成员后立即失效");
    await db.delete(s.workspaceMembers).where(and(eq(s.workspaceMembers.workspaceId, ws), eq(s.workspaceMembers.userId, user)));
    assert.equal((await request(`/api/v1/workspaces/${ws}/analytics`)).status, 404);
  } finally {
    await db.delete(s.sessions).where(inArray(s.sessions.userId, actorIds));
    await db.delete(s.calendarItems).where(inArray(s.calendarItems.workspaceId, workspaceIds));
    await db.delete(s.links).where(inArray(s.links.fromNoteId, allNoteIds));
    await db.delete(s.attachments).where(inArray(s.attachments.workspaceId, workspaceIds));
    await db.delete(s.noteVersions).where(inArray(s.noteVersions.noteId, allNoteIds));
    await db.delete(s.notes).where(inArray(s.notes.workspaceId, workspaceIds));
    await db.delete(s.folders).where(inArray(s.folders.workspaceId, workspaceIds));
    await db.delete(s.notebookMembers).where(inArray(s.notebookMembers.notebookId, Object.values(ids)));
    await db.delete(s.notebooks).where(inArray(s.notebooks.workspaceId, workspaceIds));
    await db.delete(s.workspaceMembers).where(inArray(s.workspaceMembers.workspaceId, workspaceIds));
    await db.delete(s.workspaces).where(inArray(s.workspaces.id, workspaceIds));
    await db.delete(s.users).where(inArray(s.users.id, actorIds));
    await sql.end();
  }
});
