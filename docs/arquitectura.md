Sistema Universal de Códigos — Documento de Arquitectura
Plan maestro de implementación técnica (SAD) · Sep 30, 2026 · @Forgex
Decisiones clave
El sistema es un monolito modular en TypeScript (Node.js + PostgreSQL) que actúa como resolver central: cada código —EAN-13 o QR— es una llave que el servidor traduce a una URL o a un registro de venta. Se conserva la idea correcta del material base (el EAN-13 solo guarda 13 dígitos y funciona como matrícula), pero se corrigen seis puntos.
#
Material base
Decisión en este documento
Motivo

1
Ejemplo 7500002000894 para la base 750000200089
Ese código falla el módulo 10; el correcto es 7500002000891. Todo código se valida antes de persistirse y en una prueba automatizada.
Un ejemplo inválido en el documento entregado es un error de rigor visible para el evaluador.

2
750 + 4 dígitos de empresa inventados
Prefijo configurable por tenant: 750 + bloque de empresa simulado en el entorno académico; rango de circulación restringida GS1 (20–29) como opción para la PoC real.
750 es el espacio de GS1 México; un número 750… no licenciado puede coincidir con un GTIN real de otra empresa.

3
html5-qrcode o @zxing/library
BarcodeDetector nativo cuando existe; ponyfill barcode-detector (ZXing-C++ en Wasm) en Safari, Firefox y escritorio.
html5-qrcode está en modo mantenimiento: su autor ya no corrige errores ni acepta cambios; Wasm cumple la meta de < 300 ms.

4
JsBarcode en el navegador
SVG generado en el servidor con bwip-js, devuelto junto con el número.
La restricción pide SVG del servidor en < 200 ms; un render único evita diferencias entre dispositivos.

