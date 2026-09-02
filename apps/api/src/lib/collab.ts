/**
 * 协同编辑的房间（设计 17 §3.4）。
 *
 * CRDT 只做「在线这一层」：房间活着的时候大家在 Y.Text 上收敛，
 * 落库仍然回 `notes.body_md` + `note_versions`。所以搜索、导出、MCP、行级 diff、
 * `expected_version` 全都不用改——这是选这个分层的全部理由。
 */
import { and, eq } from "drizzle-orm";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import type { WebSocket } from "ws";
import { db } from "../db/client.ts";
import { noteCollab, notes } from "../db/schema.ts";
import { writeNoteFile } from "./files.ts";
import { rebuildLinks } from "./links.ts";
import { externalChange } from "./collab-text.ts";
import { nextNoteSavedAt } from "./note-save.ts";
import { recordNoteVersion } from "./versions.ts";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** 有改动后 3 秒静默落一次，最多拖 15 秒；房间关掉时无条件再落一次。 */
const SAVE_DEBOUNCE_MS = 3_000;
const SAVE_MAX_MS = 15_000;
/** 最后一个人走了还留 30 秒——刷新页面不该把房间状态丢掉。 */
const LINGER_MS = 30_000;
/** 攒够这么多个 update 就把快照压实一次，别让 note_collab 无限长胖。 */
const COMPACT_EVERY = 200;
/** 开着的房间每 5 秒探一次 notes.version，好把 MCP / AI / 恢复版本的改动接进来。 */
const WATCH_MS = 5_000;

export type Conn = WebSocket & { readOnly?: boolean; userId?: string };

type Room = {
  noteId: string;
  doc: Y.Doc;
  text: Y.Text;
  awareness: awarenessProtocol.Awareness;
  conns: Map<Conn, Set<number>>;
  /** 房间上一次亲手写进 DB 的正文，用来认「外面有人改过」。 */
  lastPersisted: string;
  dirty: boolean;
  updates: number;
  lastEditor: string | null;
  /** 房间见过的最新 notes.version。它一变就说明有人从外面改了正文。 */
  lastVersion: number;
  saveTimer: NodeJS.Timeout | null;
  maxTimer: NodeJS.Timeout | null;
  lingerTimer: NodeJS.Timeout | null;
  watchTimer: NodeJS.Timeout | null;
};

const rooms = new Map<string, Room>();

/** 测试与验收要看房间数；生产里没人调。 */
export const roomCount = () => rooms.size;

function send(conn: Conn, data: Uint8Array) {
  if (conn.readyState !== 1) return;
  try { conn.send(data); } catch { try { conn.close(); } catch { /* 已经断了 */ } }
}

function broadcast(room: Room, data: Uint8Array, except?: Conn) {
  for (const conn of room.conns.keys()) if (conn !== except) send(conn, data);
}

async function loadRoom(noteId: string, initial: { bodyMd: string; version: number }): Promise<Room> {
  const initialBody = initial.bodyMd;
  const doc = new Y.Doc();
  const [snapshot] = await db.select().from(noteCollab).where(eq(noteCollab.noteId, noteId));
  if (snapshot?.state) {
    try { Y.applyUpdate(doc, Buffer.from(snapshot.state, "base64")); }
    catch { /* 快照是可丢的缓存，坏了就从正文重来 */ }
  }
  const text = doc.getText("body");
  // 快照落后于 DB（房间关着的时候别人改了），或压根没有快照：以 notes.body_md 为准
  if (text.toString() !== initialBody) {
    const patch = externalChange(text.toString(), initialBody, snapshot?.bodyMd ?? "");
    doc.transact(() => {
      if (patch) {
        if (patch.remove) text.delete(patch.at, patch.remove);
        if (patch.insert) text.insert(patch.at, patch.insert);
      } else if (text.toString() !== initialBody) {
        text.delete(0, text.length);
        text.insert(0, initialBody);
      }
    }, "server");
  }

  const room: Room = {
    noteId, doc, text,
    awareness: new awarenessProtocol.Awareness(doc),
    conns: new Map(),
    lastPersisted: initialBody,
    dirty: false,
    updates: snapshot?.updates ?? 0,
    lastEditor: null,
    lastVersion: initial.version,
    saveTimer: null, maxTimer: null, lingerTimer: null, watchTimer: null,
  };
  room.awareness.setLocalState(null);

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    broadcast(room, encoding.toUint8Array(encoder), origin instanceof Object && "readyState" in (origin as object) ? origin as Conn : undefined);
    if (origin === "server") return;                 // 回灌不算「有人改了」，别把外部写又原样写回去
    room.dirty = true;
    room.updates++;
    scheduleSave(room);
  });

  room.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    const changed = [...added, ...updated, ...removed];
    for (const [conn, ids] of room.conns) {
      if (conn !== origin) continue;
      for (const id of added) ids.add(id);
      for (const id of removed) ids.delete(id);
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed));
    broadcast(room, encoding.toUint8Array(encoder));
  });

  rooms.set(noteId, room);
  return room;
}

