# Integración de las páginas web con Scan-bar

Un solo sistema: las seis páginas web de los negocios (YOKREM, Motz Café, Dulce Encanto, Nova Core, La Picosita de la Sierra y Biker Lifestyle) usan la base de datos de Scan-bar como registro único de productos y códigos. Proyecto universitario: la solución es deliberadamente simple (un monolito, sin colas ni servicios extra) y cada web sigue funcionando igual si Scan-bar no está disponible.

## Qué resuelve

| Pedido | Cómo queda |
|---|---|
| Agregar productos a cada página y que se registren con su código de barras automáticamente | *Administración → Productos y etiquetas*: eliges la web, capturas el producto (con variantes si las tiene) y Scan-bar emite el GTIN-13 de cada variante en la misma transacción. La web lo lee de `GET /v1/public/t/:slug/catalog` y lo pinta con su propio diseño. |
| PDF con todos los códigos de una página, con el nombre encima, para recortar y pegar | En la misma sección, *Descargar PDF*: hoja carta o A4 con guías de corte; cada etiqueta lleva el nombre arriba, el SKU y el EAN-13 a tamaño nominal (QR opcional). |
| Ocultar el modo configurable de Scan-bar y responder a las configuraciones de las páginas | La pestaña *Configurador* de la PWA queda oculta (`SHOW_CONFIGURATOR = false` en `apps/web/src/App.tsx`). Las configuraciones se arman en cada web y Scan-bar emite su código (`POST /v1/public/t/:slug/configurations`). Las variantes que define cada web (talla, tamaño, gramaje) son productos con código propio. |
| Sistema unificado con la base de datos de Scan-bar | Un catálogo, un contador de GTIN por negocio, un resolver y una Caja para las seis webs; contrato HTTP único y cliente común en cada web. |

## Arquitectura

```
                        ┌──────────────────────────── Scan-bar (Fastify + PostgreSQL) ───────────────────────────┐
  repos de las webs ──► │ npm run sync:repos ─► products (origin='repo')  ─┐                                       │
  (código = catálogo)   │                                                  ├─► codes (GTIN-13 único) ─► /01/:gtin14 │
  Administración ─────► │ POST /v1/admin/products ─► products (origin='scanbar')                    resolver      │
                        │ GET  /v1/admin/tenants/:id/labels.pdf ─► hoja de etiquetas                              │
                        │ GET  /v1/labels.pdf (negocio: la suya · admin: ?tenant=…|*) ─► hoja de etiquetas         │
                        │ GET  /v1/public/t/:slug/catalog ◄────────── web: pinta lo agregado desde Scan-bar        │
                        │ POST /v1/public/t/:slug/configurations ◄─── web: bebida / ensamble → builds + GTIN       │
                        │ PWA: Escáner (Navegación/Caja) cobra cualquier código de las seis webs                   │
                        └──────────────────────────────────────────────────────────────────────────────────────────┘
```

### Quién administra cada producto (`products.origin`)

| Origen | Se define en | Se cambia en | Lo retira |
|---|---|---|---|
| `repo` | el código de la web (`js/products.js`, `coffeeData.ts`, `hardware.ts`…) | el repositorio de la web + `npm run sync:repos` | la sincronización, cuando desaparece del código |
| `scanbar` | *Administración → Productos y etiquetas* | la misma consola | la consola (*Retirar*; nunca se borra, se puede reactivar) |

La sincronización no toca ni retira productos `scanbar`; si un SKU del código choca con uno `scanbar`, lo omite y avisa. La consola solo permite ajustar existencias de un producto `repo` (lo demás lo pisaría la siguiente sincronización). Los negocios de ejemplo de la semilla (`tienda-000X`) son `scanbar`.

### Variantes = configuraciones de producto de cada web

Cada talla, tamaño o gramaje es un producto con su propio GTIN (así lo pide GS1 y así la etiqueta física identifica exactamente lo que se vende). Se agrupan con `variant_of` (SKU base) y `variant` (etiqueta). SKU de cada variante: `SKU-BASE-VARIANTE`.