5
QR con URL arbitraria
QR con sintaxis GS1 Digital Link (https://id.<dominio>/01/<GTIN-14>).
Un mismo QR abre la web en cualquier cámara y entrega el GTIN al POS sin red externa.

6
SQLite y id secuencial como código
PostgreSQL con Row-Level Security por tenant_id, contador atómico por empresa y BOM inmutable con precios congelados.
El aislamiento por tenant se garantiza en la base, no solo en el código; el escaneo futuro reconstruye la máquina exacta.

Lo que no se incluye a propósito: microservicios separados, colas de mensajes, Kubernetes ni IA. Ningún requisito los justifica para 9 tenants; el generador de códigos es un módulo con frontera clara que puede extraerse después si la PoC crece.
1. Resumen ejecutivo y arquitectura multi-tenant
Una sola PWA y un solo servidor atienden a las 9 empresas: el servidor genera códigos, resuelve escaneos y registra ventas; las webs de los equipos solo reciben redirecciones. Las empresas no dependen unas de otras ni comparten datos, porque cada fila lleva tenant_id y PostgreSQL filtra por él.

arquitectura · 3 clientes, 4 módulos, 2 destinos
La PWA usa la API en modo caja y el resolver en modo navegación; una cámara cualquiera llega al mismo resolver por el QR. Solo el resolver habla con las webs externas, y solo con un 302.
Componentes
Componente
Responsabilidad
Tecnología

PWA (escáner, POS, configurador, admin)
Cámara, decodificación local, carrito, interfaz
Vite + React + TypeScript, vite-plugin-pwa

API /v1
Autenticación, catálogo, ensambles, ventas, escaneos
Node.js 22 LTS + Fastify, validación con Zod

Resolver id.
GET /01/{gtin14} → redirección 302 a la web del tenant
Mismo proceso Fastify, ruta pública sin sesión

Motor de códigos
Asignar, validar y dibujar EAN-13 y QR
Módulo interno codes/ + bwip-js

Base de datos
Fuente de verdad, aislamiento, auditoría
PostgreSQL 16 con RLS, ORM Drizzle

Observabilidad
Bitácora de peticiones, métricas, eventos en vivo
Tabla http_log + Server-Sent Events

Monitor de enlaces
Revisa cada 6 h que las URLs destino respondan
Tarea programada node-cron en el mismo proceso

Por qué un monolito modular
Nueve tenants y unos cientos de escaneos por día caben en un solo proceso con holgura. Separar en microservicios añadiría red, despliegues y fallos parciales sin resolver ningún requisito. Las fronteras se mantienen en el código: codes/, scan/, pos/, builds/, admin/ y tenancy/ solo se comunican por funciones tipadas.
URLs canónicas sin redirecciones rotas
Las webs de los equipos tienen estructuras distintas y pueden caerse; por eso ningún código impreso contiene su URL. Cada tenant registra una plantilla (https://equipo3.ejemplo.mx/producto/{sku}) y el resolver la expande al momento del escaneo. Si un equipo cambia su web, se edita una plantilla y todos los códigos impresos siguen funcionando.
Cuando el destino falla la revisión periódica, el resolver muestra una ficha de respaldo propia (nombre, precio, BOM) en lugar de un error 404.
Despliegue
Entrega académica: docker compose con dos contenedores (app y Postgres) en un VPS o en Render/Railway; HTTPS obligatorio, porque getUserMedia no funciona sin contexto seguro.
PoC real: el mismo contenedor detrás de un dominio propio con subdominio id. para el resolver; Postgres administrado (Neon o Supabase) con respaldos diarios.
2. Modelo de datos relacional
El esquema tiene 13 tablas; la pieza central es codes, un registro único de todos los GTIN emitidos que apunta, con integridad referencial, a un producto o a un ensamble. Así un escaneo se resuelve con una sola búsqueda por llave primaria, sin adivinar qué tipo de código es.
Entidades
Tabla
Qué guarda
Llave y relaciones

tenants
Las 9 empresas: nombre, slug, prefijo de empresa, plantillas de URL, estado del enlace
PK id; company_prefix único

users
Cuentas con contraseña Argon2id
PK id; email único

memberships
Rol de cada usuario en cada tenant (superadmin, operador_pos)
PK (user_id, tenant_id)

products
Catálogo individual: SKU, nombre, precio en centavos, stock, categoría, atributos JSONB
PK id; único (tenant_id, sku)

code_counters
Siguiente número de artículo por tenant
PK tenant_id

codes
Cada GTIN-13 emitido, su tipo y su destino
PK gtin; FK a products o builds

builds
Ensamble de PC: hash del BOM, total congelado, estado
PK id; único (tenant_id, bom_hash)

build_items
BOM inmutable: componente, cantidad, precio al momento
PK (build_id, product_id)

sales / sale_items
Ventas del mini POS con IVA desglosado
FK a codes.gtin por renglón

scan_events
Cada lectura: modo, motor, latencia, resultado
Particionable por mes

audit_log
Quién cambió qué y cuándo (datos antes y después)
Solo inserción

http_log
Petición, estado, duración, request_id para el depurador
Retención de 14 días

DDL esencial (PostgreSQL 16)
CREATE TABLE tenants (  id              SMALLSERIAL PRIMARY KEY,  slug            TEXT UNIQUE NOT NULL,  name            TEXT NOT NULL,  gs1_prefix      TEXT NOT NULL DEFAULT '750',          -- configurable: '750' o RCN '2x'  company_prefix  TEXT NOT NULL UNIQUE CHECK (company_prefix ~ '^[0-9]{4}$'),  product_url_tpl TEXT NOT NULL,                        -- https://equipo3.mx/producto/{sku}  build_url_tpl   TEXT,                                 -- https://equipo3.mx/ensamble/{gtin}  link_status     TEXT NOT NULL DEFAULT 'unknown',      -- ok | degraded | down | unknown  created_at      TIMESTAMPTZ NOT NULL DEFAULT now());CREATE TABLE products (  id          BIGSERIAL PRIMARY KEY,  tenant_id   SMALLINT NOT NULL REFERENCES tenants(id),  sku         TEXT NOT NULL,  name        TEXT NOT NULL,  category    TEXT NOT NULL,                 -- cpu, motherboard, ram, gpu, ssd, psu, case...  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),  stock       INTEGER NOT NULL DEFAULT 0,  attrs       JSONB NOT NULL DEFAULT '{}',   -- socket, ram_type, tdp_w, form_factor  active      BOOLEAN NOT NULL DEFAULT true,  UNIQUE (tenant_id, sku));CREATE TABLE code_counters (  tenant_id SMALLINT PRIMARY KEY REFERENCES tenants(id),  next_item INTEGER NOT NULL DEFAULT 1 CHECK (next_item <= 99999));CREATE TABLE builds (  id          BIGSERIAL PRIMARY KEY,  tenant_id   SMALLINT NOT NULL REFERENCES tenants(id),  bom_hash    CHAR(64) NOT NULL,             -- SHA-256 del BOM canónico  total_cents INTEGER NOT NULL,  active      BOOLEAN NOT NULL DEFAULT true, -- especificación reutilizable; las ventas viven en sales  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),  UNIQUE (tenant_id, bom_hash));CREATE TABLE build_items (  build_id         BIGINT NOT NULL REFERENCES builds(id) ON DELETE RESTRICT,  product_id       BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,  qty              SMALLINT NOT NULL CHECK (qty > 0),  unit_price_cents INTEGER NOT NULL,         -- precio congelado al guardar  PRIMARY KEY (build_id, product_id));CREATE TABLE codes (  gtin        CHAR(13) PRIMARY KEY CHECK (gtin ~ '^[0-9]{13}$'),  tenant_id   SMALLINT NOT NULL REFERENCES tenants(id),  kind        TEXT NOT NULL CHECK (kind IN ('product','build')),  product_id  BIGINT REFERENCES products(id),  build_id    BIGINT REFERENCES builds(id),  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),  retired_at  TIMESTAMPTZ,                   -- nunca se reutiliza un GTIN  CHECK ((kind = 'product' AND product_id IS NOT NULL AND build_id IS NULL)      OR (kind = 'build'   AND build_id   IS NOT NULL AND product_id IS NULL)),  CHECK (gtin_check_ok(gtin))                -- función SQL del módulo 10 (sección 3));
Aislamiento por tenant
Cada tabla con tenant_id activa Row-Level Security. La API abre cada transacción con SET LOCAL app.tenant_id = <id>, así una consulta olvidada sin WHERE no puede leer datos de otra empresa.
ALTER TABLE products ENABLE ROW LEVEL SECURITY;CREATE POLICY tenant_isolation ON products  USING (tenant_id = current_setting('app.tenant_id')::smallint);-- La consola SuperAdmin usa un rol de BD distinto con BYPASSRLS y solo lectura.
El resolver público es la única excepción: consulta codes por llave primaria con una función SECURITY DEFINER que devuelve solo los campos necesarios para redirigir.
Por qué así
Ensambles como entidad propia, no como producto: un ensamble no tiene stock ni SKU; tiene una lista de partes. Tratarlo como producto rompería la restricción de no acoplar configuraciones a productos estáticos.
Precio congelado en build_items: si mañana cambia el precio de una RAM, escanear la máquina armada muestra lo que se cotizó ese día. La PWA muestra también el precio vigente cuando difiere.
ON DELETE RESTRICT: un componente usado en un ensamble no puede borrarse, solo desactivarse; así el escaneo futuro siempre reconstruye el BOM exacto.
Dinero en centavos enteros: evita errores de redondeo de punto flotante en totales e IVA.
3. Motor de códigos: EAN-13 México y QR dinámico
Cada código se arma con 12 dígitos estructurados más un dígito verificador módulo 10, se valida dos veces (en la aplicación y en un CHECK de la base) y nunca se reutiliza. El QR no lleva una URL arbitraria: lleva el mismo GTIN en sintaxis GS1 Digital Link.
Estructura del GTIN-13
Posición
Dígitos
Contenido
Ejemplo

1–3
3
Prefijo GS1 (750 = GS1 México)
750

4–7
4
Prefijo de empresa (uno por tenant)
0002

8–12
5
Número de artículo o ensamble, contador por tenant
00089

13
1
Dígito verificador
1

Capacidad: 99 999 artículos por empresa. Si una empresa la agota, se le asigna un segundo prefijo de empresa; nunca se reciclan números retirados.
Prefijo: entorno académico vs PoC real
Entorno
Prefijo
Condición

Proyecto universitario (9 empresas simuladas)
750 + bloque 0001–0009
Sistema cerrado: los códigos solo se leen dentro de esta plataforma.

PoC con productos que salen a tiendas
Prefijo de empresa licenciado por GS1 México
Obligatorio para circular en comercio abierto.

PoC solo en mostrador propio
Circulación restringida GS1 (20–29)
Uso interno bajo las reglas que GS1 México fija para ese rango; no se presenta como código de país.

El prefijo vive en tenants.gs1_prefix, así que cambiar de escenario es un dato, no un cambio de código.
Dígito verificador (módulo 10)
Se ponderan los primeros 12 dígitos con 1 y 3 alternados empezando por 1; el verificador completa la suma al siguiente múltiplo de 10.
C = \left(10 - \left(\sum_{i=1}^{12} d_i \cdot w_i \bmod 10\right)\right) \bmod 10, \qquad w_i = \begin{cases} 1 & i \text{ impar} \\ 3 & i \text{ par} \end{cases}

// codes/gtin.ts — sin dependencias, probado con casos GS1 conocidosexport function checkDigit(d12: string): number {  if (!/^\d{12}$/.test(d12)) throw new Error('Se esperan 12 dígitos');  let sum = 0;  for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3);  return (10 - (sum % 10)) % 10;}export const isValidGtin13 = (g: string): boolean =>  /^\d{13}$/.test(g) && checkDigit(g.slice(0, 12)) === Number(g[12]);export function buildGtin13(gs1Prefix: string, companyPrefix: string, item: number): string {  const body = gs1Prefix + companyPrefix;  const width = 12 - body.length;  if (width < 1) throw new Error('Prefijo demasiado largo');  if (!Number.isInteger(item) || item < 0 || item >= 10 ** width)    throw new Error('Rango de artículos agotado');  const d12 = body + String(item).padStart(width, '0');  return d12 + checkDigit(d12);}export const toDigitalLink = (gtin13: string, host: string) =>  `https://${host}/01/${gtin13.padStart(14, '0')}`;  // GTIN-14 obligatorio en la URI
La misma regla vive en la base para que ningún proceso pueda insertar un código inválido:
CREATE FUNCTION gtin_check_ok(g TEXT) RETURNS BOOLEANLANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$  SELECT g ~ '^[0-9]{13}$'     AND (10 - (SELECT sum(substr(g, i, 1)::int * CASE WHEN i % 2 = 1 THEN 1 ELSE 3 END)                FROM generate_series(1, 12) AS i) % 10) % 10         = substr(g, 13, 1)::int$$;
Pruebas ejecutadas sobre ambas versiones: 7500002000891 válido, 7500002000894 (el ejemplo del material base) inválido, 4006381333931 válido; en una mutación exhaustiva de un dígito del código 7500002000891, las 117 variantes fueron rechazadas.
Asignación atómica del número
Dos operadores que guardan un ensamble en el mismo milisegundo no deben recibir el mismo número. Un UPDATE … RETURNING sobre code_counters toma un candado de fila dentro de la transacción y lo libera al confirmar.
CREATE FUNCTION allocate_item(t SMALLINT) RETURNS INTEGERLANGUAGE sql AS $$  UPDATE code_counters SET next_item = next_item + 1  WHERE tenant_id = t  RETURNING next_item - 1$$;
Si la transacción se revierte, el número consumido queda como hueco. Es aceptable: GS1 no exige secuencias continuas y reutilizar números sí está prohibido.
Generación del SVG en el servidor
GET /v1/codes/{gtin}.svg?kind=ean13|qr devuelve el símbolo dibujado con bwip-js (bcid: 'ean13' o 'qrcode' con corrección de errores M). La respuesta lleva Cache-Control: public, max-age=31536000, immutable, porque un GTIN nunca cambia de dibujo. El cuerpo de POST /v1/builds incluye ya el número y el SVG en línea para que el configurador no haga una segunda petición.
Parámetros de impresión: módulo de 0.33 mm (100 %), zona de silencio de 11 módulos a la izquierda y 7 a la derecha, barras en #121316 sobre blanco; el terracota nunca se usa en barras porque reduce el contraste para el lector.
QR con GS1 Digital Link
https://id.ejemplo.mx/01/07500002000891        └ resolver ┘ └AI┘└── GTIN-14 ──┘
Una cámara de teléfono cualquiera abre la URL y el resolver redirige a la web del tenant.
La PWA, en cambio, no navega: extrae el GTIN del segmento /01/ y lo trata igual que un EAN-13. El POS funciona sin depender de la red externa.
El resolver acepta ?linkType=gs1:pip (ficha de producto) y responde 404 propio con la ficha de respaldo si el GTIN no existe o está retirado.
4. Módulo de escaneo óptico y lógica de modos
Un solo lector decodifica EAN-13 y QR en el dispositivo y entrega siempre lo mismo: un GTIN validado. El conmutador de modo decide qué hacer con él después, así ningún modo duplica la lógica de cámara.

flujo de escaneo · 2 decisiones, 2 modos
Una lectura dudosa vuelve al siguiente cuadro en lugar de mostrar un error; solo un GTIN validado llega al conmutador. Un QR que no lleva /01/ sigue la regla de dominios registrados descrita abajo.
Motor de decodificación
Navegador
Motor
Nota

Chrome y Edge en Android
BarcodeDetector nativo
Soporte completo según caniuse.

Chrome y Edge de escritorio
Nativo si getSupportedFormats() incluye ean_13; si no, Wasm
Soporte parcial que depende del sistema operativo.

Safari (iOS y macOS), Firefox
Ponyfill barcode-detector (ZXing-C++ en Wasm)
En Safari la API sigue desactivada por defecto.

La detección se hace por capacidad, nunca por user agent. El binario Wasm (≈ 1 MB) se sirve desde el propio dominio con prepareZXingModule (no desde un CDN, por CSP y modo sin conexión), se descarga en segundo plano al abrir la PWA y queda en caché del service worker; la decodificación Wasm corre en un Web Worker para no congelar la interfaz.
// scan/detector.tsimport { BarcodeDetector as Wasm } from 'barcode-detector/ponyfill';export async function createDetector() {  const formats = ['ean_13', 'qr_code'];  const Native = (globalThis as any).BarcodeDetector;  if (Native) {    const supported: string[] = await Native.getSupportedFormats();    if (formats.every(f => supported.includes(f)))      return { engine: 'native', detector: new Native({ formats }) };  }  return { engine: 'wasm', detector: new Wasm({ formats }) };}
Ciclo de captura
getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } }); la cámara trasera por defecto.
Cada cuadro se pide con requestVideoFrameCallback y se recorta a la zona del paspartú (60 % central); decodificar menos píxeles baja la latencia.
Máximo un análisis en vuelo: si el anterior no ha terminado, se descarta el cuadro.
Consenso para EAN-13: se aceptan dos lecturas idénticas consecutivas. Los códigos lineales leídos en ángulo pueden dar un dígito erróneo que aun así pase el módulo 10 por coincidencia.
Se valida el dígito verificador; un QR con /01/ se convierte a GTIN-13.
Antirrebote: el mismo GTIN se ignora 1.5 s en modo navegación; en POS, una segunda lectura suma cantidad solo tras retirar el código del encuadre.
Confirmación: línea de encuadre en terracota, tono corto con Web Audio y navigator.vibrate(30) donde exista.
Linterna y zoom se exponen solo si track.getCapabilities() los reporta.
Presupuesto de latencia (meta < 300 ms de cuadro a resultado)
Etapa
Meta
Cómo se mide

