# Límites del prototipo y desviaciones respecto al plan

Estado: fases F0–F4 del plan implementadas, más tres cambios pedidos después (uso sin sesión con registro, contraseña de administrador y configurador genérico). Lo que no está aquí no se hizo.

## Desviaciones del plan (y motivo)
| Plan | Prototipo | Motivo |
|---|---|---|
| Docker Compose + Testcontainers | `embedded-postgres` (PostgreSQL **18** beta, no 16) | La máquina no tiene Docker ni Postgres instalados. Compose y CI quedan pendientes. |
| Drizzle | SQL plano versionado (`db/migrations`) + `pg` | Menos piezas; el DDL de la sección 2 se usa tal cual. |
| `build_items` sin `tenant_id` | Se añadió `tenant_id` | RLS necesita la columna. `sales`/`sale_items`, `scan_events` también la tienen. |
| Sesiones en BD | Sesiones en memoria del proceso | Suficiente para un solo proceso; se pierden al reiniciar. |
| Decodificación Wasm en Web Worker | Hilo principal | Pendiente; medir antes de moverlo. |
| k6 | `scripts/load-builds.ts` (Node) | k6 no instalado; mismo perfil de carga. |
| Login obligatorio (sección 8) | **Sesión opcional**: visitante anónimo, cliente registrado, operador, SuperAdmin | Pedido expreso. La matriz de permisos se conserva: lo público sigue siendo resolver + configurador (con límite de tasa); precio por GTIN (`/v1/scan`) y ventas siguen exigiendo personal. |
| Configurador de PC con reglas fijas | Configuradores **genéricos por negocio** (tabla `configurators`, reglas como datos) | Pedido expreso; cumple además "las reglas son datos (JSON por tenant)" de la sección 5. |

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

Hallazgos **no** aplicados (no se pidieron): el login responde más rápido si el usuario no existe (enumeración de cuentas, que el registro también permite con su 409); la `Idempotency-Key` no caduca a las 24 h; sesiones y límites de tasa viven en memoria (se reinician con el proceso y no sirven con varios procesos).

## No implementado todavía
- Llaves de integración: sin CORS por dominio del tenant (solo `x-api-key`).
- Las alertas no envían correo. Métricas/alertas cada 60 s y monitor de enlaces cada 6 h con `setInterval`, no `node-cron`.
- `scan_events` sin particionar; sin verificación contra listas reales de contraseñas filtradas (solo una lista corta de triviales).
- Editor de configuradores: es un área de texto JSON validada, no un editor visual. Sin editar ni desactivar productos desde la interfaz (solo alta e importación CSV).
- Tipos de regla: `equals`, `in`, `sum_lte`, `forbid`, `require`. No hay precios condicionales (p. ej. "la leche vegetal cuesta más solo en tamaño grande") ni límites entre grupos.
- Detrás de un proxy hay que definir `TRUST_PROXY=1` para que el límite de tasa y la cookie `Secure` vean la IP y el host reales.
- Prefijo GS1 `750` es de entorno académico; para circular en comercio abierto se requiere licencia GS1 México o el rango 20–29.

## Sin verificar
- **Cámara real y matriz de campo** (3 dispositivos × 30 lecturas): "sin datos". El navegador integrado de la herramienta bloquea la cámara.
- **Service worker / modo sin conexión con la CSP nueva**: el navegador integrado no registra service workers (fallaba igual antes de la CSP), así que no se pudo comprobar en un navegador real. La CSP incluye `worker-src 'self'`.
- Revisión visual contra la sección 7 por una persona; "otra persona levanta el proyecto solo con el README".
- `pg_dump`/`pg_restore` (no hay binarios); el respaldo probado es físico en frío.
