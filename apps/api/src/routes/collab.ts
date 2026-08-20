/**
 * 协同房间的 WebSocket 入口（架构 03；设计 17 §3.4）。
 *
 * 鉴权在**升级之前**做完：能编辑给 write，只能读给 read（收得到光标、发不出更新），
 * 读都不能读直接拒——而且拒的时候不透露这篇笔记存不存在。
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";

import { db } from "../db/client.ts";
import { notes } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import { attachConnection, flushAllRooms, joinRoom, type Conn } from "../lib/collab.ts";
import { noteAccess } from "../lib/note-access.ts";
import { userFromCookieHeader } from "../lib/session.ts";
import { env } from "../env.ts";

const PATH = /^\/api\/v1\/notes\/([0-9a-f-]{36})\/collab$/;

function deny(socket: Duplex, code: number, text: string) {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/** 决定这条连接能不能进、以什么身份进。返回 null = 拒。 */
async function authorize(req: IncomingMessage, noteId: string) {
  // Origin 校验：SameSite=Lax 已经让浏览器不给跨站 WS 握手带 cookie，
  // 但那是单点依赖。同源判断成本几乎为零，多一层不亏（CSWSH）。
  const origin = req.headers.origin;
  if (origin && origin !== new URL(env.publicUrl).origin) return null;
  const user = await userFromCookieHeader(req.headers.cookie);
  if (!user) return null;
  // 能编辑就 write；不能编辑（viewer / 只读笔记本 / 工作区冻结）不等于不能看，往下退一档
  try { await noteAccess(noteId, user.id, "edit"); return { user, readOnly: false }; }
  catch { /* 落到只读 */ }
  try { await noteAccess(noteId, user.id, "read"); return { user, readOnly: true }; }
  catch { return null; }
}

export function attachCollab(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const hit = PATH.exec(new URL(req.url ?? "/", "http://x").pathname);
    if (!hit) return;                                   // 不是协同的升级请求就别抢，留给别人
    socket.on("error", () => socket.destroy());
    void (async () => {
      try {
        const noteId = hit[1]!;
        const allowed = await authorize(req, noteId);
        // 无权的一律 404：403 会告诉对方「这篇存在」，那是侧信道
        if (!allowed) return deny(socket, 404, "Not Found");
        const [note] = await db.select({ bodyMd: notes.bodyMd, version: notes.version }).from(notes).where(eq(notes.id, noteId));
        if (!note) return deny(socket, 404, "Not Found");
        const room = await joinRoom(noteId, note);
        wss.handleUpgrade(req, socket, head, ws => {
          const conn = ws as Conn;
          conn.readOnly = allowed.readOnly;
          conn.userId = allowed.user.id;
          conn.binaryType = "arraybuffer";
          attachConnection(room, conn);
        });
      } catch {
        deny(socket, 500, "Internal Server Error");
      }
    })();
  });

  // 进程退出前把所有房间落一遍，别让最后几秒的输入随进程一起消失
  const flush = () => { void flushAllRooms().finally(() => process.exit(0)); };
  process.once("SIGINT", flush);
  process.once("SIGTERM", flush);
}