Captura y recorte
≤ 30 ms
performance.now() alrededor de drawImage

Decodificación
≤ 150 ms (≈ 100 ms objetivo)
Marca antes y después de detect()

Validación y búsqueda local
≤ 10 ms
Caché IndexedDB del catálogo del tenant

Respuesta en pantalla
≤ 50 ms
Hasta el siguiente cuadro pintado

Cada lectura envía al servidor engine, decode_ms y total_ms en scan_events; el p95 por dispositivo aparece en la consola. Es la forma de demostrar el criterio ante el evaluador con datos, no con una afirmación.
Sub-módulo QR (redirección instantánea)
QR GS1 Digital Link de la plataforma: se resuelve como GTIN (abajo).
QR con otra URL: se abre solo si su dominio está en la lista de dominios registrados por los 9 tenants. Cualquier otro se muestra como texto con un botón "Abrir de todos modos"; así el lector no se vuelve una vía de phishing.
Lector EAN-13 con conmutador
El modo se guarda por dispositivo y se muestra siempre en la cabecera; el operador POS no puede cambiarlo sin desbloquear, para evitar que una caja empiece a abrir páginas a mitad de una venta.
Modo 1 — Navegación. La PWA navega a https://id.<dominio>/01/<gtin14>; el resolver expande la plantilla del tenant ({sku} para producto, {gtin} para ensamble) y responde 302. Si el enlace del tenant está en estado down, responde la ficha de respaldo.
Modo 2 — Mini POS. No hay navegación. El GTIN se busca primero en la caché local; si no está, GET /v1/scan/{gtin} devuelve nombre, precio, tipo y, para ensambles, el BOM.
Un ensamble entra como una línea con su total congelado y un desplegable con sus partes; el stock se descuenta por componente al cobrar.
Producto de otro tenant: se rechaza con aviso; cada caja vende solo su empresa.
Al cobrar, POST /v1/sales con encabezado Idempotency-Key (UUID generado en el cliente). Si la red falla, la venta queda en una cola de IndexedDB y se reintenta; la llave impide cobrar dos veces.
Ticket: vista de impresión con @page { size: 80mm auto }, totales en monoespaciada e IVA 16 % desglosado.
Fallo de lectura: tras 8 s sin detección se ofrece captura manual de los 13 dígitos con validación en vivo del verificador.
5. Configurador de ensambles y generación en tiempo real
Un ensamble recibe código solo cuando se guarda, y la misma lista de partes con los mismos precios devuelve siempre el mismo código. Mientras el cliente arma la PC, la configuración vive en su dispositivo; la base solo recibe ensambles confirmados.
Flujo
Armado (cliente). El configurador —página propia en /t/{slug}/configurador o la web del equipo vía API— carga el catálogo activo de la tienda de cómputo. El borrador se guarda en IndexedDB del navegador: si se cierra la pestaña, no se pierde, y no ensucia la base.
Compatibilidad en vivo. Reglas declarativas sobre products.attrs, evaluadas en cliente para respuesta inmediata y de nuevo en servidor como autoridad.
Guardar. POST /v1/builds con [{ productId, qty }] y una Idempotency-Key.
Servidor (una transacción). Valida, congela precios, calcula el hash del BOM, reutiliza o asigna el GTIN e inserta builds, build_items y codes.
Respuesta. GTIN, SVG del EAN-13, SVG del QR Digital Link, total y BOM; la tarjeta-espécimen se muestra al instante y se puede imprimir como etiqueta.
Reglas de compatibilidad mínimas
Regla
Condición

