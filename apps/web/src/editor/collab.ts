/**
 * 协同编辑的客户端（设计 17 §3.4）。
 *
 * 连不上、被拒、或浏览器不支持 WebSocket 时**静默退回单机自动保存**，
 * 底栏标一行「离线编辑」就够了——不弹窗、不拦人写字。
 */
import type { Extension } from "@codemirror/state";
import { yCollab } from "y-codemirror.next";
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
  destroy: () => void;
};

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
  provider.on("status", ({ status }: { status: string }) => {
    on.status(status === "connected" ? "connected" : "connecting");
    pushPeers();
  });
  // 服务端拒了升级（404）时 y-websocket 会一直退避重连；连不上就当离线，别把编辑器吊死
  let failures = 0;
  provider.on("connection-close", () => { if (++failures >= 3) { provider.disconnect(); on.status("offline"); on.peers([]); } });
  provider.on("connection-error", () => { if (++failures >= 3) { provider.disconnect(); on.status("offline"); on.peers([]); } });

  const text = doc.getText("body");
  provider.on("sync", (isSynced: boolean) => { if (isSynced) on.synced(text); });
  return {
    // yCollab 自带远端光标与选区的渲染，样式在 styles.css 里覆盖成我们的口径
    extension: yCollab(text, provider.awareness),
    text,
    destroy: () => {
      provider.awareness.off("change", pushPeers);
      provider.destroy();
      doc.destroy();
    },
  };
}
