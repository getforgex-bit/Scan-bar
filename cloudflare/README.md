# Scan-bar en Cloudflare

Un Worker (`src/index.ts`) recibe todas las peticiones de `https://scan-bar.<tu-cuenta>.workers.dev` (PWA, API y resolver `/01/…`) y las pasa a un contenedor con la app de Node (imagen: `Dockerfile` de la raíz). La base de datos es un PostgreSQL administrado (Neon). La configuración está en `wrangler.jsonc`, **en la raíz del repositorio**, para que funcione el despliegue por defecto de Cloudflare. Los pasos completos, incluidas las seis webs, están en [`docs/DESPLIEGUE.md`](../docs/DESPLIEGUE.md).

**Despliegue por defecto** (recomendado): *Workers & Pages → Create → Import a repository → Scan-bar*, nombre `scan-bar`, sin tocar nada más. Cloudflare instala las dependencias, construye la imagen y publica en cada push a `main`.

Desde tu computadora (necesita Docker en marcha), en la raíz del repositorio:

```bash
npm install
npx wrangler login
npm run cf:deploy     # construye la imagen y publica Worker + contenedor
npm run cf:secrets    # DATABASE_URL de Neon y contraseñas del administrador y las cajas (el resto se genera)
npm run cf:logs       # registro en vivo
```

| Secreto | Qué es |
|---|---|
| `DATABASE_URL` | Cadena *Direct connection* de Neon (sin `-pooler`) |
| `ADMIN_PASSWORD` | SuperAdmin `admin@scanbar.mx` (o `ADMIN_EMAIL`) |
| `CAJA_PASSWORD` | Cuentas `caja.<negocio>@scanbar.mx` del modo Caja |
| `DB_APP_RW_PASSWORD`, `DB_ADMIN_RO_PASSWORD`, `DB_ADMIN_RW_PASSWORD` | Roles internos de Postgres (los genera `npm run cf:secrets`) |
| `TOTP_ENC_KEY` | Cifra los secretos del segundo factor (lo genera `npm run cf:secrets`; no cambiarlo) |

Opcionales: `WEB_URL_<NEGOCIO>` (p. ej. `WEB_URL_CAFE_MOTZ=https://cafe.ejemplo.mx`) si una web no vive en `<worker>.<tu-cuenta>.workers.dev`; `SYNC_INTERVAL_MIN` (en `wrangler.jsonc`, 10 por defecto); `SYNC_REPOS=0` para apagar la sincronización automática.

El contenedor se duerme tras 20 minutos sin peticiones; la siguiente lo despierta en unos segundos (la base vive aparte, no se pierde nada).
