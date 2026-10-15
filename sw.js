// Rota notifications: shows what the "push" edge function sends and opens the rota when one's
// tapped. It caches nothing, so the page always loads fresh.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Shop Rota", {
    body: d.body || "",
    tag: d.tag,
    renotify: !!d.tag,
    icon: "rota-icon-192.png",
    badge: "rota-badge.png",
    data: { url: d.url || "rota.html" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "rota.html", self.registration.scope).href;
  e.waitUntil((async () => {
    const open = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).find((w) => w.url.includes("rota.html"));
    if (open) { open.postMessage({ go: url }); return open.focus(); }
    return self.clients.openWindow(url);
  })());
});
