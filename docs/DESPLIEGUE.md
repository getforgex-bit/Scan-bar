# Despliegue en Cloudflare (Scan-bar + las seis webs)

Todo vive en **una sola cuenta de Cloudflare** y una base PostgreSQL en **Neon**:

| Qué | Repositorio | Worker (nombre fijo) | URL resultante |
|---|---|---|---|
| Scan-bar (PWA, API, resolver `/01/…`) | `Scan-bar` (carpeta `cloudflare/`) | `scan-bar` | `https://scan-bar.<tu-cuenta>.workers.dev` |
| YOKREM | `yokrem` | `yokrem` | `https://yokrem.<tu-cuenta>.workers.dev` |
| Motz Café | `Cafe-Motz` | `motz-cafe` | `https://motz-cafe.<tu-cuenta>.workers.dev` |
| Dulce Encanto | `dulce-encanto` | `dulce-encanto` | `https://dulce-encanto.<tu-cuenta>.workers.dev` |
| Nova Core | `nova-core` | `nova-core` | `https://nova-core.<tu-cuenta>.workers.dev` |
| La Picosita de la Sierra | `La-picosita-de-la-sierra` | `la-picosita-de-la-sierra` | `https://la-picosita-de-la-sierra.<tu-cuenta>.workers.dev` |
| Biker Lifestyle | `biker-lifestyle` | `biker-lifestyle` | `https://biker-lifestyle.<tu-cuenta>.workers.dev` |

**Por qué los nombres importan**: con todo en `*.<tu-cuenta>.workers.dev`, nada se configura a mano. Cada web encuentra Scan-bar en
`scan-bar.<tu-cuenta>.workers.dev`, Scan-bar acepta sus peticiones (CORS de la misma cuenta) y sabe a qué URL redirigir los códigos de cada
negocio (`worker` en `apps/api/src/sync.ts`). Usa **Workers**, no Pages: en `*.pages.dev` no aplica nada de esto (ver "Dominios propios").

## 0. Antes de empezar

- **Une las ramas a `main`** en los siete repositorios. Scan-bar sincroniza el catálogo leyendo la rama principal de cada web, y Cloudflare
  publica desde `main`. Mientras no se unan, por ejemplo, la leche y los extras de Motz Café y los servicios de ensamble de Nova Core no
  existen en Scan-bar y esas webs no reciben código para sus configuraciones (la página funciona igual, solo sin código).
- **Cuenta de Cloudflare** con el plan **Workers Paid** (lo exige Containers, que usa solo Scan-bar; las seis webs caben en el plan gratuito).
  Revisa el precio vigente en la página de precios de Cloudflare.
- **Cuenta de Neon** (el plan gratuito basta para el proyecto; revisa sus límites actuales).
- Para publicar Scan-bar desde tu computadora: **Node ≥ 22** y **Docker** en marcha (wrangler construye la imagen). Sin Docker, usa GitHub
  Actions (paso 2, opción B).

## 1. Base de datos (Neon)

1. Crea un proyecto en Neon (región: la de AWS en el este de EE. UU., la más cercana a México de las que ofrece).
2. En **Connect**, copia la cadena **Direct connection** (la que **no** lleva `-pooler` en el host); termina en `?sslmode=require`.
   Scan-bar necesita conexión directa: la consola en vivo usa `LISTEN/NOTIFY`, que no funciona a través del pooler.
3. No crees tablas ni roles: Scan-bar lo hace al arrancar (migraciones y roles `app_rw`, `admin_ro`, `admin_rw` sin `BYPASSRLS`).

## 2. Scan-bar

### Opción A — desde tu computadora (con Docker)

```bash
cd Scan-bar/cloudflare
npm install
npx wrangler login        # abre el navegador; una sola vez
npm run deploy            # construye la imagen (Dockerfile de la raíz) y publica Worker + contenedor
npm run secrets           # pide DATABASE_URL y las contraseñas; genera el resto (ver tabla)
npm run deploy            # reinicia con los secretos
```

`npm run secrets` (`cloudflare/secrets.mjs`) sube estos secretos con `wrangler secret bulk`:

