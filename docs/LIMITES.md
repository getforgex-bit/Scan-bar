# Límites del prototipo y desviaciones respecto al plan

Estado: fases F0–F4 del plan implementadas, más los cambios pedidos después (uso sin sesión con registro, contraseña de administrador, configurador genérico e integración con las seis páginas web: [INTEGRACION-WEBS.md](INTEGRACION-WEBS.md)). Lo que no está aquí no se hizo.

## Desviaciones del plan (y motivo)
| Plan | Prototipo | Motivo |
|---|---|---|
| Docker Compose + Testcontainers | Pruebas con `embedded-postgres` (PostgreSQL **18** beta, no 16); `Dockerfile` solo para producción; CI en GitHub Actions | La máquina de desarrollo no tenía Docker ni Postgres. Compose sigue sin hacerse. |
| Drizzle | SQL plano versionado (`db/migrations`) + `pg` | Menos piezas; el DDL de la sección 2 se usa tal cual. |
| `build_items` sin `tenant_id` | Se añadió `tenant_id` | RLS necesita la columna. `sales`/`sale_items`, `scan_events` también la tienen. |
| Sesiones en BD | Sesiones en BD (tabla `sessions`, solo el hash del identificador) con caché en memoria | Cumplido al preparar producción: el contenedor se duerme y se reinicia. |
| Decodificación Wasm en Web Worker | Hilo principal | Pendiente; medir antes de moverlo. |
| k6 | `scripts/load-builds.ts` (Node) | k6 no instalado; mismo perfil de carga. |
| Login obligatorio (sección 8) | **Sesión opcional**: visitante anónimo, cliente registrado, operador, SuperAdmin | Pedido expreso. La matriz de permisos se conserva: lo público sigue siendo resolver + configurador (con límite de tasa); precio por GTIN (`/v1/scan`) y ventas siguen exigiendo personal. |
| Configurador de PC con reglas fijas | Configuradores **genéricos por negocio** (tabla `configurators`, reglas como datos) | Pedido expreso; cumple además "las reglas son datos (JSON por tenant)" de la sección 5. |
| Configurador visible en la PWA | **Oculto**; las configuraciones se arman en la web de cada negocio y Scan-bar emite su código (`POST /v1/public/t/:slug/configurations`) | Pedido expreso. El motor de reglas sigue disponible (opcional por petición). |
| Catálogo solo desde la consola o CSV | Catálogo de las webs desde su código (`sync:repos`, origen `repo`) + altas en la consola que la web lee por API (origen `scanbar`) | Pedido expreso: agregar productos a cada página y que se registren con su código. |

## Decisiones tomadas al quitar el login obligatorio (revísalas)
- **Registrarse crea una cuenta de cliente, sin permisos de personal.** No da acceso a Caja ni a Administración de ningún negocio; eso lo asigna un SuperAdmin en *Administración → Usuarios*. No existe (todavía) el alta de un negocio nuevo por autoservicio.
- **El catálogo de opciones de un configurador es público** (nombre, precio, atributos, "agotado sí/no"); no se exponen GTIN ni existencias exactas.
- **Funciones de administrador** = consola (`/v1/admin/*`), alta e importación de productos, alta de TOTP. Piden la contraseña de la cuenta: queda desbloqueado 15 min desde el inicio de sesión o desde la última acción de administrador, y hay botón "Bloquear ahora". La consola exige además TOTP.
- Los eventos de escaneo solo se registran con sesión de personal (un visitante anónimo no tiene negocio al que atribuirlos), así que las métricas de latencia no incluyen a los visitantes.
- Registro sin verificación de correo ni recuperación de contraseña: no hay envío de correos en el sistema.

## Seguridad (hallazgos 1–5 de la revisión, aplicados)
1. CSP `script-src 'self' 'wasm-unsafe-eval'`, `style-src 'self'` (sin `unsafe-inline`), `frame-ancestors 'none'`; HSTS fuera de localhost; `X-Frame-Options: DENY`. Las páginas HTML del resolver llevan su propia CSP sin scripts. Las fuentes ya no se incrustan como `data:`.
2. Los roles `app_rw`, `admin_ro`, `admin_rw` se crean sin contraseña; `npm run migrate` las fija desde `DB_*_PASSWORD`. En desarrollo se generan en `.env`; con `NODE_ENV=production`, si faltan, la migración falla.
3. Cookie `Secure` siempre, salvo en `localhost`.
4. Límite de tasa en memoria por IP: resolver 120/min, SVG 300/min, catálogos públicos 120/min, guardado público 10/min, registro 5/h, login 30/min; por llave de integración 60/min en `POST /v1/builds`.
5. Secreto TOTP cifrado en reposo (AES-256-GCM, `TOTP_ENC_KEY`); la migración re-cifra los anteriores.

