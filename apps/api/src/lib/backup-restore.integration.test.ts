import assert from "node:assert/strict";
import test, { after } from "node:test";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { attachments, folders, mindMapNoteLinks, mindMaps, mindMapVersions, notebooks, notes, noteVersions, users, workspaceMembers, workspaces } from "../db/schema.ts";
import { noteIdFromHref, noteLinkHref, type DrawioData, type MindMapData } from "@kb/shared";
import { instanceSnapshot, workspaceSnapshot } from "./backup.ts";
import { inspectBackupPackage } from "./backup-package.ts";
import { restoreInstanceMetadata, restoreWorkspacePackage, verifyRestoredWorkspace } from "./backup-restore.ts";
import { putBlob, readStoredFile } from "./blobs.ts";

after(() => db.$client.end());

test("工作区 v4 新建恢复、替换恢复、演练回滚和中途失败回滚", { skip: process.env.RUN_DB_TESTS !== "1" }, async () => {
  const [actor] = await db.insert(users).values({ email: `restore-${crypto.randomUUID()}@test.local`, passwordHash: "test", handle: `restore-${crypto.randomUUID().slice(0, 8)}`, displayName: "恢复测试" }).returning();
  const [source] = await db.insert(workspaces).values({ slug: `source-${crypto.randomUUID()}`, name: "源工作区", kind: "normal", ownerId: actor.id }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: source.id, userId: actor.id, role: "owner" });
  const [notebook] = await db.insert(notebooks).values({ workspaceId: source.id, slug: "docs", title: "文档", createdBy: actor.id }).returning();
  const [folder] = await db.insert(folders).values({ workspaceId: source.id, notebookId: notebook.id, title: "目录" }).returning();
  const [note] = await db.insert(notes).values({ workspaceId: source.id, notebookId: notebook.id, folderId: folder.id, title: "恢复正文", bodyMd: "# 标题\n附件与双链 [[恢复正文]]", createdBy: actor.id, updatedBy: actor.id }).returning();
  await db.insert(noteVersions).values({ noteId: note.id, version: 1, title: note.title, bodyMd: note.bodyMd, editorId: actor.id, source: "test" });
  const rawFile = Buffer.from("restore attachment bytes");
  const ref = await putBlob(rawFile);
  await db.insert(attachments).values({ workspaceId: source.id, noteId: note.id, filename: "proof.txt", storedName: ref.path, mime: "text/plain", bytes: ref.bytes, sha256: ref.sha256, createdBy: actor.id });
  // 思维导图（节点关联笔记）+ 画板（整图关联笔记）+ 历史版本 + 回收站状态都要进备份（设计 25）。
  const mapData: MindMapData = { format: 2, layout: "logicalStructure", theme: { template: "default", config: {} }, root: { data: { text: "导图", uid: "root" }, children: [{ data: { text: "指向笔记", uid: "n1", hyperlink: noteLinkHref(note.id) }, children: [] }] } };
  const [map] = await db.insert(mindMaps).values({ notebookId: notebook.id, kind: "mindmap", title: "导图", data: mapData, searchText: "导图 指向笔记", version: 2, createdBy: actor.id, updatedBy: actor.id }).returning();
  await db.insert(mindMapNoteLinks).values({ mindMapId: map.id, noteId: note.id, nodeId: "n1" });
  await db.insert(mindMapVersions).values([{ mindMapId: map.id, version: 1, title: "导图", data: mapData, editorId: actor.id, source: "create" }, { mindMapId: map.id, version: 2, title: "导图", data: mapData, editorId: actor.id, source: "edit" }]);
  const drawData: DrawioData = { format: "drawio", xml: '<mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>', noteIds: [note.id] };
  await db.insert(mindMaps).values({ notebookId: notebook.id, kind: "drawio", title: "画板", data: drawData, searchText: "画板", createdBy: actor.id, updatedBy: actor.id, trashedAt: new Date(), trashedBy: actor.id });

  const raw = Buffer.from(JSON.stringify(await workspaceSnapshot(source.id)));
  const inspected = inspectBackupPackage(raw);
  assert.equal(inspected.snapshot.format, "knowledge-workspace-backup");

  const created = await restoreWorkspacePackage({ snapshot: inspected.snapshot, actorId: actor.id, mode: "new_workspace" });
  assert.ok(created.workspaceId && created.workspaceId !== source.id);
  await verifyRestoredWorkspace(created.workspaceId!, inspected.snapshot);
  const [restoredAttachment] = await db.select().from(attachments).where(eq(attachments.workspaceId, created.workspaceId!));
  assert.deepEqual(await readStoredFile(restoredAttachment), rawFile);
  const [restoredNote] = await db.select().from(notes).where(eq(notes.workspaceId, created.workspaceId!));
  const [restoredNb] = await db.select().from(notebooks).where(eq(notebooks.workspaceId, created.workspaceId!));
  const boards = await db.select().from(mindMaps).where(eq(mindMaps.notebookId, restoredNb!.id));
  assert.equal(boards.length, 2);
  const rMap = boards.find(b => b.kind === "mindmap")!, rDraw = boards.find(b => b.kind === "drawio")!;
  assert.ok(rMap.id !== map.id);
  assert.equal(noteIdFromHref((rMap.data as MindMapData).root.children[0]!.data.hyperlink), restoredNote!.id, "导图里的 #note: 链接映射到恢复后的笔记");
  assert.deepEqual((rDraw.data as DrawioData).noteIds, [restoredNote!.id], "画板关联的笔记也映射");
  assert.ok(rDraw.trashedAt, "回收站状态保留");
  const rLinks = await db.select().from(mindMapNoteLinks).where(eq(mindMapNoteLinks.noteId, restoredNote!.id));
  assert.equal(rLinks.length, 2, "关联表按数据重建");
  const rVersions = await db.select().from(mindMapVersions).where(eq(mindMapVersions.mindMapId, rMap.id));
  assert.equal(rVersions.length, 2, "历史版本一并恢复");
  assert.equal(noteIdFromHref((rVersions[0]!.data as MindMapData).root.children[0]!.data.hyperlink), restoredNote!.id);

  const beforeDrill = await db.select({ id: workspaces.id }).from(workspaces);
  const drill = await restoreWorkspacePackage({ snapshot: inspected.snapshot, actorId: actor.id, mode: "new_workspace", drill: true });
  assert.equal(drill.workspaceId, null);
  assert.equal((await db.select({ id: workspaces.id }).from(workspaces)).length, beforeDrill.length);

  const [target] = await db.insert(workspaces).values({ slug: `target-${crypto.randomUUID()}`, name: "替换目标", kind: "normal", ownerId: actor.id }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: target.id, userId: actor.id, role: "owner" });
  const [oldNotebook] = await db.insert(notebooks).values({ workspaceId: target.id, slug: "old", title: "旧本", createdBy: actor.id }).returning();
  await db.insert(notes).values({ workspaceId: target.id, notebookId: oldNotebook.id, title: "应删除", bodyMd: "旧正文", createdBy: actor.id, updatedBy: actor.id });
  await restoreWorkspacePackage({ snapshot: inspected.snapshot, actorId: actor.id, mode: "replace_workspace", targetWorkspaceId: target.id });
  const replaced = await db.select().from(notes).where(eq(notes.workspaceId, target.id));
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0]?.title, "恢复正文");

  const broken = structuredClone(inspected.snapshot);
  delete broken.notes[0]!.title;
  const workspaceCount = (await db.select({ id: workspaces.id }).from(workspaces)).length;
  await assert.rejects(() => restoreWorkspacePackage({ snapshot: broken, actorId: actor.id, mode: "new_workspace" }));
  assert.equal((await db.select({ id: workspaces.id }).from(workspaces)).length, workspaceCount);

  const instance = inspectBackupPackage(Buffer.from(JSON.stringify(await instanceSnapshot())));
  assert.equal(instance.snapshot.format, "knowledge-instance-backup");
  const usersBeforeDrill = (await db.select({ id: users.id }).from(users)).length;
  const instanceDrill = await restoreInstanceMetadata({ snapshot: instance.snapshot, actorId: actor.id, mode: "replace_instance_metadata", drill: true });
  assert.equal(instanceDrill.stats.users, usersBeforeDrill);
  assert.equal((await db.select({ id: users.id }).from(users)).length, usersBeforeDrill);
  const instanceRestore = await restoreInstanceMetadata({ snapshot: instance.snapshot, actorId: actor.id, mode: "replace_instance_metadata" });
  assert.equal(instanceRestore.stats.users, usersBeforeDrill);

  // 只删本测试自己的源工作区成员，临时数据库容器结束时会整体销毁其余恢复数据。
  assert.ok((await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, source.id), eq(workspaceMembers.userId, actor.id)))).length === 1);
});
