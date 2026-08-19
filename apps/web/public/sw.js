/**
 * 只干推送这一件事：不缓存、不接管导航、不做离线（那是另一个话题，做不好比不做更糟）。
 * 载荷是 lib/push.ts 里 pushToUser 发的 JSON：{title, body, href, tag}。
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

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