| Secreto | De dónde sale |
|---|---|
| `DATABASE_URL` | La cadena *Direct connection* de Neon (se pide) |
| `ADMIN_PASSWORD` | Contraseña del SuperAdmin `admin@scanbar.mx` (se pide; Enter genera una) |
| `CAJA_PASSWORD` | Contraseña de las cuentas `caja.<negocio>@scanbar.mx` (se pide; Enter genera una) |
| `DB_APP_RW_PASSWORD`, `DB_ADMIN_RO_PASSWORD`, `DB_ADMIN_RW_PASSWORD` | Aleatorias (roles internos de Postgres; nadie necesita conocerlas) |
| `TOTP_ENC_KEY` | Aleatoria (cifra los segundos factores). **No la cambies nunca**: el script la conserva si ya existe |

Las contraseñas deben tener al menos 12 caracteres y no contener la parte del correo antes de la `@` (`admin`, `caja.yokrem`…).
También puedes pasarlas por entorno: `ADMIN_PASSWORD=… CAJA_PASSWORD=… DATABASE_URL=… npm run secrets`.

### Opción B — GitHub Actions (sin Docker en tu computadora)

El flujo `.github/workflows/cloudflare.yml` prueba cada cambio y, al llegar a `main`, publica Scan-bar (los runners de GitHub ya traen Docker).

1. En Cloudflare: **My Profile → API Tokens → Create Token**, plantilla *Edit Cloudflare Workers*, y añade el permiso de cuenta
   **Containers: Edit** (wrangler lo usa para subir la imagen). Copia también tu **Account ID** (aparece en *Workers & Pages*).
2. En GitHub, repositorio Scan-bar → *Settings → Secrets and variables → Actions*: `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`.
3. Haz push (o une la rama) a `main`, o lanza el flujo a mano (*Actions → Pruebas y despliegue → Run workflow*).
4. Los secretos de la app se suben una vez: con `npm run secrets` desde `cloudflare/` (no necesita Docker) o en el panel
   (*Workers & Pages → scan-bar → Settings → Variables and Secrets*, tipo *Secret*). Después, vuelve a lanzar el flujo para reiniciar.

### Qué pasa en el primer arranque

La primera petición despierta el contenedor (unos segundos; mientras, el Worker responde 503 "Scan-bar está arrancando"). Al arrancar:
migraciones → seis negocios con sus prefijos (`0010`–`0015`) → SuperAdmin y una caja por negocio → servidor → **sincronización de las seis
webs desde GitHub** (todos sus productos con su código). Después revisa los repositorios cada 10 minutos (`SYNC_INTERVAL_MIN`) y solo
vuelve a leer los que cambiaron. El contenedor se duerme tras 20 minutos sin peticiones; la base vive aparte y no se pierde nada.

Registro en vivo: `npm run logs` en `cloudflare/`.

## 3. Las seis webs

En el panel de Cloudflare, para cada repositorio: **Workers & Pages → Create → Import a repository** → elige el repositorio. El nombre del
proyecto debe ser exactamente el de la tabla de arriba (ya viene en su `wrangler.jsonc`).

| Web | Build command | Deploy command |
|---|---|---|
| YOKREM, Dulce Encanto, La Picosita, Biker Lifestyle | *(vacío)* | `npx wrangler deploy` |
| Motz Café, Nova Core | `npm run build` | `npx wrangler deploy` |

Cada push a `main` vuelve a publicar. Desde la terminal también funciona: `npx wrangler deploy` en las estáticas y `npm run deploy` en las
de React. Las estáticas publican solo la página, sus scripts e imágenes (`.assetsignore` deja fuera `.git`, los `.md` y la configuración).

## 4. Primer uso

1. Abre `https://scan-bar.<tu-cuenta>.workers.dev` → **Entrar** con `admin@scanbar.mx` y tu `ADMIN_PASSWORD`.
2. **Administración** pide activar el segundo factor: escanea el QR con una app de autenticación (Google Authenticator, Microsoft
   Authenticator, Authy…), escribe el código de 6 dígitos y **guarda los códigos de recuperación** (no se vuelven a mostrar).
3. *Productos y etiquetas*: verás "Catálogos de las webs sincronizados…" con el número de productos. Elige una web → **Descargar PDF**
   → imprime al 100 % ("tamaño real") → recorta y pega.
