import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { Context, Hono } from "hono";
import { env } from "../env.ts";
import { loadPublicMeta } from "./public-meta-load.ts";
import { neutralMeta, renderPublicMeta, type PublicMeta } from "./public-meta.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function etag(size: number, mtimeMs: number) {
  return `W/"${createHash("sha1").update(`${size}-${mtimeMs}`).digest("hex").slice(0, 16)}"`;
}

/** 生产形态：api 进程同时托管前端构建产物。dist 不存在（开发态由 vite 提供）时返回 false。 */
export function mountWeb(app: Hono, options: { webDist?: string; publicUrl?: string; loadMeta?: (path: string) => Promise<PublicMeta> } = {}) {
  const root = resolve(options.webDist ?? env.webDist);
  const indexPath = join(root, "index.html");
  if (!existsSync(indexPath)) return false;

  async function send(c: Context, file: string, immutable: boolean) {
    const info = await stat(file);
    const tag = etag(info.size, info.mtimeMs);
    if (c.req.header("If-None-Match") === tag) return c.body(null, 304);
    const body = await readFile(file);
    return c.body(body, 200, {
      "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": String(info.size),
      ETag: tag,
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
  }

  app.on(["GET", "HEAD"], "*", async (c) => {
    let path: string;
    try { path = decodeURIComponent(new URL(c.req.url).pathname); } catch { return c.notFound(); }
    // API 未命中的路径不能落进 SPA，否则 404 会变成一份 200 的 index.html
    if (path === "/api" || path.startsWith("/api/")) return c.notFound();

    if (path !== "/" && !path.endsWith("/")) {
      const target = resolve(root, `.${path}`);
      // 防目录穿越：解析后必须仍在 dist 内
      if ((target === root || target.startsWith(root + "/") || target.startsWith(root + "\\")) && existsSync(target)) {
        const info = await stat(target);
        if (info.isFile()) return send(c, target, path.startsWith("/assets/"));
      }
    }
    if (path === "/p" || path.startsWith("/p/") || path === "/s" || path.startsWith("/s/")) {
      // 每次重新验证有效性。不可沿用 SPA 的 ETag / 304，否则撤销或加密后的标题会复用旧缓存。
      const meta = await (options.loadMeta ?? loadPublicMeta)(path).catch(() => neutralMeta());
      const html = renderPublicMeta(await readFile(indexPath, "utf8"), meta, options.publicUrl ?? env.publicUrl, new URL(c.req.url).pathname);
      return c.body(html, 200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": meta.allowRobots ? "index, follow" : "noindex, nofollow",
      });
    }
    return send(c, indexPath, false);
  });
  return true;
}