Hallazgos **no** aplicados (no se pidieron): el login responde más rápido si el usuario no existe (enumeración de cuentas, que el registro también permite con su 409); la `Idempotency-Key` no caduca a las 24 h; los límites de tasa viven en memoria (se reinician con el proceso y no sirven con varias instancias; por eso el contenedor tiene `max_instances: 1`).

## Integración con las webs: límites
- Las webs estáticas usan la última copia guardada del catálogo y la refrescan para la siguiente visita: un alta o retiro se ve a la siguiente carga.
- Sin `configurator`, Scan-bar no aplica reglas de compatibilidad a lo que llega de una web (las valida la web); solo existencia, negocio y estado de cada SKU.
- Las configuraciones de las webs no se guardan en *Mis configuraciones* (no hay cookie entre sitios).
- Las webs aún no abren un producto concreto desde la URL del resolver: la plantilla apunta a su página principal.
- Biker Lifestyle tiene CSP estricta: admite Scan-bar en `*.workers.dev` e imágenes https; si Scan-bar vive en otro dominio hay que agregarlo a `connect-src`.
- El pastel personalizado de Dulce Encanto se sigue cotizando por WhatsApp (sin precio fijo no hay código).

## No implementado todavía
- Llaves de integración: sin CORS por dominio del tenant (solo `x-api-key`).
- Las alertas no envían correo. Métricas/alertas cada 60 s y monitor de enlaces cada 6 h con `setInterval`, no `node-cron`.
- `scan_events` sin particionar; sin verificación contra listas reales de contraseñas filtradas (solo una lista corta de triviales).
- Editor de configuradores: es un área de texto JSON validada, no un editor visual.
- Tipos de regla: `equals`, `in`, `sum_lte`, `forbid`, `require`. No hay precios condicionales (p. ej. "la leche vegetal cuesta más solo en tamaño grande") ni límites entre grupos.
- Detrás de un proxy hay que definir `TRUST_PROXY=1` para que el límite de tasa y la cookie `Secure` vean la IP y el host reales.
- Prefijo GS1 `750` es de entorno académico; para circular en comercio abierto se requiere licencia GS1 México o el rango 20–29.

## Sin verificar
- **Cámara real y matriz de campo** (3 dispositivos × 30 lecturas): "sin datos". El navegador integrado de la herramienta bloquea la cámara.
- **Service worker / modo sin conexión con la CSP nueva**: el navegador integrado no registra service workers (fallaba igual antes de la CSP), así que no se pudo comprobar en un navegador real. La CSP incluye `worker-src 'self'`.
- Revisión visual contra la sección 7 por una persona; "otra persona levanta el proyecto solo con el README".
- `pg_dump`/`pg_restore` (no hay binarios); el respaldo probado es físico en frío.

## Producción en Cloudflare: límites
- **Una sola instancia** del contenedor (`max_instances: 1`, tipo `basic`): límites de tasa y caché de sesiones de un solo proceso. Suficiente para el proyecto; con más tráfico habría que mover los límites a la base o a Redis.
- **Arranque en frío**: tras 20 minutos sin peticiones el contenedor se duerme; la siguiente petición tarda unos segundos (el Worker responde 503 con `Retry-After` mientras tanto). Las webs no esperan: pintan sus productos y usan su copia guardada.
- **Requiere el plan Workers Paid** (Containers). La imagen la construye Cloudflare en el despliegue por defecto; Docker solo hace falta para publicar desde la terminal.
- **No se publicó en una cuenta real** desde el entorno de desarrollo: se probó la imagen contra un Postgres sin superusuario, `wrangler deploy --dry-run` de los siete Workers y las webs encontrando Scan-bar en `*.workers.dev` simulado en Chromium. El primer despliegue real es el que lo confirma ([DESPLIEGUE.md](DESPLIEGUE.md)).
- La sincronización lee la rama principal de cada web: lo que esté en otra rama no llega a Scan-bar hasta unirse.