4. Las cajas entran con `caja.<negocio>@scanbar.mx` (p. ej. `caja.cafe-motz@scanbar.mx`) y tu `CAJA_PASSWORD`; eligen el modo **Caja**.

**Comprobación rápida**: escanea con el teléfono una etiqueta en `https://scan-bar.<tu-cuenta>.workers.dev` (modo Navegación) → abre la
web del negocio. Agrega un producto en la consola → aparece en su web en la siguiente carga (hasta un minuto de caché). Arma una bebida
en Motz Café o un ensamble en Nova Core → el pedido muestra su código.

## Cambios frecuentes

- **Cambiar una contraseña**: vuelve a ejecutar `npm run secrets` (escribe solo la nueva) y `npm run deploy`. Al arrancar, la cuenta toma
  la contraseña del secreto y se cierran sus sesiones abiertas.
- **Agregar productos a una web**: en la consola (*Productos y etiquetas*) o en el código de la web (se sincroniza solo; *Sincronizar
  ahora* lo fuerza).
- **Perdiste el teléfono del segundo factor**: entra con un código de recuperación. Sin ellos, desde la consola SQL de Neon:
  `UPDATE users SET totp_enabled = false, totp_secret = NULL WHERE email = 'admin@scanbar.mx';` y vuelve a activarlo.

## Dominios propios (opcional)

Decídelo **antes de imprimir etiquetas**: el QR lleva el host de Scan-bar (`https://<host>/01/<GTIN>`); el EAN-13 no cambia nunca.

- **Scan-bar en un dominio propio** (p. ej. `codigos.ejemplo.mx`): agrégalo como *Custom domain* del Worker `scan-bar` y define el secreto
  `RESOLVER_HOST=codigos.ejemplo.mx`. En cada web: `data-url="https://codigos.ejemplo.mx"` (estáticas) o `VITE_SCANBAR_URL` (React), y en
  Biker Lifestyle agrega el origen a `connect-src` de `public/_headers`. Si Scan-bar usa su dominio desde el **primer** arranque, define
  también `WEB_URL_<NEGOCIO>` de las seis webs (sin un host `workers.dev` no puede deducir sus URLs).
- **Una web en dominio propio**: secreto `WEB_URL_<NEGOCIO>` en Scan-bar (p. ej. `WEB_URL_CAFE_MOTZ=https://cafe.ejemplo.mx`) para que el
  resolver redirija ahí y acepte su CORS; y en la web, la URL de Scan-bar como arriba (fuera de `workers.dev` no se deduce sola).

## Si algo falla

| Síntoma | Causa probable |
|---|---|
| 503 "Scan-bar está arrancando" más de un minuto | `npm run logs`: suele ser un secreto que falta ("Falta la variable de entorno …") o `DATABASE_URL` mal copiada |
| "La contraseña de … no sirve" en el registro | La contraseña no cumple las reglas (12 caracteres, sin la parte del correo) |
| Una web no muestra los productos de Scan-bar | Su Worker no se llama como en la tabla, o está en `pages.dev` / dominio propio sin `data-url` |
| Motz Café o Nova Core no muestran el código del pedido | Las ramas no están unidas a `main` (falta la leche, los extras o los servicios en Scan-bar), o Scan-bar está dormido y tardó |
| *Sincronizar ahora* muestra un error en una web | El mensaje dice qué archivo o arreglo no encontró; la sincronización nunca retira productos si el repositorio viene vacío |
| Aviso "pooled" al subir secretos | Usaste la cadena con `-pooler`; usa *Direct connection* |

## Lo que no se pudo probar desde aquí

Sí se probaron: la imagen de Docker arrancando contra un Postgres sin superusuario (migraciones, cuentas, sincronización de las seis webs
desde GitHub, PWA, resolver, catálogo, configuraciones y PDF), `wrangler deploy --dry-run` del Worker de Scan-bar y de las seis webs, y las
seis webs encontrando Scan-bar solas en `*.forgex.workers.dev` (simulado en Chromium). **No** se publicó nada en una cuenta real de
Cloudflare ni de Neon: el primer despliegue es el que lo confirma.
