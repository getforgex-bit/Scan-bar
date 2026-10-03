# Despliegue en Cloudflare (Scan-bar + las seis webs)

Todo vive en **una sola cuenta de Cloudflare** y una base PostgreSQL en **Neon**:

| Qué | Repositorio | Worker (nombre fijo) | URL resultante |
|---|---|---|---|
| Scan-bar (PWA, API, resolver `/01/…`) | `Scan-bar` | `scan-bar` | `https://scan-bar.<tu-cuenta>.workers.dev` |
| YOKREM | `yokrem` | `yokrem` | `https://yokrem.<tu-cuenta>.workers.dev` |
| Motz Café | `Cafe-Motz` | `cafe-motz` | `https://cafe-motz.<tu-cuenta>.workers.dev` |
| Dulce Encanto | `dulce-encanto` | `dulce-encanto` | `https://dulce-encanto.<tu-cuenta>.workers.dev` |
| Nova Core | `nova-core` | `nova-core` | `https://nova-core.<tu-cuenta>.workers.dev` |
| La Picosita de la Sierra | `La-picosita-de-la-sierra` | `la-picosita-de-la-sierra` | `https://la-picosita-de-la-sierra.<tu-cuenta>.workers.dev` |
| Biker Lifestyle | `biker-lifestyle` | `biker-lifestyle` | `https://biker-lifestyle.<tu-cuenta>.workers.dev` |

**Por qué los nombres importan**: cada Worker se llama como su repositorio en minúsculas, que es el nombre que Cloudflare propone al
importarlo, y debe coincidir con el `name` de su `wrangler.jsonc` (si no, la compilación falla). Con todo en `*.<tu-cuenta>.workers.dev`
nada se configura a mano: cada web encuentra Scan-bar en `scan-bar.<tu-cuenta>.workers.dev`, Scan-bar acepta sus peticiones (CORS de la
misma cuenta) y sabe a qué URL redirigir los códigos de cada negocio (`worker` en `apps/api/src/sync.ts`). Usa **Workers**, no Pages: en
`*.pages.dev` no aplica nada de esto (ver "Dominios propios").

**Despliegue por defecto**: los siete repositorios se publican con *Workers & Pages → Create → Import a repository* dejando todo como
Cloudflare lo propone (rama `main`, build command vacío, deploy command `npx wrangler deploy`, directorio raíz `/`). Las webs de React
se compilan solas (`build.command` en su `wrangler.jsonc`) y Scan-bar construye su imagen de Docker en la nube. Cada push a `main` vuelve a
publicar.

## 0. Antes de empezar

- **Ramas unidas a `main`** en los siete repositorios (ya hecho). Scan-bar sincroniza el catálogo leyendo la rama principal de cada web y
  Cloudflare publica desde `main`.
- **Cuenta de Cloudflare** con el plan **Workers Paid** (lo exige Containers, que usa solo Scan-bar; las seis webs caben en el plan gratuito).
  Revisa el precio vigente en la página de precios de Cloudflare.
- **Cuenta de Neon** (el plan gratuito basta para el proyecto; revisa sus límites actuales).
- **Cuenta de GitHub conectada a Cloudflare** (se pide la primera vez que importas un repositorio).
- No necesitas Docker ni Node en tu computadora para el despliegue por defecto; solo para publicar desde la terminal.

## 1. Base de datos (Neon)

1. Crea un proyecto en Neon (región: la de AWS en el este de EE. UU., la más cercana a México de las que ofrece).
2. En **Connect**, copia la cadena **Direct connection** (la que **no** lleva `-pooler` en el host); termina en `?sslmode=require`.
   Scan-bar necesita conexión directa: la consola en vivo usa `LISTEN/NOTIFY`, que no funciona a través del pooler.
3. No crees tablas ni roles: Scan-bar lo hace al arrancar (migraciones y roles `app_rw`, `admin_ro`, `admin_rw` sin `BYPASSRLS`).

## 2. Scan-bar

1. **Workers & Pages → Create → Import a repository** → `Scan-bar`. Deja lo que Cloudflare propone: nombre `scan-bar`, rama `main`, build
   command vacío, deploy command `npx wrangler deploy`, directorio raíz `/`. **Deploy**.
   Cloudflare instala las dependencias, construye la imagen del `Dockerfile` y publica el Worker con su contenedor (la primera vez tarda
   varios minutos).
2. **Secretos** (una vez). En el panel: *scan-bar → Settings → Variables and Secrets → Add*, tipo **Secret**, uno por fila de la tabla. O
   desde tu computadora, en la raíz del repositorio: `npm install`, `npx wrangler login` y `npm run cf:secrets`, que pregunta lo necesario y
   genera el resto.
3. **Reinicia con los secretos**: *Deployments → Retry deployment* (o un push a `main`, o `npm run cf:deploy`).

