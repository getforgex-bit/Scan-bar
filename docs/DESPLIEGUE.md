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

- **Windows**: doble clic en **`Servidor Scan-bar.cmd`**. La primera vez instala lo necesario (unos minutos).
- **macOS / Linux**: `sh servidor.sh` (o `npm install` y `npm run servidor`).

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

### Cuentas

El panel genera las contraseñas la primera vez y las muestra en **Datos → Cuentas**:
- SuperAdmin `admin@scanbar.mx` (la primera vez que entres a *Administración* pide activar el segundo factor con una app de autenticación;
  guarda los códigos de recuperación).
- Cajas `caja.<negocio>@scanbar.mx` (modo Caja de cada negocio).

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
