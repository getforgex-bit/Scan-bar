# Scan-bar en Cloudflare (plan gratuito)

El Worker `scan-bar` (`src/index.ts`, configuración en `wrangler.jsonc` de la raíz) da la dirección fija
`https://scan-bar.<tu-cuenta>.workers.dev` y pasa cada petición (PWA, API, resolver `/01/…`) al servidor de Scan-bar que corre en tu PC.

- **Publicar**: *Workers & Pages → Create → Import a repository → Scan-bar*, sin cambiar nada (o `npm run cf:deploy`).
- **Único secreto**: `SCANBAR_PROXY_KEY`, la llave que muestra el panel del servidor (*Datos → Conexión con Cloudflare*).
- **Dirección del servidor**: el panel la registra al encender (`POST /__scanbar/origen`, firmado con la llave) y la borra al apagar; se
  guarda en un Durable Object con almacenamiento SQLite (incluido en el plan gratuito). Sin servidor registrado, responde 503 "Scan-bar está
  apagado".
- Cada petición reenviada lleva la llave y el host e IP reales (`x-scanbar-proxy`, `x-scanbar-host`, `x-scanbar-ip`); el servidor rechaza lo
  que llegue sin ella.

Pasos completos: [`docs/DESPLIEGUE.md`](../docs/DESPLIEGUE.md).
