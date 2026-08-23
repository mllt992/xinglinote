import assert from "node:assert/strict";
import test from "node:test";
import { assertBackupObjectName, checksum, encryptPackage, estimatedRestoreBytes, inspectBackupPackage } from "./backup-package.ts";

const ws = "11111111-1111-4111-8111-111111111111";
const nb = "22222222-2222-4222-8222-222222222222";
const note = "33333333-3333-4333-8333-333333333333";
const attachment = "44444444-4444-4444-8444-444444444444";
const user = "55555555-5555-4555-8555-555555555555";
const group = "66666666-6666-4666-8666-666666666666";
const nav = "77777777-7777-4777-8777-777777777777";
const file = Buffer.from("附件正文");

function workspacePackage(version = 4) {
  return {
    format: "knowledge-workspace-backup",
    version,
    exportedAt: "2026-08-24T00:00:00.000Z",
    workspace: { id: ws, name: "演练库", slug: "drill" },
    members: [],
    notebooks: [{ id: nb, workspaceId: ws }],
    notebookMembers: [],
    folders: [],
    notes: [{ id: note, workspaceId: ws, notebookId: nb, folderId: null }],
    attachments: [{ id: attachment, workspaceId: ws, noteId: note, bytes: file.length, sha256: checksum(file) }],
    attachmentFiles: version === 4 ? [{ attachmentId: attachment, bytes: file.length, sha256: checksum(file), dataBase64: file.toString("base64") }] : [],
    versions: [], shares: [], comments: [], corrections: [], posts: [], postAssets: [], postAssetFiles: [], reactions: [],
    calendarItems: [], calendarOverrides: [], calendarReminders: [], calendarSubscriptions: [], calendarTemplates: [], calendarFeedTokens: [],
  };
}

function instancePackage() {
  return {
    format: "knowledge-instance-backup",
    version: 1,
    exportedAt: "2026-08-24T00:00:00.000Z",
    settings: null,
    users: [{ id: user }],
    serviceRequests: [], registrationCodes: [], registrationCodeUsages: [], savedShares: [],
    posts: [], postAssets: [], postAssetFiles: [], reactions: [], comments: [], moderationReviews: [], contentReports: [],
    themes: [],
    navGroups: [{ id: group }],
    navLinks: [{ id: nav, groupId: group, createdBy: user }],
    agents: [], workspaces: [],
  };
}

test("v4 工作区包校验格式、关系、附件和 checksum", () => {
  const raw = Buffer.from(JSON.stringify(workspacePackage()));
  const inspected = inspectBackupPackage(raw, { expectedChecksum: checksum(raw) });
  assert.equal(inspected.compatible, true);
  assert.equal(inspected.checksumVerified, true);
  assert.equal(inspected.counts.notes, 1);
  assert.equal(inspected.counts.attachmentFiles, 1);
  assert.ok(estimatedRestoreBytes(inspected.snapshot) >= file.length * 2);
});

test("加密包错误口令、损坏附件和未知版本均在预检阶段拒绝", () => {
  const plain = Buffer.from(JSON.stringify(workspacePackage()));
  const encrypted = encryptPackage(plain, "correct-passphrase");
  assert.throws(() => inspectBackupPackage(encrypted, { passphrase: "wrong" }), /解密失败/);
  const damaged = workspacePackage();
  damaged.attachmentFiles[0]!.dataBase64 = Buffer.from("被篡改").toString("base64");
  assert.throws(() => inspectBackupPackage(Buffer.from(JSON.stringify(damaged))), /附件.*不一致/);
  assert.throws(() => inspectBackupPackage(Buffer.from(JSON.stringify({ ...workspacePackage(), version: 99 }))), /Invalid input/);
});

test("断裂引用和对象路径穿越被拒绝", () => {
  const broken = workspacePackage();
  broken.notes[0]!.notebookId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.throws(() => inspectBackupPackage(Buffer.from(JSON.stringify(broken))), /不存在的资源/);
  assert.equal(assertBackupObjectName("workspace-2026.kbbackup"), "workspace-2026.kbbackup");
  assert.throws(() => assertBackupObjectName("../secret.kbbackup"), /路径不合法/);
  assert.throws(() => assertBackupObjectName("https://example.com/x.kbbackup"), /路径不合法/);
});

test("v3 包可迁移预检但明确警告附件缺失", () => {
  const inspected = inspectBackupPackage(Buffer.from(JSON.stringify(workspacePackage(3))));
  assert.match(inspected.warnings.join("\n"), /v3 包不含附件二进制/);
});

test("实例包严格校验 UUID 与包内引用", () => {
  assert.equal(inspectBackupPackage(Buffer.from(JSON.stringify(instancePackage()))).compatible, true);
  const broken = instancePackage();
  broken.navLinks[0]!.groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.throws(() => inspectBackupPackage(Buffer.from(JSON.stringify(broken))), /不存在的资源/);
});
