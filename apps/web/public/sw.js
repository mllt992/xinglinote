/** 只缓存公开的离线壳与品牌文件；不存私有 API、SPA HTML 或附件。 */
const CACHE = "xingli-offline-v1";
const SHELL = ["/offline.html", "/offline.js", "/offline.css", "/manifest.webmanifest", "/brand/xingli-mark.svg", "/brand/icon-192.png", "/brand/icon-512.png"];
self.addEventListener("install", event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE); await cache.addAll(SHELL); await self.skipWaiting();
})()));
self.addEventListener("activate", event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith("xingli-offline-") && name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (SHELL.includes(url.pathname) && !url.search) {
    event.respondWith(fetch(event.request).catch(async () => (await caches.match(url.pathname)) || Response.error()));
  } else if (event.request.mode === "navigate" && (url.pathname === "/app" || /^\/w\/[^/]+(?:\/n\/[^/]+|\/today)?$/.test(url.pathname))) {
    event.respondWith(fetch(event.request).catch(async () => (await caches.match("/offline.html")) || Response.error()));
  }
});

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { title: "星璃笔记", body: event.data ? event.data.text() : "" }; }
  // 通知会显示在锁屏上，所以服务端只发标题与时刻，这里也不再多显示什么
  event.waitUntil(self.registration.showNotification(data.title || "星璃笔记", {
    body: data.body || "",
    tag: data.tag || "kb",
    renotify: false,
    icon: "/brand/xingli-mark.svg",
    badge: "/brand/xingli-mark-mono.svg",
    data: { href: data.href || "/" },
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const href = (event.notification.data && event.notification.data.href) || "/";
  // 已经开着的那个标签页直接复用并跳转，不要每点一次通知就多开一个窗口
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of windows) {
      if (new URL(w.url).origin !== self.location.origin) continue;
      await w.focus();
      if ("navigate" in w) await w.navigate(href);
      return;
    }
    await self.clients.openWindow(href);
  })());
});