| Web | Variante | Producto del código (sync) | Producto agregado en Scan-bar |
|---|---|---|---|
| YOKREM | talla (CH, M, G, EG) | `top-blanco-crop-M` | categoría = temporada (`verano`, `otono`, `invierno`); variantes = tallas |
| Motz Café | tamaño | `americano-ch` / `americano-gde` (+ leche y extras como productos `modificador`) | categoría = pestaña del menú; hasta 2 variantes (chico, grande) |
| Dulce Encanto | — | `pastel-chocolate` | categoría `pasteles`, `cupcakes` o `galletas`; cada variante es un renglón del menú |
| Nova Core | variante del componente | `CPU-ZEN5-00`, variantes con su SKU; servicios de ensamble `ENS-*` | categoría de Nova Core (`cpu`, `gpu`, `ram`…); atributos `marca`, `socket`, `chipset`, `chipsets`, `tdp_w` |
| La Picosita | gramaje | `CUR-01-250G` | categoría `curtido` o `salsa`; variantes en gramos (`270 g, 450 g`) |
| Biker Lifestyle | talla de casco | `BKR-CS01-M` | categoría `gorras` (atributo `linea`), `cascos` (variantes = tallas) o `accesorios` |

Lo que la web no sabe pintar (categoría desconocida, variantes que no encajan) se omite con un aviso en la consola del navegador; nunca rompe la página.

## Contrato HTTP para las webs

Sin sesión ni cookies (`credentials: 'omit'`). CORS solo para los dominios del negocio (`tenants.allowed_domains`, los mismos a los que redirige el resolver) y para `localhost`/`127.0.0.1`; la página abierta como archivo (`Origin: null`) solo fuera de producción.

**`GET /v1/public/t/:slug/catalog`** (120/min por IP, `Cache-Control: max-age=60`): productos activos de origen `scanbar`, agrupados por variante. No expone GTIN ni existencias exactas.

```json
{ "tenant": { "slug": "yokrem", "name": "YOKREM" },
  "products": [{ "sku": "VESTIDO-LINO-ROJO", "name": "Vestido de lino rojo", "category": "verano", "description": "…", "imageUrl": null,
                 "attrs": { "color": "Rojo" }, "priceCents": 74900,
                 "variants": [{ "sku": "VESTIDO-LINO-ROJO-CH", "label": "CH", "priceCents": 74900, "inStock": true }] }],
  "generatedAt": "…" }
```

**`POST /v1/public/t/:slug/configurations`** (30/min por IP; requiere `X-Requested-With` y `Content-Type: application/json`):

```json
{ "label": "Bebida", "lines": [{ "sku": "americano-gde", "qty": 1 }, { "sku": "LECHE-AVENA", "qty": 1 }] }
```

- Responde `{ gtin, kind, label, name, reused, totalCents, taxCents, lines[], digitalLink, svg: { ean13, qr } }`; `svg` son rutas de `GET /v1/codes/:gtin.svg` (público, `Access-Control-Allow-Origin: *`) para mostrar el código con `<img>`.
- Los precios salen de Scan-bar y quedan congelados en el código; lo que mande el cliente se ignora.
- Misma lista + misma etiqueta ⇒ mismo GTIN (hash determinista; `reused: true`). Una sola unidad de un solo producto devuelve el código propio del producto (no se emite otro).
- `label` es una lista cerrada (`Pedido`, `Bebida`, `Ensamble`, `Paquete`, `Personalizado`): el texto aparece en la ficha del resolver y en Caja.
- `configurator` (opcional) aplica además las reglas de un configurador de Scan-bar (motor `packages/codes/src/rules.ts`). Sin él, Scan-bar valida existencia, negocio y estado de cada SKU y la web valida su compatibilidad (Nova Core ya bloquea zócalos incompatibles).
- Errores: 422 `producto_invalido` con la lista de SKU que no existen o están retirados; 403 `origen_no_permitido`; 429 con `Retry-After`.

En Caja, el código de una configuración se escanea como cualquier otro: muestra su contenido con precios congelados y al cobrarlo descuenta existencias de cada componente.

## Qué hace cada web

| Web | Productos agregados en Scan-bar | Configuración → código |
|---|---|---|
| YOKREM, Dulce Encanto, La Picosita, Biker Lifestyle (estáticas) | `scanbar.js` (mismo archivo en las cuatro) los trae antes de pintar el catálogo; con copia local arranca al instante y la refresca para la siguiente visita | — (sus configuraciones son variantes con código propio) |
| Motz Café (React) | `src/lib/scanbar.ts` → `useMenuScanbar()` los suma al menú | Cada bebida del pedido (tamaño + leche + extras) recibe su código: se ve en el pedido con su código de barras y viaja en el mensaje de WhatsApp |
| Nova Core (React) | `cargarExtrasScanbar()` los suma al catálogo antes del primer render | *Proceder al pedido de ensamble* y *Guardar presupuesto PDF* registran el ensamble (componentes + servicios); el código aparece en el carrito y como EAN-13 en el PDF |

