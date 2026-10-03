# Arquitectura real vs. documento de diseño

Lo que se construyó coincide con `docs/arquitectura.md` salvo lo siguiente (cada diferencia con su razón).

| Tema | Diseño | Real | Razón |
|---|---|---|---|
| Base de datos | PostgreSQL 16 en Docker | PostgreSQL 18 (beta) vía `embedded-postgres` | La máquina de desarrollo no tiene Docker/Postgres. Funciona igual con cualquier Postgres ≥ 16 (migraciones en SQL estándar). |
| ORM | Drizzle | SQL plano + `pg`, migraciones `db/migrations/NNN_*.sql` | Menos dependencias; el DDL del documento se usa casi tal cual. |
| `tenant_id` | solo en algunas tablas | también en `build_items`, `sale_items` | RLS lo necesita. |
| Sesiones | cookie | cookie + mapa en memoria del proceso | Un solo proceso; se pierden al reiniciar. |
| Rol de la consola | `admin_ro` | `admin_ro` (lecturas) + `admin_rw` (escrituras de administración, BYPASSRLS, solo tablas de gestión) | La consola necesita crear tenants/usuarios/llaves entre tenants. |
| Funciones SECURITY DEFINER | resolver | resolver + `login_lookup`, `api_key_lookup`, `user_totp`, `use_recovery_code`, `evaluate_alerts`, `refresh_metrics` | `app_rw` no puede leer `users` directamente. |
| Wasm | Web Worker | hilo principal | Decodificar es ~5 ms en escritorio; moverlo a Worker está pendiente de medir en móviles. |
| Tareas periódicas | node-cron | `setInterval` con `unref` | Sin dependencia extra; mismo efecto en un proceso. |
| Carga | k6 | `scripts/load-builds.ts` | k6 no instalado. |
| Reglas de compatibilidad | JSON por tenant | Tabla `configurators` (JSONB por negocio: grupos + reglas `equals`/`in`/`sum_lte`/`forbid`/`require`); evaluador compartido en `packages/codes/src/rules.ts` | Generalizado a cualquier negocio (PC, cafetería…); editable desde la consola. |
| Acceso | Dos roles humanos, login para todo salvo resolver y configurador | Sesión opcional; rol adicional `cliente` (registro por autoservicio, sin membresía); `build_saves` guarda sus configuraciones | Pedido posterior al plan. |
| Funciones de administrador | Sesión SuperAdmin + TOTP | Además, confirmación de contraseña con vigencia de 15 min (`adminUntil` en la sesión) | Pedido posterior al plan. |
| Roles de base | — | Creados sin contraseña; `migrate` las fija desde `DB_*_PASSWORD` | Hallazgo de la revisión de seguridad. |
| Secreto TOTP | — | AES-256-GCM con `TOTP_ENC_KEY` | Hallazgo de la revisión de seguridad. |
| Particionado de `scan_events` | por mes | sin particionar | Volumen de PoC. |
| Llaves de integración | CORS por dominio | solo `x-api-key` con alcance fijo (`POST /v1/builds`, `GET /v1/products`) | CORS pendiente. |
| Fuentes | autoalojadas | `@fontsource` (woff2 dentro del bundle) | Cumple "desde el propio dominio". |
| Tiempo real | SSE + pg_notify | igual (triggers → `NOTIFY events`) | — |
| TOTP | obligatorio SuperAdmin | obligatorio para `/v1/admin/*`; sin TOTP solo puede activarlo | Permite el primer alta. |