Categorías obligatorias
CPU, tarjeta madre, RAM, almacenamiento, fuente y gabinete; GPU opcional

Socket
cpu.attrs.socket = motherboard.attrs.socket

Memoria
ram.attrs.ram_type ∈ motherboard.attrs.ram_types

Formato
motherboard.attrs.form_factor ∈ case.attrs.form_factors

Potencia
psu.attrs.watts ≥ Σ tdp_w × factor (factor configurable por tenant, 1.3 por defecto)

Las reglas son datos (JSON por tenant), no código; el equipo de la tienda puede ajustarlas sin desplegar.
Hash canónico del BOM
El hash incluye el precio unitario. Así dos clientes que arman la misma PC el mismo día comparten código, y si después cambia un precio, el nuevo armado recibe un código distinto en lugar de alterar el anterior.
// builds/bom.tsimport { createHash } from 'node:crypto';type Line = { productId: number; qty: number; unitPriceCents: number };export function bomHash(tenantId: number, lines: Line[]): string {  const canonical = [...lines]    .sort((a, b) => a.productId - b.productId)    .map(l => `${l.productId}:${l.qty}:${l.unitPriceCents}`)    .join('|');  return createHash('sha256').update(`${tenantId}#${canonical}`).digest('hex');}
Transacción del servidor
// builds/service.ts (resumen; db = transacción con SET LOCAL app.tenant_id)export async function saveBuild(db: Tx, tenant: Tenant, input: BuildInput) {  const parts = await db.products.findActiveForShare(input.lines.map(l => l.productId));  assertSameTenant(parts, tenant.id);  assertCompatible(parts, input.lines, tenant.rules);          // 422 con la regla violada  const lines = input.lines.map(l => ({ ...l, unitPriceCents: parts.get(l.productId)!.priceCents }));  const hash  = bomHash(tenant.id, lines);  const existing = await db.builds.findByHash(tenant.id, hash);  if (existing) return present(existing, { reused: true });      // mismo BOM → mismo GTIN  const item  = await db.allocateItem(tenant.id);               // UPDATE … RETURNING  const gtin  = buildGtin13(tenant.gs1Prefix, tenant.companyPrefix, item);  const total = lines.reduce((s, l) => s + l.qty * l.unitPriceCents, 0);  const build = await db.builds.insert({ tenantId: tenant.id, bomHash: hash, totalCents: total });  await db.buildItems.insertMany(lines.map(l => ({ buildId: build.id, ...l })));  await db.codes.insert({ gtin, tenantId: tenant.id, kind: 'build', buildId: build.id });  await db.audit('build.created', { buildId: build.id, gtin });  return present(build, { gtin, reused: false });               // incluye SVG EAN-13 y QR}
FOR SHARE sobre los productos impide que un administrador desactive una pieza a mitad de la transacción. La restricción UNIQUE (tenant_id, bom_hash) resuelve la carrera de dos guardados idénticos simultáneos: el segundo falla, se reintenta una vez y encuentra el existente.
Respuesta
{  "gtin": "7500002000891",  "digitalLink": "https://id.ejemplo.mx/01/07500002000891",  "reused": false,  "totalCents": 2458900,  "bom": [    { "sku": "CPU-R7-7700", "name": "Ryzen 7 7700", "qty": 1, "unitPriceCents": 689900 }  ],  "svg": { "ean13": "<svg …>", "qr": "<svg …>" }}
(Valores de ejemplo, no precios reales.)
Presupuesto de 200 ms en servidor
Paso
Estimación
Nota

