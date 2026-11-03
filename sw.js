// Нужен только для системных уведомлений. Страницы не кэширует, поэтому обновления приходят сразу.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil(self.clients.openWindow(url));
});
