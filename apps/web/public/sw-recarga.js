// Lo carga el service worker (workbox.importScripts en vite.config.ts). Cuando llega una versión nueva de la app (Scan-bar
// se actualizó en el servidor), las pestañas abiertas se recargan solas: sin esto seguían mostrando la versión guardada.
// La primera instalación no recarga nada.
let esActualizacion = false;
self.addEventListener('install', () => { esActualizacion = !!self.registration.active; });
self.addEventListener('activate', (event) => {
  if (!esActualizacion) return;
  event.waitUntil(self.clients.claim()
    .then(() => self.clients.matchAll({ type: 'window' }))
    .then((pestanas) => Promise.all(pestanas.map((p) => p.navigate(p.url).catch(() => undefined)))));
});