/**
 * 落库失败不能把进程带走。房间是定时器驱动的，一个未捕获的 rejection 会直接
 * 打死整个 api 进程——那比丢一次自动保存严重得多。记一笔，等下一轮再落。
 */
function saveFailed(e: unknown) {
  console.error("collab persist failed:", e instanceof Error ? e.message : e);
}

function scheduleSave(room: Room) {
  if (room.saveTimer) clearTimeout(room.saveTimer);
  room.saveTimer = setTimeout(() => void persist(room).catch(saveFailed), SAVE_DEBOUNCE_MS);
  // 一直有人在打字的话防抖永远不触发，所以再压一个「最多拖这么久」的闸
  room.maxTimer ??= setTimeout(() => void persist(room).catch(saveFailed), SAVE_MAX_MS);
}

function clearTimers(room: Room) {
  if (room.saveTimer) clearTimeout(room.saveTimer);
  if (room.maxTimer) clearTimeout(room.maxTimer);
  room.saveTimer = null;
  room.maxTimer = null;
}

/**
 * 落库。房间自己就是这段时间里唯一的写者（所有人的输入都先在 CRDT 里合过一遍），
 * 所以这里等价于 §5.2 的 `force=true`，不会盖掉别人——除非真有人从外面改了，
 * 那种情况先把差异回灌进 Y.Text 再落。
 */
export async function persist(room: Room) {
  clearTimers(room);
  const [note] = await db.select().from(notes).where(eq(notes.id, room.noteId));
  if (!note || note.trashedAt) return;

  // 落之前再确认一次外面没人插队；平时靠 pullExternal 的轮询，这里是兜底
  if (note.version !== room.lastVersion) await pullExternal(room);

  const text = room.text.toString();
  const saveAttempted = room.dirty;
  const changed = saveAttempted && text !== note.bodyMd;
  room.dirty = false;

  if (changed) {
    const editor = room.lastEditor ?? note.updatedBy;
    // 带上版本条件：房间不是唯一会写 notes 的人——改标题、改标签、AI 接受都会照常 PATCH。
    // 不带条件就会和它们抢同一个 version，插版本快照时撞唯一键。抢输了就等下一轮，不硬来。
    const [saved] = await db.update(notes)
      .set({ bodyMd: text, version: note.version + 1, updatedBy: editor, updatedAt: new Date() })
      .where(and(eq(notes.id, note.id), eq(notes.version, note.version))).returning();
    if (!saved) { room.dirty = true; scheduleSave(room); return; }
    await recordNoteVersion(db, {
      noteId: note.id,
      version: saved.version,
      previousVersion: note.version,
      title: saved.title,
      bodyMd: saved.bodyMd,
      editorId: editor,
      source: "collab",
      matchEditor: false,
    });
    await writeNoteFile({ ...saved, noteId: saved.id });
    await rebuildLinks(saved.id, saved.workspaceId, saved.bodyMd);
    room.lastPersisted = text;
    // 记下自己写出去的版本号，免得下一轮轮询把自己的写当成「外面有人改了」
    room.lastVersion = saved.version;
  } else if (saveAttempted) {
    // 输入后又撤回原文时，Y.Text 确实发生过一次保存，但正文与当前版本完全相同。
    // 只推进最后保存时间，不制造一个内容相同的新版本。
    const [touched] = await db.update(notes)
      .set({ updatedAt: nextNoteSavedAt(note.updatedAt) })
      .where(and(eq(notes.id, note.id), eq(notes.version, note.version))).returning({ id: notes.id });
    if (!touched) { room.dirty = true; scheduleSave(room); return; }
  }

  // 快照按更新数压实：Y.encodeStateAsUpdate 重写一份，而不是无限追加
  const state = Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString("base64");
  const values = { noteId: room.noteId, state, updates: room.updates >= COMPACT_EVERY ? 0 : room.updates, bodyMd: room.lastPersisted, updatedAt: new Date() };
  if (room.updates >= COMPACT_EVERY) room.updates = 0;
  await db.insert(noteCollab).values(values).onConflictDoUpdate({ target: noteCollab.noteId, set: values });
}

