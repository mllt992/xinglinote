/**
 * 协同编辑的客户端（设计 17 §3.4）。
 *
 * 连不上、被拒、或浏览器不支持 WebSocket 时**静默退回单机自动保存**，
 * 底栏标一行「离线编辑」就够了——不弹窗、不拦人写字。
 */
import { Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

export type CollabStatus = "connecting" | "connected" | "offline";
export type CollabPeer = { id: string; name: string; color: string; editing: boolean };
export type CollabUser = { id: string; name: string };

/**
 * 颜色由 user_id 定，不是由「第几个进房的人」定：
 * 同一个人在任何一篇里都得是同一个颜色，否则换篇笔记就要重新认人。
 */
const PALETTE = ["#2563eb", "#7c3aed", "#0f766e", "#c2410c", "#be123c", "#4d7c0f", "#0369a1", "#a16207"];
export function userColor(userId: string) {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export type CollabSession = {
  extension: Extension;
  text: Y.Text;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  destroy: () => void;
};

const FAILURE_LIMIT = 3;
const RETRY_COOLDOWN_MS = 30_000;

type ReconnectActions = {
  pause: () => void;
  resume: () => void;
  offline: () => void;
  connecting: () => void;
};

/**
 * y-websocket 会在断线后自行退避重连。连续失败太多时把它暂停一会儿，既避免无权连接
 * 热循环打服务端，也不会像原实现那样永久离线。pause 只能翻 shouldConnect，绝不能在
 * connection-close 回调里同步 disconnect：provider 尚未把 ws 清空，那会再次 emit 同一
 * 个事件并无限递归。
 */
export function createReconnectController(actions: ReconnectActions, options: {
  failureLimit?: number;
  cooldownMs?: number;
} = {}) {
  const failureLimit = options.failureLimit ?? FAILURE_LIMIT;
  const cooldownMs = options.cooldownMs ?? RETRY_COOLDOWN_MS;
  let failures = 0;
  let coolingDown = false;
  let destroyed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    closed() {
      if (destroyed || coolingDown || ++failures < failureLimit) return;
      coolingDown = true;
      actions.pause();
      actions.offline();
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (destroyed) return;
        failures = 0;
        coolingDown = false;
        actions.connecting();
        actions.resume();
      }, cooldownMs);
    },
    synced() {
      failures = 0;
      coolingDown = false;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    },
    isCoolingDown: () => coolingDown,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
    },
  };
}

/** 只让 y-codemirror 后续注册的本地 origin 进入历史，不跟踪补种与远端同步。 */
export function createEditorUndoManager(text: Y.Text) {
  return new Y.UndoManager(text, { trackedOrigins: new Set() });
}

/** 20 秒没心跳的 awareness 条目会被 y-protocols 自己清掉，这里只负责读。 */
function peersOf(provider: WebsocketProvider, selfId: string): CollabPeer[] {
  const out = new Map<string, CollabPeer>();
  for (const [clientId, state] of provider.awareness.getStates()) {
    const user = (state as { user?: { id?: string; name?: string; color?: string } }).user;
    if (!user?.id || user.id === selfId) continue;
    const editing = clientId !== provider.awareness.clientID && !!(state as { cursor?: unknown }).cursor;
    const prev = out.get(user.id);
    out.set(user.id, { id: user.id, name: user.name ?? "协作者", color: user.color ?? userColor(user.id), editing: editing || !!prev?.editing });
  }
  return [...out.values()];
}

export function createCollab(noteId: string, user: CollabUser, on: {
  status: (s: CollabStatus) => void;
  peers: (list: CollabPeer[]) => void;
  /** 首次同步完成。**在这之前绝不能把 yCollab 挂上去**：那时 Y.Text 还是空的，
   *  挂上去会先把编辑器清空一下，同步失败时甚至会让人对着空文档打字。 */
  synced: (text: Y.Text) => void;
}): CollabSession | null {
  if (typeof WebSocket === "undefined") return null;
  const doc = new Y.Doc();
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // y-websocket 的房间名会被拼到 URL 尾部，正好凑出 /api/v1/notes/<id>/collab
  const provider = new WebsocketProvider(`${proto}//${location.host}/api/v1/notes`, `${noteId}/collab`, doc, { connect: true });

  const color = userColor(user.id);
  provider.awareness.setLocalStateField("user", { id: user.id, name: user.name, color, colorLight: `${color}22` });

  const pushPeers = () => on.peers(peersOf(provider, user.id));
  provider.awareness.on("change", pushPeers);
  const reconnect = createReconnectController({
    // connection-close 是在 y-websocket 清空 provider.ws 之前发出的。这里只关掉后续重连，
    // 让当前 close 流程自然走完；同步调用 disconnect 会重入 connection-close。
    pause: () => { provider.shouldConnect = false; },
    resume: () => provider.connect(),
    offline: () => { on.status("offline"); on.peers([]); },
    connecting: () => on.status("connecting"),
  });
  const handleStatus = ({ status }: { status: string }) => {
    on.status(status === "connected" ? "connected" : reconnect.isCoolingDown() ? "offline" : "connecting");
    pushPeers();
  };
  const handleClose = () => reconnect.closed();
  provider.on("status", handleStatus);
  provider.on("connection-close", handleClose);

  const text = doc.getText("body");
  // 默认 trackedOrigins 含 null，而首次给空房间补种现有正文正是 null origin。
  // 从空集合起步，让 y-codemirror 挂载时只注册自己的本地编辑 origin，
  // 否则工具栏第一次点「撤销」可能把整篇初始正文清空。
  const undoManager = createEditorUndoManager(text);
  const handleSync = (isSynced: boolean) => {
    if (!isSynced) return;
    reconnect.synced();
    on.synced(text);
  };
  provider.on("sync", handleSync);
  let destroyed = false;
  return {
    // yCollab 自带远端光标与选区的渲染，样式在 styles.css 里覆盖成我们的口径。
    //
    // **撤销必须换成 Y.UndoManager 那一套**：yCollab 把远端改动 dispatch 进来时没标
    // `addToHistory: false`，CodeMirror 自己的 history 会把别人敲的字也记进本地撤销栈——
    // 那时按 Ctrl+Z 撤的是同事的句子，而且撤销结果还会经 CRDT 广播出去，等于替所有人回滚。
    // 所以宿主在挂上这个扩展的同时会把 history() 换成空扩展（markdown-editor.tsx），
    // 键位由这里的 keymap 接管。Prec.high 是为了盖住下面那套 historyKeymap。
    extension: [yCollab(text, provider.awareness, { undoManager }), Prec.high(keymap.of(yUndoManagerKeymap))],
    text,
    undo: () => { undoManager.undo(); },
    redo: () => { undoManager.redo(); },
    canUndo: () => undoManager.undoStack.length > 0,
    canRedo: () => undoManager.redoStack.length > 0,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      reconnect.destroy();
      provider.awareness.off("change", pushPeers);
      // provider.destroy() 会同步发 connection-close/status；必须先解绑自己的监听器，
      // 否则卸载期间仍可能更新 React，或把正常销毁误计成一次连接失败。
      provider.off("status", handleStatus);
      provider.off("connection-close", handleClose);
      provider.off("sync", handleSync);
      provider.destroy();
      undoManager.destroy();
      doc.destroy();
    },
  };
}
