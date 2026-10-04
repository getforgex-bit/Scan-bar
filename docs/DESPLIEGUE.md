# Despliegue gratuito: las webs en Cloudflare y Scan-bar en tu PC

Todo cuesta $0 y no pide tarjeta:

| Qué | Dónde | Dirección |
|---|---|---|
| Las seis webs | Cloudflare Workers (plan gratuito), un Worker por repositorio | `https://<web>.<tu-cuenta>.workers.dev` |
| Worker `scan-bar` (dirección fija de Scan-bar) | Cloudflare Workers (plan gratuito), repositorio `Scan-bar` | `https://scan-bar.<tu-cuenta>.workers.dev` |
| Servidor de Scan-bar (app, base de datos, sincronización) | **Tu PC**, con el panel *Servidor Scan-bar* | túnel gratuito de Cloudflare (cambia en cada encendido; no hace falta conocerlo) |

**Cómo encaja**: al encender, el panel arranca en tu PC la base de datos (PostgreSQL embebido, sin instalar nada aparte) y la app, abre un
túnel gratuito de Cloudflare hacia ella (sin abrir puertos en tu router) y le dice al Worker `scan-bar` la dirección del túnel. Las webs, los
QR y la consola siempre usan `https://scan-bar.<tu-cuenta>.workers.dev`; el Worker pasa cada visita a tu PC, firmada con una llave que solo
conocen el Worker y tu panel (lo que llegue al túnel sin esa llave se rechaza). Con la PC apagada, el Worker responde "Scan-bar está apagado"
y las webs siguen funcionando con sus propios productos.

**Los nombres importan**: cada Worker se llama como su repositorio en minúsculas (lo que Cloudflare propone al importarlo) y coincide con el
`name` de su `wrangler.jsonc`. Con todo en `*.<tu-cuenta>.workers.dev`, cada web encuentra a Scan-bar sola y Scan-bar sabe a qué web
redirigir cada código. Usa **Workers**, no Pages.

## 1. Cloudflare: las seis webs y el Worker `scan-bar` (una vez)

Para cada uno de los siete repositorios: **Workers & Pages → Create → Import a repository** → el repositorio → **Deploy**, sin cambiar
nada (rama `main`, build command vacío, deploy command `npx wrangler deploy`, directorio raíz `/`). Cada push a `main` vuelve a publicar.

| Repositorio | Worker | Qué hace Cloudflare |
|---|---|---|
| `yokrem`, `dulce-encanto`, `La-picosita-de-la-sierra`, `biker-lifestyle` | igual que el repo, en minúsculas | Publica la página, sus scripts e imágenes |
| `Cafe-Motz`, `nova-core` | `cafe-motz`, `nova-core` | Instala dependencias, compila con Vite y publica `dist/` |
| `Scan-bar` | `scan-bar` | Publica el Worker que da la dirección fija (no corre la app: esa va en tu PC) |

Si ya habías importado `Scan-bar` con la versión de contenedores, no hace falta borrar nada: el siguiente despliegue (*Retry deployment* o
cualquier push a `main`) publica la versión gratuita.

## 2. Tu PC: el panel del servidor

