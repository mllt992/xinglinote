import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
test("service worker 只缓存公开壳，绝不拦截 API/分享/附件/认证", async () => {
  const handlers: Record<string, (e: unknown) => void> = {};
  vm.runInNewContext(readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8"), { self: { location: { origin: "https://notes.test" }, addEventListener: (k: string, v: (e: unknown) => void) => { handlers[k] = v; } }, URL, fetch: async () => { throw new Error("offline"); }, caches: { match: async (key: string) => key }, Response });
  for (const path of ["/api/v1/notes/a", "/api/v1/workspaces/a/today", "/p/share", "/s/team/book", "/login", "/oauth/consent", "/api/v1/files/a"]) {
    let intercepted = false; handlers.fetch({ request: { url: `https://notes.test${path}`, method: "GET", mode: "navigate" }, respondWith: () => { intercepted = true; } }); assert.equal(intercepted, false, path);
  }
  for (const path of ["/app", "/w/a", "/w/a/n/b", "/w/a/today"]) {
    let result: Promise<string> | undefined; handlers.fetch({ request: { url: `https://notes.test${path}`, method: "GET", mode: "navigate" }, respondWith: (p: Promise<string>) => { result = p; } }); assert.equal(await result, "/offline.html");
  }
});