Validación y carga de partes
5–15 ms
Una consulta con id = ANY($1)

Hash, asignación e inserciones
5–20 ms
Una transacción, sin viajes extra

SVG EAN-13 y QR
Por medir
bwip-js en el mismo proceso; se mide en la prueba de carga de la fase 2

Son estimaciones de diseño, no mediciones; la prueba de carga (sección 9) las confirma o las corrige. Si el SVG resultara lento, se dibuja después de confirmar la transacción y se guarda en caché, porque nunca cambia.
Reconstrucción por escaneo
GET /v1/scan/{gtin} une codes → builds → build_items → products y devuelve la lista exacta de partes con su precio congelado y, si difiere, el precio vigente. Como build_items no se edita y los productos no se borran (ON DELETE RESTRICT), la máquina armada se reconstruye igual años después.
6. Consola de administración, depuración y observabilidad
La consola responde tres preguntas: ¿qué empresas y códigos existen?, ¿qué está fallando ahora? y ¿se cumplen las metas de latencia? Todo se lee de la misma base, sin servicios de terceros; para 9 tenants eso basta y deja la PoC sin costos fijos de monitoreo.
Vistas
Vista
Qué permite
Rol

Tenants
Alta y edición de empresas, prefijo, plantillas de URL con vista previa y botón "probar enlace"
SuperAdmin

Catálogo
Productos por tenant, importación CSV validada, desactivar en vez de borrar
SuperAdmin