Los precios de los modificadores de Motz Café (`MODIFICADORES` en `coffeeData.ts`) y de los servicios de ensamble de Nova Core (`BUILD_SERVICES` en `services.ts`) pasaron a ser datos: una sola fuente que usa la página y que la sincronización registra en Scan-bar.

## Configurar

Con todo publicado en la misma cuenta de Cloudflare (`<web>.<tu-cuenta>.workers.dev` y `scan-bar.<tu-cuenta>.workers.dev`) **no hay nada que
configurar**: cada web deduce la URL de Scan-bar de su propio host, Scan-bar acepta a las webs de su misma cuenta (CORS) y aprende la URL de
cada una (`worker` en `apps/api/src/sync.ts`) para que el resolver redirija ahí. Pasos completos: [DESPLIEGUE.md](DESPLIEGUE.md).

Fuera de `workers.dev` (dominio propio o Pages):
- **Scan-bar**: secreto `WEB_URL_<NEGOCIO>` con la URL de la web (o *Administración → Negocios → Editar*: plantilla y dominios permitidos).
- **Estáticas**: `data-url="https://…"` en la etiqueta `<script src="scanbar.js" … data-tienda="…">` (`off` la apaga).
- **Motz Café y Nova Core**: `VITE_SCANBAR_URL` al compilar (variable de build en Cloudflare; `off` la apaga).
- **Biker Lifestyle**: su CSP ya admite `*.workers.dev`; si Scan-bar vive en otro dominio, agrégalo a `connect-src` en `public/_headers`.

El catálogo del código de cada web se sincroniza solo (al arrancar y cada 10 minutos, solo los repositorios que cambiaron; *Sincronizar ahora*
en la consola lo fuerza). `npm run sync:repos` hace lo mismo a mano (`-- --local=../` lee las webs de una carpeta).

## Demostración local (sin publicar nada)

```bash
# Scan-bar
npm run dev:db & npm run migrate && npm run seed
npm run sync:repos -- --local=..        # las seis webs clonadas junto a Scan-bar
npm run build && npm start              # http://localhost:3000
# Una web, p. ej. YOKREM
cd ../yokrem && python -m http.server 8001
# Abre http://localhost:8001/?scanbar=http://localhost:3000  (se recuerda en la pestaña; ?scanbar= lo olvida)
```

Luego, en Scan-bar: *Administración → Productos y etiquetas* → YOKREM → agrega un producto con variantes `CH, M, G, EG` → recarga la web: aparece en la tienda. *Descargar PDF* → imprime al 100 % → recorta → escanea una etiqueta en modo Caja.

## Decisiones y límites

- **Las webs no dependen de Scan-bar**: fuera de `workers.dev` y sin URL configurada no hacen ninguna petición; con Scan-bar caído o dormido pintan solo sus productos (verificado en las seis con Chromium).
- **Copia local del catálogo**: la web estática usa la última copia guardada y la actualiza para la siguiente visita; un producto recién agregado o retirado se refleja a la siguiente carga (Motz Café lo refleja en cuanto responde). La primera visita espera como máximo 1.5 s.
- **Compatibilidad**: la web valida sus reglas; Scan-bar las aplica solo si la web pide un `configurator`. Un cliente podría registrar un ensamble incompatible llamando a la API directamente; el código solo describe y congela el precio, la venta la hace el personal en Caja.
- **Las configuraciones de las webs no se ligan a cuentas de Scan-bar** (sin cookies entre sitios): no aparecen en *Mis configuraciones*.
- **Pastel personalizado de Dulce Encanto**: sigue cotizándose por WhatsApp; no tiene precio fijo que congelar en un código.
- **Precios mostrados vs. registrados**: si la web tiene una copia vieja del precio, manda el de Scan-bar (`totalCents` de la respuesta).
- **Etiquetas**: EAN-13 al 100 % del tamaño nominal (módulo de 0.33 mm, barras truncadas a ~11 mm de alto para caber en la etiqueta) o al 80 %. Imprimir con "tamaño real". Los códigos del PDF se verificaron decodificándolos con ZXing (`tests/webs.test.ts`).
- **Límites de tasa en memoria**: hay una sola instancia del contenedor (`max_instances: 1`); con varias habría que moverlos a la base o a Redis. Las sesiones ya viven en la base.
- **Prefijo 750**: académico; para circular en comercio abierto se requiere licencia GS1 México.