/**
 * 把外面直接改的正文接进房间。MCP / AI / 恢复历史版本走的都是 notes 那条路，
 * 房间自己不会收到任何通知，所以只能盯着 version。
 */
async function pullExternal(room: Room) {
  const [note] = await db.select({ version: notes.version, bodyMd: notes.bodyMd, trashedAt: notes.trashedAt })
    .from(notes).where(eq(notes.id, room.noteId));
  if (!note || note.trashedAt || note.version === room.lastVersion) return;
  room.lastVersion = note.version;
  const patch = externalChange(room.text.toString(), note.bodyMd, room.lastPersisted);
  if (!patch) { room.lastPersisted = note.bodyMd; return; }
  // 整段替换会让正在打字的人丢光标，还会把他刚敲的半句一起冲掉
  room.doc.transact(() => {
    if (patch.remove) room.text.delete(patch.at, patch.remove);
    if (patch.insert) room.text.insert(patch.at, patch.insert);
  }, "server");
  room.lastPersisted = note.bodyMd;
}

/** 进房。`initial` 只在房间还没建起来时用得上。 */
export async function joinRoom(noteId: string, initial: { bodyMd: string; version: number }) {
  const existing = rooms.get(noteId);
  if (existing) {
    if (existing.lingerTimer) { clearTimeout(existing.lingerTimer); existing.lingerTimer = null; }
    return existing;
  }
  const room = await loadRoom(noteId, initial);
  room.watchTimer = setInterval(() => void pullExternal(room).catch(() => {}), WATCH_MS);
  return room;
}

export function attachConnection(room: Room, conn: Conn) {
  room.conns.set(conn, new Set());

  // 先把自己的状态推过去：syncStep1 + 当前 awareness
  const sync = encoding.createEncoder();
  encoding.writeVarUint(sync, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(sync, room.doc);
  send(conn, encoding.toUint8Array(sync));

  const states = room.awareness.getStates();
  if (states.size) {
    const aw = encoding.createEncoder();
    encoding.writeVarUint(aw, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]));
    send(conn, encoding.toUint8Array(aw));
  }

  conn.on("message", (data: ArrayBufferLike | Buffer) => handleMessage(room, conn, new Uint8Array(data as ArrayBufferLike)));
  conn.on("close", () => void detach(room, conn));
  conn.on("error", () => void detach(room, conn));
}

export function handleMessage(room: Room, conn: Conn, data: Uint8Array) {
  try {
    const decoder = decoding.createDecoder(data);
    const encoder = encoding.createEncoder();
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const sub = decoding.readVarUint(decoder);
      if (sub === syncProtocol.messageYjsSyncStep1) {
        syncProtocol.readSyncStep1(decoder, encoder, room.doc);
        if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder));
        return;
      }
      // 只读连接收得到别人的光标，但发不出自己的更新。丢在服务端，不靠前端自觉。
      if (conn.readOnly) return;
      if (sub === syncProtocol.messageYjsSyncStep2) syncProtocol.readSyncStep2(decoder, room.doc, conn);
      else if (sub === syncProtocol.messageYjsUpdate) syncProtocol.readUpdate(decoder, room.doc, conn);
      if (conn.userId) room.lastEditor = conn.userId;
      return;
    }
    if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), conn);
    }
  } catch {
    // 一条坏帧不该带走整个房间：丢掉它，让这个连接自己重连
  }
}

async function detach(room: Room, conn: Conn) {
  const ids = room.conns.get(conn);
  if (!ids) return;
  room.conns.delete(conn);
  awarenessProtocol.removeAwarenessStates(room.awareness, [...ids], null);
  try { conn.close(); } catch { /* 已经断了 */ }
  if (room.conns.size) return;

  // 最后一个人走了：先落一次，再留 30 秒等他刷新回来
  await persist(room).catch(() => {});
  room.lingerTimer = setTimeout(() => {
    if (room.conns.size) return;
    rooms.delete(room.noteId);
    clearTimers(room);
    if (room.watchTimer) clearInterval(room.watchTimer);
    room.watchTimer = null;
    room.awareness.destroy();
    room.doc.destroy();
  }, LINGER_MS);
}

/** 进程退出前把所有房间落一遍，别让最后几秒的输入随进程一起消失。 */
export async function flushAllRooms() {
  for (const room of [...rooms.values()]) await persist(room).catch(() => {});
}

export type { Room };