| Secreto | De dónde sale |
|---|---|
| `DATABASE_URL` | La cadena *Direct connection* de Neon |
| `ADMIN_PASSWORD` | Contraseña del SuperAdmin `admin@scanbar.mx` |
| `CAJA_PASSWORD` | Contraseña de las cuentas `caja.<negocio>@scanbar.mx` |
| `DB_APP_RW_PASSWORD`, `DB_ADMIN_RO_PASSWORD`, `DB_ADMIN_RW_PASSWORD` | Aleatorias, de 32 caracteres o más (roles internos de Postgres; nadie necesita conocerlas). En una terminal: `openssl rand -hex 24` |
| `TOTP_ENC_KEY` | 32 bytes aleatorios en base64 (cifra los segundos factores): `openssl rand -base64 32`. **No la cambies nunca** |

Las contraseñas deben tener al menos 12 caracteres y no contener la parte del correo antes de la `@` (`admin`, `caja.yokrem`…).
`npm run cf:secrets` las valida, genera las aleatorias y conserva `TOTP_ENC_KEY` si ya existe. También acepta valores por entorno:
`ADMIN_PASSWORD=… CAJA_PASSWORD=… DATABASE_URL=… npm run cf:secrets`.

**Desde la terminal en vez del panel** (necesita Docker en marcha): `npm install`, `npx wrangler login`, `npm run cf:deploy`.

El flujo de GitHub Actions (`.github/workflows/pruebas.yml`) solo prueba: tipos, configuración de Cloudflare, pruebas y compilación.

### Qué pasa en el primer arranque

La primera petición despierta el contenedor (unos segundos; mientras, el Worker responde 503 "Scan-bar está arrancando"). Al arrancar:
migraciones → seis negocios con sus prefijos (`0010`–`0015`) → SuperAdmin y una caja por negocio → servidor → **sincronización de las seis
webs desde GitHub** (todos sus productos con su código). Después revisa los repositorios cada 10 minutos (`SYNC_INTERVAL_MIN`) y solo
vuelve a leer los que cambiaron. El contenedor se duerme tras 20 minutos sin peticiones; la base vive aparte y no se pierde nada.

Registro en vivo: *scan-bar → Logs* en el panel, o `npm run cf:logs`.

## 3. Las seis webs

Para cada repositorio: **Workers & Pages → Create → Import a repository** → el repositorio → **Deploy**, sin cambiar nada. El nombre que
propone Cloudflare (el del repositorio en minúsculas) ya es el de su `wrangler.jsonc`.

| Web | Qué hace Cloudflare con los valores por defecto |
|---|---|
| YOKREM, Dulce Encanto, La Picosita, Biker Lifestyle | `npx wrangler deploy` publica la página, sus scripts e imágenes (`.assetsignore` deja fuera `.git`, los `.md` y la configuración) |
| Motz Café, Nova Core | Instala dependencias (por `package-lock.json` o `bun.lock`) y `npx wrangler deploy` compila con Vite (`build.command`) y publica `dist/` |

Desde la terminal también funciona: `npx wrangler deploy` en las estáticas y `npm run deploy` en las de React.

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

- **Cambiar una contraseña**: cambia el secreto (panel o `npm run cf:secrets`) y vuelve a desplegar (*Retry deployment*). Al arrancar,
  la cuenta toma la contraseña del secreto y se cierran sus sesiones abiertas.
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
| 503 "Scan-bar está arrancando" más de un minuto | Registro del Worker (*Logs* o `npm run cf:logs`): suele ser un secreto que falta ("Falta la variable de entorno …") o `DATABASE_URL` mal copiada |
| "La contraseña de … no sirve" en el registro | La contraseña no cumple las reglas (12 caracteres, sin la parte del correo) |
| Una web no muestra los productos de Scan-bar | Su Worker no se llama como en la tabla, o está en `pages.dev` / dominio propio sin `data-url` |
| "The name in your Wrangler configuration file … must match the name of your Worker" | Al importar se cambió el nombre propuesto; usa el de la tabla |
| Motz Café o Nova Core no muestran el código del pedido | Scan-bar estaba dormido y tardó (el siguiente pedido ya lo trae), o aún no sincroniza la leche, los extras o los servicios (*Sincronizar ahora*) |
| *Sincronizar ahora* muestra un error en una web | El mensaje dice qué archivo o arreglo no encontró; la sincronización nunca retira productos si el repositorio viene vacío |
| Aviso "pooled" al subir secretos | Usaste la cadena con `-pooler`; usa *Direct connection* |

## Lo que no se pudo probar desde aquí

Sí se probaron: la imagen de Docker arrancando contra un Postgres sin superusuario (migraciones, cuentas, sincronización de las seis webs
desde GitHub, PWA, resolver, catálogo, configuraciones y PDF), `wrangler deploy --dry-run` de los siete repositorios desde su raíz y sin
`dist/` (las de React se compilan solas), y las seis webs encontrando Scan-bar solas en `*.forgex.workers.dev` (simulado en Chromium). **No** se publicó nada en una cuenta real de
Cloudflare ni de Neon: el primer despliegue es el que lo confirma.