Códigos
Buscar por GTIN, ver destino, imprimir etiqueta, retirar (nunca borrar)
SuperAdmin

Visor de base de datos
Tablas en solo lectura, paginadas, con filtros por columna
SuperAdmin

Depurador HTTP
Bitácora de peticiones con detalle por request_id
SuperAdmin

Métricas
Escaneos, latencias, conversión del POS, salud de enlaces
SuperAdmin; el operador ve solo su caja

En vivo
Flujo de eventos (escaneos, ventas, errores) en tiempo real
SuperAdmin

Visor de base de datos seguro
El visor no acepta SQL libre. Muestra una lista blanca de vistas (v_products, v_codes, v_builds, v_sales, v_scan_events) que ya excluyen columnas sensibles como password_hash. Corre con un rol de base de solo lectura, con statement_timeout = 2s y límite de 500 filas por página. Un visor con SQL libre sería la forma más rápida de saltarse todo el aislamiento por tenant.
Depurador de peticiones
Un hook onResponse de Fastify registra método, ruta, tenant, estado, duración y request_id en http_log, en lotes de 50 o cada 2 s, para no añadir latencia.
Se redactan antes de guardar: Authorization, Cookie, Idempotency-Key y cualquier campo llamado password.
El request_id viaja en el encabezado X-Request-Id; el operador lo ve en el mensaje de error y el administrador lo busca en la consola.
"Copiar como cURL" genera la petición sin credenciales. No hay botón de reenvío: repetir una venta o un guardado desde la consola es un riesgo innecesario.
Métricas definidas
Métrica
Cálculo
Fuente
Meta o alerta

Latencia de decodificación p95
Percentil 95 de decode_ms por motor (nativo/Wasm)
scan_events
< 150 ms

Latencia de escaneo p95
Percentil 95 de total_ms
scan_events
< 300 ms

Tasa de resolución
Escaneos con GTIN encontrado ÷ escaneos totales
scan_events
Alerta < 95 %

Generación de ensamble p95
Duración de POST /v1/builds
http_log
< 200 ms

Tasa de error API
Respuestas 5xx ÷ total, ventana de 15 min
http_log
Alerta > 2 %

Salud de enlaces
Último resultado de la revisión periódica por tenant
tenants.link_status
Alerta en down

Ventas por caja
Número y monto por tenant y día
sales
Informativa

Las métricas son vistas SQL; las de ventanas largas se precalculan cada minuto en una vista materializada.
Tiempo real
GET /v1/admin/stream abre un canal Server-Sent Events. Cada inserción relevante dispara pg_notify, y el proceso reenvía el evento a las consolas abiertas. Se eligió SSE sobre WebSockets porque el flujo es de un solo sentido, funciona sobre HTTP normal y el navegador reconecta solo.
Bitácoras y retención
Registro
Retención
Motivo

audit_log
Indefinida
Trazabilidad de cambios en catálogo, códigos y roles

scan_events
12 meses, particionado por mes
Métricas históricas y evidencia para la evaluación

http_log
14 días
Depuración; datos operativos de poco valor después

Registros del proceso (pino, JSON)
Los del proveedor de hosting
Errores no capturados y arranque

7. Sistema de diseño editorial (UI/UX)
La interfaz se trata como una página impresa: papel, tinta, filetes de 1 px y un único acento terracota. La densidad del POS viene de la retícula y la tipografía, no de cajas, sombras ni colores extra.
Paleta y contraste verificado
Token
Valor
Uso
Contraste sobre #F8F9FA

--paper
#F8F9FA
Fondo base
—

--ivory
#F2F3F5
Superficies secundarias, filas alternas
—

--ink
#121316
Texto principal, barras del código
17.6 : 1

--ink-muted
#5A5D66
Metadatos, etiquetas
6.2 : 1

--rule
#E2E4E8
Filetes y retícula
Decorativo

--accent
#C44D34
Subrayados, líneas de encuadre, estados activos, iconos
4.47 : 1 (solo líneas y texto ≥ 18 px)

--accent-text
#B5432B
Texto terracota de menos de 18 px
5.2 : 1

Ajuste sobre la paleta del brief: #C44D34 queda en 4.47 : 1, apenas por debajo del mínimo AA de 4.5 : 1 para texto pequeño. Se conserva para líneas y texto grande, y se añade #B5432B, visualmente casi idéntico, para texto pequeño. El color nunca es la única señal: un error también lleva icono y texto.
Tipografía
Rol
Familia
Tamaño / interlínea
Detalle

Titular de sección
Instrument Serif
40 / 44 px
letter-spacing: -0.02em

Nombre de producto o ensamble
Instrument Serif
24 / 30 px
Itálica para la variante del ensamble

Interfaz, tablas, botones
Inter
15 / 22 px
font-feature-settings: 'tnum' en columnas numéricas

Microetiquetas
Inter
11 / 14 px
Versalitas: mayúsculas con letter-spacing: 0.06em si la fuente no trae versalitas reales

GTIN, precios del ticket, consola
JetBrains Mono
14 / 20 px
El GTIN se agrupa visualmente 1·6·6 (7 500002 000891)

Las tres familias son libres (SIL OFL) y se sirven desde el propio dominio con font-display: swap, para que la PWA funcione sin conexión.
Retícula y geometría
12 columnas, medianil de 24 px, márgenes de 32 px en escritorio y 16 px en móvil.
Composiciones asimétricas: POS en 7 + 5 (cámara y ticket), consola en 3 + 9 (navegación y contenido), configurador en 8 + 4 (catálogo y espécimen).
Filetes de 1 px en --rule; radio de 2 px en controles y 4 px en contenedores; sin sombras ni degradados.
Microinteracciones de 120 ms que cambian color de línea o texto; con prefers-reduced-motion se eliminan.
Componentes firma
Componente
Especificación

