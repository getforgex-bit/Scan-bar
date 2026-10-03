# Sistema Universal de Códigos — contexto para Claude Code

Diseño completo en `docs/arquitectura.md` (fuente: `docs/arquitectura-fuente.html`). Plan por fases: ver README.

## Resumen
Monolito modular TypeScript (Fastify + PostgreSQL) que actúa de resolver central de códigos EAN-13/QR de 9 tenants.
Cada GTIN-13 = `750` + prefijo de empresa (4) + artículo (5) + verificador módulo 10. El QR lleva GS1 Digital Link
`https://<host>/01/<GTIN-14>`. La PWA (React) escanea con BarcodeDetector nativo o Wasm (`barcode-detector`),
con dos modos: Navegación (abre el resolver) y Caja (mini POS). La sesión es opcional: visitante anónimo, cliente registrado,
operador y SuperAdmin (contraseña + TOTP para administrar). Los configuradores son genéricos y por negocio (tabla `configurators`:
grupos y reglas como datos; PC a medida, bebidas de cafetería…); cada configuración guardada tiene contenido inmutable con precio
congelado y GTIN determinista por hash.

## Stack
Node 24, Fastify 5, Zod, `pg` (SQL plano, migraciones en `db/migrations`), PostgreSQL con RLS, Argon2id, bwip-js,
Vite + React, vite-plugin-pwa, Vitest + fast-check. Postgres embebido (`embedded-postgres`) para desarrollo/pruebas.

## Estructura
`apps/api/src` (app.ts rutas, builds.ts configuradores, admin.ts consola, security.ts, env.ts, db.ts, svg.ts) · `apps/web/src` (PWA) · `packages/codes` (GTIN y reglas, sin dependencias)
· `db/` (migraciones, seed) · `scripts/` · `tests/` · `docs/`.

## Comandos
`npm i` · `npm run dev:db` (Postgres :5433) · `npm run migrate` · `npm run seed` · `npm start` (API :3000, sirve la PWA de `apps/web/dist`)
· `npm run build` (PWA) · `npm run dev:web` · `npm test` (levanta su propio Postgres en un puerto aleatorio) · `npm run typecheck` · `npm run check:resolver`.

## Reglas fijas
- Dinero en centavos enteros. IVA 16 % incluido en el precio y desglosado.
- Un GTIN nunca se reutiliza (retirar, no borrar). Huecos por transacciones revertidas son aceptables.
- Toda tabla con `tenant_id` usa RLS; toda consulta de negocio pasa por `withTenant()`.
- La consola nunca acepta SQL libre (lista blanca de vistas).
- Sin jQuery, Bootstrap ni librerías de componentes.
- Secretos solo por variables de entorno (`DB_*_PASSWORD`, `TOTP_ENC_KEY`); `.env` y `.dev-credentials.txt` están en .gitignore. Ninguna migración lleva contraseñas.
- CSP sin `unsafe-inline`: nada de scripts ni atributos `style` en HTML; React `style={{}}` sí (CSSOM). Sin `data:` en fuentes (`assetsInlineLimit: 0`).
- Todo endpoint público lleva límite de tasa (`limit()` de security.ts). Registrarse nunca concede roles de personal.
- Las reglas de un configurador son datos validados por `parseDefinition`; el evaluador (`packages/codes/src/rules.ts`) es el mismo en cliente y servidor.
- No afirmar mediciones sin ejecutarlas: los números van en `docs/mediciones.md`.
