# Sistema Universal de Códigos — prototipo

Resolver central de códigos EAN-13 / QR (GS1 Digital Link) para varios negocios, con escáner PWA y mini POS. Es la base de datos única de las
seis páginas web de los negocios: los productos que se agregan aquí aparecen en su web con su código, las configuraciones que el cliente arma
en la web (bebida, ensamble de PC) reciben su código aquí, y cada web se imprime en una hoja de etiquetas PDF.
Diseño: [docs/arquitectura.md](docs/arquitectura.md). **Publicar gratis (webs en Cloudflare, servidor en tu PC): [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md).** Integración con las webs: [docs/INTEGRACION-WEBS.md](docs/INTEGRACION-WEBS.md). Límites y desviaciones: [docs/LIMITES.md](docs/LIMITES.md). Mediciones: [docs/mediciones.md](docs/mediciones.md).

## Levantarlo (Windows/macOS/Linux, solo Node ≥ 22)

```bash
npm i
npm run dev:db      # Postgres embebido en :5433 (déjalo corriendo en otra terminal)
npm run migrate     # esquema + contraseñas de los roles de base (en desarrollo se generan en .env)
npm run seed        # 9 negocios de ejemplo; genera .dev-credentials.txt si no defines SEED_*_PASSWORD
npm run sync:repos  # las 6 webs reales desde GitHub (o -- --local=.. si las tienes clonadas al lado)
npm run build && npm start        # API + PWA en http://localhost:3000
```

La app **se usa sin iniciar sesión**: cualquiera puede escanear (modo Navegación) y eso es todo lo que ve un visitante. El configurador propio
de Scan-bar está **oculto**: cada negocio configura en su página web y Scan-bar emite el código de esa configuración (ver
[docs/INTEGRACION-WEBS.md](docs/INTEGRACION-WEBS.md); `SHOW_CONFIGURATOR` en `apps/web/src/flags.ts` lo vuelve a mostrar junto con el registro de
clientes y *Mis configuraciones*). Iniciar sesión es solo para el personal:

| Quién | Cómo entra | Qué añade |
|---|---|---|
| Visitante | sin cuenta | escanear y abrir la página del producto |
| Caja | `caja.<negocio>@scanbar.mx` en producción (`caja1..9@ejemplo.mx` en la semilla) | modo Caja (mini POS) y catálogo de su negocio |
| SuperAdmin | `admin@scanbar.mx` en producción (`admin1..9@ejemplo.mx` en la semilla) | *Administración*: pide **contraseña** (se bloquea a los 15 min sin uso) y segundo factor (TOTP) |

En producción las cuentas las crea el arranque con los secretos `ADMIN_PASSWORD` y `CAJA_PASSWORD` (el secreto manda: cambiarlo y reiniciar
cambia la contraseña). Nadie puede registrar esos correos por su cuenta.
Contraseñas de la semilla en `.dev-credentials.txt` (o `SEED_ADMIN_PASSWORD` / `SEED_POS_PASSWORD`). Otros accesos de personal: *Administración → Usuarios*.

**Catálogo de las webs**: se sincroniza solo desde GitHub al arrancar y cada 10 minutos (*Sincronizar ahora* en la consola lo fuerza).
**Agregar un producto a una web**: *Administración → Productos y etiquetas* → elige la web → nombre, categoría (la sección de la web), precio y,
si aplica, variantes (`CH, M, G` o `Chico=45, Grande=55`): cada variante recibe su GTIN al instante y la web la muestra en su siguiente carga.
**Etiquetas**: en la misma sección, *Descargar PDF* (carta o A4, QR opcional, copias): nombre encima de cada código, con guías de corte.
Negocios de ejemplo con configurador (motor de reglas, sigue disponible por API): `tienda-0002` (PC a medida) y `tienda-0003` (bebidas).

La cámara exige HTTPS salvo en `localhost`. Para probar desde un teléfono, expón la app con un túnel HTTPS.

## Qué incluye
- **Códigos**: `packages/codes` (GTIN-13, módulo 10, Digital Link), SVG EAN-13/QR (`GET /v1/codes/:gtin.svg`), resolver `GET /01/:gtin14` con ficha de respaldo y anti redirección abierta.
- **Aislamiento**: PostgreSQL con RLS por `tenant_id`, `withTenant()`, roles `app_rw` (sujeto a RLS), `admin_ro` y `admin_rw`, con contraseñas tomadas del entorno.
- **Cuentas**: Argon2id, cookie HttpOnly/SameSite=Lax/Secure (salvo localhost), bloqueo tras 5 intentos, registro de clientes, contraseña + TOTP (cifrado en reposo) para administración.
- **Seguridad**: CSP sin scripts ni estilos en línea, HSTS, X-Frame-Options, límite de tasa por IP en todo lo público.
- **PWA**: lector con BarcodeDetector nativo o Wasm autoalojado, consenso de 2 lecturas, antirrebote, captura manual; modos Navegación/Caja; ventas idempotentes con cola sin red; ticket de 80 mm.
- **Integración con las webs**: catálogo público por negocio (`GET /v1/public/t/:slug/catalog`), códigos para configuraciones hechas en la web (`POST /v1/public/t/:slug/configurations`), CORS por dominio del negocio, sincronización de los repos con origen (`repo`/`scanbar`) y variantes con GTIN propio.
- **Etiquetas en PDF** sin dependencias (`apps/api/src/pdf.ts`, `labels.ts`): mismos trazos de bwip-js que el SVG; verificadas decodificándolas con ZXing.
- **Configurador genérico** (oculto en la PWA): grupos y reglas como datos por negocio (`equals`, `in`, `sum_lte`, `forbid`, `require`), evaluados igual en cliente y servidor; contenido con precio congelado; GTIN determinista por hash.
- **Administración**: negocios, configuradores, productos de todas las webs y etiquetas, usuarios, llaves, visor de BD, depurador, métricas, alertas y eventos en vivo.

## Producción (gratis)

- **Servidor en tu PC**: doble clic en `Servidor Scan-bar.cmd` (Windows) o `sh servidor.sh` → panel con **un botón** para encender y
  apagar, y una pestaña **Datos** con el registro en vivo, el estado, los productos por web, la sincronización y las cuentas
  (`servidor/panel.ts`). Encender arranca PostgreSQL embebido, la app (`scripts/start.ts`) y un túnel gratuito de Cloudflare.
- **Dirección fija**: el Worker `scan-bar` (`cloudflare/src/index.ts`, `wrangler.jsonc` en la raíz, plan gratuito) da
  `https://scan-bar.<tu-cuenta>.workers.dev` y pasa cada visita a tu PC, firmada con una llave (`PROXY_KEY`).
- El `Dockerfile` sigue sirviendo para un servidor en la nube. Todo en [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md).

## Pruebas

```bash
npm test            # 89 pruebas: GTIN, motor de reglas, RLS, API, ventas, configuradores, uso sin sesión, registro, seguridad, consola, TOTP, alertas, SSE, integración con las webs, PDF y producción (roles sin BYPASSRLS, sesiones en la base, arranque, sincronización)
npm run typecheck
npm run check:resolver   # con la API levantada: 9 de 9 redirecciones
npm run backup-test      # respaldo en frío + restauración verificada
```