Conmutador de modo
Dos palabras en Inter 13 px, "Navegación · Caja"; la activa en --ink con subrayado terracota de 2 px; la inactiva en --ink-muted. Rol radiogroup para lectores de pantalla.

Visor de cámara
Marco paspartú de 24 px en --paper alrededor del video; cruz fina de 1 px al centro y esquinas en L. Al leer, las esquinas pasan a terracota durante 400 ms.

Tabla de catálogo
Sin bordes verticales; filete bajo cada fila; cifras alineadas a la derecha en tabulares; encabezados en microetiqueta.

Tarjeta-espécimen del ensamble
Ficha tipo coleccionista: número de ensamble en serif grande, BOM como lista numerada con filetes, total en monoespaciada, EAN-13 y QR al pie con el GTIN legible. Imprimible a 100 × 150 mm.

Ticket
80 mm, monoespaciada, totales e IVA alineados a la derecha.

Accesibilidad y uso en caja
Objetivos táctiles de al menos 44 × 44 px, incluso en tablas densas: la fila completa es el objetivo.
Foco visible: contorno de 2 px en --accent con separación de 2 px.
Cada lectura se anuncia en una región aria-live="polite" ("Agregado: RAM 32 GB, $1 899.00").
Contraste mínimo AA en todo texto; probado con la tabla de arriba.
Tokens
:root {  --paper: #F8F9FA;  --ivory: #F2F3F5;  --ink: #121316;    --ink-muted: #5A5D66;  --rule: #E2E4E8;   --accent: #C44D34;  --accent-text: #B5432B;  --font-display: 'Instrument Serif', 'Times New Roman', serif;  --font-ui: 'Inter', system-ui, sans-serif;  --font-code: 'JetBrains Mono', ui-monospace, monospace;  --radius-control: 2px;  --radius-surface: 4px;  --hairline: 1px solid var(--rule);  --motion: 120ms ease-out;}.label { font: 500 11px/14px var(--font-ui); text-transform: uppercase; letter-spacing: .06em; color: var(--ink-muted); }.num   { font-feature-settings: 'tnum'; text-align: right; }
Sin Bootstrap, sin jQuery y sin librería de componentes: los pocos controles se construyen sobre elementos HTML nativos (<dialog>, <button>, <table>), lo que da accesibilidad de base y un paquete pequeño.
8. Seguridad, roles y autenticación
Hay dos roles humanos (SuperAdmin y Operador POS) y una credencial de máquina por tenant para que la web de cada equipo cree ensambles; todo lo demás es público de solo lectura o está cerrado. El sistema no guarda datos personales de compradores, lo que reduce las obligaciones de protección de datos a las cuentas del personal.
Matriz de permisos
Acción
Público
Integración (API key del tenant)
Operador POS
SuperAdmin

Resolver un GTIN (/01/…)
Sí
Sí
Sí
Sí

Usar el configurador y guardar ensamble
Sí, con límite de tasa
Sí
Sí
Sí

Consultar GET /v1/scan/{gtin} con precio y BOM
No
Su tenant
Su tenant
Todos

Registrar ventas
No
No
Su tenant
Todos

Editar catálogo, plantillas, reglas
No
No
No
Sí

Retirar códigos, gestionar usuarios y llaves
No
No
No
Sí

Consola, visor de BD, depurador
No
No
No
Sí

La autorización se comprueba en cada ruta con un preHandler de Fastify que lee el rol de memberships, y RLS lo refuerza en la base.
Autenticación
Contraseñas con Argon2id; mínimo 12 caracteres y verificación contra contraseñas filtradas comunes.
Sesión en cookie HttpOnly; Secure; SameSite=Lax, rotada al iniciar sesión; 12 h para operadores, 2 h de inactividad para SuperAdmin.
SuperAdmin con segundo factor TOTP obligatorio.
Límite de 5 intentos por minuto por cuenta y por IP; bloqueo temporal de 15 min.
Peticiones que cambian estado exigen el encabezado X-Requested-With, además de SameSite, como defensa CSRF.
API keys de integración
Cada tenant recibe una llave con alcance builds:create y catalog:read únicamente. Se muestra una sola vez; en la base se guarda su SHA-256 y un prefijo visible para identificarla. Se rota desde la consola sin tiempo fuera (dos llaves activas durante el cambio). CORS solo admite el dominio registrado de ese tenant.
Riesgos propios de este sistema
Riesgo
Control

Redirección abierta en el resolver
Solo redirige a plantillas registradas por SuperAdmin; el host de la plantilla debe coincidir con el dominio del tenant; {sku} se codifica con encodeURIComponent.

QR maliciosos escaneados por el personal
Lista blanca de dominios; los demás se muestran como texto (sección 4).

Fuga entre tenants
RLS en la base, pruebas automáticas que intentan leer otro tenant y deben fallar.

Enumeración de GTIN para obtener precios
GET /v1/scan exige sesión o llave; el resolver público solo redirige y no expone precio.

Venta duplicada por reintento
Idempotency-Key única por venta, guardada 24 h.

Inyección SQL y XSS
Consultas parametrizadas del ORM; validación Zod en cada entrada; React escapa por defecto; CSP sin unsafe-inline para scripts.

Abuso de cámara
Permissions-Policy: camera=(self); la cámara se apaga al salir de la vista.

Secretos y dependencias
Secretos en variables de entorno del hosting, nunca en el repositorio; .env.example sin valores.
package-lock.json versionado, npm audit y Dependabot en CI.
Respaldo diario de Postgres con retención de 7 días y una restauración de prueba antes de la entrega.
9. Pruebas y criterios de aceptación
Cada criterio del brief se prueba con una medición reproducible, no con una demostración en vivo: la decodificación se prueba con una cámara simulada en CI y en 3 dispositivos reales, y los 200 ms de generación con una prueba de carga.
Niveles de prueba
Nivel
Qué cubre
Herramienta

Unitarias
Dígito verificador (casos GS1 conocidos y mutación de un dígito), buildGtin13, bomHash, reglas de compatibilidad
Vitest

Basadas en propiedades
Todo GTIN generado tiene 13 dígitos y pasa el módulo 10; mismo BOM en cualquier orden → mismo hash
fast-check

Integración con base
RLS: un tenant no lee filas de otro; 100 asignaciones concurrentes → 100 números distintos; CHECK rechaza GTIN inválidos
Testcontainers + PostgreSQL 16

API
Contratos de /v1/builds, /v1/scan, /v1/sales; idempotencia; códigos 401/403/422
fastify.inject

Extremo a extremo
Escaneo real en el pipeline: Chrome con video falso de un EAN-13 y un QR; ambos modos; venta completa
Playwright con --use-file-for-fake-video-capture

Carga
POST /v1/builds a 20 peticiones/s durante 2 min
k6

Campo
Matriz de dispositivos y soportes impresos
Manual, con hoja de registro

Matriz de campo
Dispositivo
Motor esperado
Soportes

Android de gama baja con Chrome
Nativo
Etiqueta impresa al 100 % y al 80 %, pantalla de laptop

iPhone con Safari
Wasm
Etiqueta impresa al 100 %, pantalla de otro teléfono

Laptop Windows con Chrome y cámara web
Wasm o nativo según soporte
Etiqueta impresa al 100 %

Por cada combinación se registran 30 lecturas: tasa de éxito, decode_ms p50 y p95, y lecturas erróneas.
Criterios de aceptación
☐ 100 % de los GTIN emitidos tienen 13 dígitos y pasan el módulo 10 (prueba de propiedades y CHECK en base).
☐ Decodificación p95 < 300 ms en los 3 dispositivos de la matriz.
☐ POST /v1/builds p95 < 200 ms en la prueba de carga, con el SVG incluido.
☐ Escanear un ensamble guardado reconstruye su BOM exacto y su total congelado.
☐ Un usuario o llave de un tenant no puede leer ni escribir datos de otro (prueba automatizada).
☐ Ningún código impreso queda roto al cambiar la URL de un tenant (prueba cambiando la plantilla).
☐ Operador POS no puede abrir la consola ni el visor de BD.
☐ Una venta reintentada con la misma Idempotency-Key se registra una sola vez.
10. Plan de implementación, riesgos y supuestos
El trabajo se organiza en 5 fases para un semestre de 8 semanas; cada fase cierra con una prueba que se puede mostrar al evaluador. El orden pone primero lo que más riesgo tiene: la base de datos con aislamiento y el motor de códigos, de los que depende todo lo demás.

fases · 5 bloques, 8 semanas (no a escala)
Una fase no empieza hasta que pasa la puerta de la anterior. Si F2 no cumple las latencias, la semana 6 se dedica a corregirlas antes de construir la consola.
Riesgos
Riesgo
Probabilidad
Impacto
Mitigación

Los equipos no entregan URLs o catálogo a tiempo
Alta
Medio
Importación CSV y ficha de respaldo del resolver; el sistema funciona sin las webs externas.

Decodificación Wasm lenta en teléfonos de gama baja
Media
Alto
Recorte al paspartú, un análisis en vuelo, medición desde la fase 2 para corregir pronto.

Uso del prefijo 750 fuera del entorno académico
Media
Alto
Prefijo configurable; antes de la PoC real, licencia GS1 México o rango 20–29.

Cámara bloqueada por falta de HTTPS
Alta si se omite
Alto
HTTPS desde el primer despliegue, también en pruebas.

Impresoras térmicas de 203 dpi deforman las barras
Media
Medio
Módulo de 3 puntos exactos (0.375 mm) para no redondear anchos; prueba con la impresora real.

Crecimiento de alcance (IA, app nativa, pagos reales)
Media
Medio
Fuera de alcance explícito; se anota en una lista de "después".

Supuestos
8 semanas de desarrollo y un equipo de 3 personas; si hay otra fecha de entrega, se ajustan las fases, no el orden.
Volumen de la PoC: menos de 10 000 escaneos por día en total.
Cada tienda vende solo su catálogo; no hay ventas cruzadas entre empresas.
El POS no procesa pagos: registra la venta y el método declarado (efectivo, tarjeta externa).
Los precios incluyen IVA del 16 % y el ticket lo desglosa.
Preguntas abiertas
¿Qué fecha exacta tiene la entrega final y qué se evalúa en cada avance?
¿Las 9 webs ya tienen URLs estables por producto o hay que acordar una convención con los equipos?
¿La PoC real venderá en tiendas de terceros (requiere licencia GS1) o solo en mostrador propio?
Referencias
Compatibilidad de BarcodeDetector API — caniuse
html5-qrcode — repositorio y aviso de mantenimiento
barcode-detector — ponyfill sobre ZXing-C++ Wasm
zxing-wasm — npm
bwip-js — generador de códigos en JavaScript
GS1 Digital Link Standard: URI Syntax
QR Code powered by GS1 — buenas prácticas
GS1-Conformant Resolver Standard
GS1 GSCN 23-006 — Restricted Circulation Numbers
El algoritmo módulo 10 y la función SQL se ejecutaron en este trabajo contra casos conocidos; los tiempos de bwip-js no se midieron todavía y quedan como meta de la fase 2.