Requisitos: **Node.js 22.12 o superior** ([nodejs.org](https://nodejs.org), versión LTS) y el repositorio `Scan-bar` descargado
(*Code → Download ZIP* en GitHub, o `git clone`). Git es opcional: sin él, la sincronización descarga los archivos por HTTP.

- **Windows**: doble clic en **`Servidor Scan-bar.cmd`** (o, en una terminal dentro de la carpeta, `npm run servidor`).
- **macOS / Linux**: `sh servidor.sh` (o `npm run servidor`).

La primera vez instala lo necesario sola (unos minutos, con internet); no hace falta `npm install`.

Se abre el panel en el navegador (`http://127.0.0.1:4100`, solo accesible desde tu PC) y queda una ventana negra: déjala abierta mientras uses
Scan-bar. Cerrarla (o Ctrl+C) apaga todo en orden.

### Primera vez: conectar el panel con Cloudflare

En el panel, pestaña **Datos → Conexión con Cloudflare**:

1. **Copia la llave** (botón *Copiar*).
2. En Cloudflare: **Workers & Pages → scan-bar → Settings → Variables and Secrets → Add** → tipo **Secret**, nombre
   `SCANBAR_PROXY_KEY`, valor: la llave → **Deploy**.
3. En el panel, escribe la dirección del Worker (`https://scan-bar.<tu-cuenta>.workers.dev`, la ves en Cloudflare) → **Guardar**.

### Uso diario

Pestaña **Servidor** → el botón **Encender**. En menos de un minuto queda *Encendido* y muestra la dirección pública. La primera vez crea la
base de datos, las cuentas y sincroniza los productos de las seis webs desde GitHub; después revisa los repositorios cada 10 minutos.
El botón **Apagar** cierra todo en orden y avisa a Cloudflare.

La pestaña **Datos** muestra: estado y si responde desde internet, productos y códigos por web, pedidos con código, escaneos y ventas del día,
tamaño de la base, última sincronización de cada web, las cuentas con sus contraseñas, y el **registro en vivo** (filtrable, con copia), que
también se guarda en `.servidor/registro.log`.

### Actualizar Scan-bar

El panel compara tu copia con GitHub al abrirse y cada 6 horas. Si hay una versión nueva, la pestaña **Servidor** muestra
*Hay una versión nueva de Scan-bar* → **Actualizar Scan-bar** (también en **Datos → Versión de Scan-bar**). Descarga solo
los archivos que cambiaron; si el servidor estaba encendido lo apaga y lo vuelve a encender; el panel se reinicia solo,
instala lo que haga falta y prepara la app nueva (~1 minuto). Tus datos (`.servidor/`: base, llave y contraseñas) no se tocan.
En el navegador, la app se recarga sola con la versión nueva; al pie dice **"Versión del …"** con la fecha en que se preparó.

**Si tu panel todavía no tiene ese botón** (copias anteriores al 4 de octubre de 2026), una sola vez: cierra la ventana negra
y, en una terminal abierta en la carpeta de Scan-bar (la que tiene `package.json`), ejecuta

```
curl -L https://codeload.github.com/getforgex-bit/Scan-bar/tar.gz/refs/heads/main -o scanbar.tgz && tar -xzf scanbar.tgz --strip-components=1 && del scanbar.tgz
```

(en macOS / Linux, `rm` en lugar de `del`). Después abre el panel como siempre (`npm run servidor` o doble clic).

### Cuentas

El panel genera las contraseñas la primera vez y las muestra en **Datos → Cuentas**:
- SuperAdmin `admin@scanbar.mx`: en la app, botón **Administración** (arriba a la derecha) o `…/admin`: un solo campo, su contraseña
  (la vuelve a pedir tras 15 minutos sin uso). En el panel, *Datos → Cuentas → Abrir Administración*. Desde ahí,
  *Tarjetas de acceso → Descargar las tarjetas de todos los negocios (PDF)*.
- Cajas `caja.<negocio>@scanbar.mx` (modo Caja de cada negocio).
- **Tarjetas de acceso**: *Datos → Cuentas → Descargar tarjetas de acceso (PDF)*. Imprime y entrega a cada negocio su tarjeta:
  escaneándola en Scan-bar (pestaña Escáner, sin sesión) o con la cámara del teléfono entra como su caja, sin contraseña.
  Descargar otra vez reimprime las mismas (las entregadas siguen sirviendo); si una se pierde, *Administración → Tarjetas de acceso →
  Generar otra*. Configura antes la *Conexión con Cloudflare* para que también funcionen con la cámara.

Para usar otras contraseñas, edita `.servidor/config.json` (`adminPassword`, `cajaPassword`; 12+ caracteres, sin `admin` ni
`caja.<negocio>`) y vuelve a encender: el secreto manda y se cierran las sesiones abiertas.

### Qué guarda tu PC

Todo en la carpeta `.servidor/` del repositorio (fuera de git): `config.json` (llave y contraseñas; no lo compartas), `postgres/` (la base de
datos), `registro.log` y `bin/cloudflared` (se descarga solo la primera vez si no lo tienes instalado). **Respaldo**: con el servidor
apagado, copia la carpeta `.servidor/` completa.

## Si algo falla

| Síntoma | Qué hacer |
|---|---|
| El panel dice "La llave no coincide…" | Vuelve a copiar la llave del panel al secreto `SCANBAR_PROXY_KEY` del Worker (paso 2) |
| "Al Worker le falta el secreto SCANBAR_PROXY_KEY" | Agrega el secreto (paso 2) |
| "El Worker respondió 404/500…" | El Worker `scan-bar` aún tiene una versión anterior: *Deployments → Retry deployment* en Cloudflare |
| "A Windows le falta Microsoft Visual C++ Redistributable" | Instálalo ([vc_redist.x64.exe](https://aka.ms/vs/17/release/vc_redist.x64.exe)) y vuelve a encender |
| "No se pudo abrir initdb / postgres / cloudflared" | Un antivirus lo bloquea: permite la carpeta de Scan-bar y vuelve a encender |
| `"tsx" no se reconoce como un comando` | Copia anterior del repositorio: descarga la versión actual (ya instala sola) o ejecuta `npm install` una vez |
| La app no muestra algo nuevo (p. ej. dice *Catálogo* en vez de *Catálogo y etiquetas*) | Mira el pie de la app (*Versión del …*). Si es vieja, actualiza (sección *Actualizar Scan-bar*) y recarga la página una vez |
| "No se pudo descargar cloudflared" | Instálalo a mano ([descargas de Cloudflare](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)) y vuelve a encender |
| "El panel ya está abierto" | Ya hay un panel corriendo: abre `http://127.0.0.1:4100` |
| Encendido pero "No responde desde internet" | Revisa la conexión de la PC; el panel reintenta solo y vuelve a avisar a Cloudflare |
| Una web no muestra los productos de Scan-bar | Su Worker no se llama como su repositorio, o está en `pages.dev` / dominio propio sin `data-url` |
| Sincronización con error "límite de consultas" | Sin Git, GitHub permite 60 consultas por hora; instala Git o define `SYNC_GITHUB_TOKEN` |

## Límites de este esquema

- Scan-bar solo funciona mientras tu PC esté encendida, conectada y con el servidor encendido. Las webs siempre funcionan; sin Scan-bar no
  muestran los productos agregados en la consola ni generan códigos de pedidos, y los QR muestran "Scan-bar está apagado".
- El túnel rápido de Cloudflare es gratuito y sin cuenta, pero sin garantía de servicio; si se cae, el panel lo vuelve a abrir.
- El plan gratuito de Workers admite 100 000 peticiones al día (de sobra para el proyecto).

## Otra opción: un servidor en la nube

El `Dockerfile` sigue sirviendo para cualquier servicio que corra contenedores con una base PostgreSQL (`DATABASE_URL`) y los secretos de
`apps/api/src/bootstrap.ts`. Si el servidor queda expuesto a internet, define `PROXY_KEY` y apunta el Worker a él con el mismo
`POST /__scanbar/origen` que usa el panel (ver `cloudflare/src/index.ts`).

## Verificado

En este entorno: el Worker en el runtime local de Cloudflare (`wrangler dev`, con su Durable Object) delante del servidor encendido desde el
panel: PWA, resolver, catálogo, código de una bebida, inicio de sesión, rechazo de peticiones sin llave (403), "apagado" (503) al apagar,
segundo encendido con los datos conservados y cierre ordenado con Ctrl+C. Sincronización de las seis webs por git y por HTTP (255
productos). **No** se pudo probar aquí el túnel real a internet (este entorno lo bloquea) ni el panel en Windows: el primer encendido en tu
PC es la confirmación final.
