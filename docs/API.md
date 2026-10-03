# API (generada ejecutando el sistema real)

Base: `http://localhost:3000`. Toda petición que cambia estado a `/v1/*` exige `X-Requested-With`. La sesión es **opcional**: el resolver, los SVG y todo `/v1/public/*` funcionan sin cuenta (con límite de tasa por IP; 429 + `Retry-After`). Sesión por cookie `sid`. Errores: `{error, message, requestId}`.

## POST /v1/auth/login

Argon2id, bloqueo tras 5 intentos fallidos (15 min). El SuperAdmin con TOTP activo debe enviar además `totp` (6 dígitos) o `recoveryCode`.

```bash
curl -X POST  -H 'X-Requested-With: x' -H 'Content-Type: application/json' -d '{"email":"caja2@ejemplo.mx","password":"<contraseña>"}' 'http://localhost:3000/v1/auth/login'
```

Respuesta **401**:

```json
{"error":"bad_credentials","message":"Credenciales inválidas","requestId":"946afc31-72ed-44fb-9fe3-9268a5e5b419"}
```

## GET /v1/public/tenants (sin sesión)

Negocios con configurador activo.

```bash
curl -X GET  -H 'X-Requested-With: x' 'http://localhost:3000/v1/public/tenants'
```

Respuesta **200**:

```json
[{"slug":"tienda-0002","name":"Cómputo Nova","configurators":[{"slug":"pc","name":"PC a medida","description":"Arma tu computadora pieza por pieza"}]},{"slug":"tienda-0003","name":"Café Origen","configurators":[{"slug":"bebida","name":"Tu café","description":"Elige bebida, tamaño, leche, endulzante y extras"}]}]
```

## GET /v1/public/t/:slug/configurators/:configurador (sin sesión)

Definición (grupos y reglas) + opciones del catálogo. No expone stock exacto ni GTIN.

```bash
curl -X GET  -H 'X-Requested-With: x' 'http://localhost:3000/v1/public/t/tienda-0003/configurators/bebida'
```

Respuesta **200**:

```json
{"tenant":{"slug":"tienda-0003","name":"Café Origen"},"configurator":{"slug":"bebida","name":"Tu café","description":"Elige bebida, tamaño, leche, endulzante y extras","definition":{"rules":[{"a":{"attr":"clave","group":"tamano"},"b":{"attr":"tamanos","group":"bebida"},"id":"tamano_disponible","type":"in","message":"Ese tamaño no está disponible para la bebida elegida"},{"id":"sin_leche","type":"forbid","when":{"attr":"lleva_leche","group":"bebida","equals":false},"group":"leche","message":"Esta bebida no lleva leche"},{"id":"con_leche","type":"require","when":{"attr":"lleva_leche","group":"bebida","equals":true},"group":"leche","message":"Elige el tipo de leche"}],"groups":[{"max":1,"min":1 …(recortado)
```

## POST /v1/public/t/:slug/builds (sin sesión)

10 por minuto por IP. Con sesión de cliente, además queda en `/v1/me/builds`. 422 con la regla violada (`detail[].rule`).

```bash
curl -X POST  -H 'X-Requested-With: x' -H 'Content-Type: application/json' -d '{"configurator":"bebida","lines":[{"productId":35,"qty":1},{"productId":39,"qty":1},{"productId":43,"qty":1},{"productId":46,"qty":2}]}' 'http://localhost:3000/v1/public/t/tienda-0003/builds'
```

Respuesta **201**:

```json
{"gtin":"7500003000258","label":"Bebida","name":"Bebida 7500003000258","configurator":"bebida","digitalLink":"http://localhost:3000/01/07500003000258","reused":false,"saved":false,"totalCents":7500,"bom":[{"sku":"BEB-LATTE","name":"Latte","category":"bebida","qty":1,"unitPriceCents":5500},{"sku":"TAM-MEDIANO","name":"Mediano (12 oz)","category":"tamano","qty":1,"unitPriceCents":800},{"sku":"LEC-AVENA","name":"Bebida de avena","category":"leche","qty":1,"unitPriceCents":1200},{"sku":"END-AZUCAR","name":"Azúcar","category":"endulzante","qty":2,"unitPriceCents":0}],"svg":{"ean13":"<svg role=\"img\" aria-label=\"EAN-13 7500003000258\" viewBox=\"0 0 385 155\" xmlns=\"http://www.w3.org/2000/svg\"> …(recortado)
```

## POST /v1/public/t/:slug/builds — regla violada

```bash
curl -X POST  -H 'X-Requested-With: x' -H 'Content-Type: application/json' -d '{"configurator":"bebida","lines":[{"productId":33,"qty":1},{"productId":40,"qty":1},{"productId":43,"qty":1}]}' 'http://localhost:3000/v1/public/t/tienda-0003/builds'
```

Respuesta **422**:

```json
{"error":"incompatible","message":"Ese tamaño no está disponible para la bebida elegida","detail":[{"rule":"tamano_disponible","group":"tamano","message":"Ese tamaño no está disponible para la bebida elegida"},{"rule":"sin_leche","message":"Esta bebida no lleva leche","group":"leche"}],"requestId":"f4dffa21-95e1-4ded-860e-9aecd3dd3f28"}
```

## GET /v1/public/t/:slug/catalog (sin sesión, para las webs)

Productos que se agregaron desde Scan-bar (origen `scanbar`), agrupados por variante, para que la web los pinte. Sin GTIN ni existencias exactas. CORS solo para los `allowed_domains` del negocio (y localhost). 120/min por IP.

```bash
curl -X GET -H 'origin: http://localhost:8001' -H 'X-Requested-With: x' 'http://localhost:3000/v1/public/t/yokrem/catalog'
```

Respuesta **200** · `Access-Control-Allow-Origin: http://localhost:8001`:

```json
{"tenant":{"slug":"yokrem","name":"YOKREM"},"products":[{"sku":"VESTIDO-LINO-ROJO","name":"Vestido de lino rojo","category":"verano","description":"Vestido midi de lino con tirantes ajustables.","imageUrl":null,"attrs":{"color":"Rojo","muestra":"#B3261E"},"priceCents":74900,"variants":[{"sku":"VESTIDO-LINO-ROJO-CH","label":"CH","priceCents":74900,"inStock":true},{"sku":"VESTIDO-LINO-ROJO-M","label":"M","priceCents":74900,"inStock":true},{"sku":"VESTIDO-LINO-ROJO-G","label":"G","priceCents":74900,"inStock":true},{"sku":"VESTIDO-LINO-ROJO-EG","label":"EG","priceCents":74900,"inStock":true}]}],"generatedAt":"2026-10-03T10:14:29.728Z"}
```

## POST /v1/public/t/:slug/configurations (sin sesión, para las webs)

Código para lo que el cliente configuró en la web (líneas por SKU). Precios de Scan-bar, nunca del cliente. Misma lista + misma etiqueta ⇒ mismo GTIN (200, `reused: true`). Una sola unidad de un solo producto devuelve el código propio del producto. `label` ∈ Pedido, Bebida, Ensamble, Paquete, Personalizado. `configurator` opcional aplica además las reglas de un configurador de Scan-bar. 30/min por IP; desde un dominio no registrado → 403 `origen_no_permitido`.

```bash
curl -X POST -H 'origin: http://localhost:8005' -H 'X-Requested-With: x' -H 'Content-Type: application/json' -d '{"label":"Bebida","lines":[{"sku":"americano-gde","qty":1},{"sku":"LECHE-AVENA","qty":1},{"sku":"EXTRA-ESPRESSO","qty":1}]}' 'http://localhost:3000/v1/public/t/cafe-motz/configurations'
```

Respuesta **201** · `Access-Control-Allow-Origin: http://localhost:8005`:

```json
{"gtin":"7500011000325","kind":"build","label":"Bebida","name":"Bebida 7500011000325","reused":false,"totalCents":7700,"taxCents":1062,"lines":[{"sku":"LECHE-AVENA","name":"Bebida de avena","qty":1,"unitPriceCents":1000},{"sku":"americano-gde","name":"Café Americano — Grande (420ml)","qty":1,"unitPriceCents":5500},{"sku":"EXTRA-ESPRESSO","name":"Shot extra de espresso","qty":1,"unitPriceCents":1200}],"digitalLink":"http://localhost:3000/01/07500011000325","svg":{"ean13":"/v1/codes/7500011000325.svg?kind=ean13","qr":"/v1/codes/7500011000325.svg?kind=qr"}}
```

## POST /v1/public/t/:slug/configurations — SKU desconocido

```bash
curl -X POST -H 'origin: http://localhost:8005' -H 'X-Requested-With: x' -H 'Content-Type: application/json' -d '{"label":"Bebida","lines":[{"sku":"americano-gde","qty":1},{"sku":"NO-EXISTE","qty":1}]}' 'http://localhost:3000/v1/public/t/cafe-motz/configurations'
```

Respuesta **422** · `Access-Control-Allow-Origin: http://localhost:8005`:

```json
{"error":"producto_invalido","message":"No existen en este negocio o están retirados: NO-EXISTE","detail":["NO-EXISTE"],"requestId":"0a32a2d6-02c0-44a7-b201-e1d59e32c742"}
```

## POST /v1/auth/register

Crea una cuenta de **cliente** (sin privilegios de personal) e inicia sesión. Contraseña ≥ 12 caracteres y no trivial; 5 intentos por hora por IP. Ejemplo de rechazo:

```bash
curl -X POST  -H 'X-Requested-With: x' -H 'Content-Type: application/json' -d '{"email":"alguien@ejemplo.mx","password":"corta"}' 'http://localhost:3000/v1/auth/register'
```

Respuesta **422**:

```json
{"error":"password_debil","message":"La contraseña debe tener al menos 12 caracteres","requestId":"6dfdeebc-079c-4b4f-b1ea-3336a78f4551"}
```

## GET /v1/products

```bash
curl -X GET -H 'cookie: sid=<sesión>' -H 'X-Requested-With: x' 'http://localhost:3000/v1/products'
```

Respuesta **200**:

```json
[{"id":24,"sku":"CASE-ATX","name":"Gabinete ATX Mid Tower","category":"case","priceCents":99900,"stock":12,"attrs":{"form_factors":["ATX","mATX"]},"active":true,"gtin":"7500002000211"},{"id":26,"sku":"CASE-FT","name":"Gabinete Full Tower","category":"case","priceCents":189900,"stock":12,"attrs":{"form_factors":["ATX","mATX","EATX"]},"active":true,"gtin":"7500002000235"},{"id":25,"sku":"CASE-MATX","name":"Gabinete mATX compacto","category":"case","priceCents":79900,"stock":12,"attrs":{"form_factors":["mATX"]},"active":true,"gtin":"7500002000228"},{"id":6,"sku":"CPU-I5-12400","name":"Core i5-12400","category":"cpu","priceCents":329900,"stock":20,"attrs":{"tdp_w":65,"socket":"LGA1700"},"active" …(recortado)
```

## GET /v1/scan/:gtin

Solo GTIN del tenant de la sesión (404 si es de otro).

```bash
curl -X GET -H 'cookie: sid=<sesión>' -H 'X-Requested-With: x' 'http://localhost:3000/v1/scan/7500002000013'
```

Respuesta **200**:

```json
{"gtin":"7500002000013","kind":"product","name":"Ryzen 5 7600","sku":"CPU-A5-7600","priceCents":369900}
```

## GET /01/:gtin14 (resolver público)

302 a la plantilla del tenant (host validado contra `allowed_domains`); ficha de respaldo HTML si el enlace está `down`; 404 propio si no existe.

```bash
curl -X GET  -H 'X-Requested-With: x' 'http://localhost:3000/01/07500002000013'
```

Respuesta **302** → Location: `https://equipo2.ejemplo.mx/producto/CPU-A5-7600`:

```json

```

## GET /v1/codes/:gtin.svg

`kind=ean13|qr`; `Cache-Control: public, max-age=31536000, immutable`; 422 si el GTIN es inválido.

```bash
curl -X GET  -H 'X-Requested-With: x' 'http://localhost:3000/v1/codes/7500002000013.svg?kind=ean13'
```

Respuesta **200** · `Access-Control-Allow-Origin: *`:

```json
<svg role="img" aria-label="EAN-13 7500002000013" viewBox="0 0 385 155" xmlns="http://www.w3.org/2000/svg"><title>7500002000013</title>
<rect width="100%" height="100%" fill="#FFFFFF" />
<path stroke="#121316" stroke-width="3" d="M67.50 130L67.50 12M73.50 130L73.50 12M94.50 115L94.50 12M100.50 115L100.50 12M136.50 115L136.50 12M142.50 115L142.50 12M178.50 115L178.50 12M205.50 130L205.50 12M211.50 130L211.50 12M232.50 115L232.50 12M253.50 115L253.50 12M274.50 115L274.50 12M295.50 115L295.50 12M322.50 115L322.50 12M337.50 115L337.50 12M343.50 130L343.50 12M349.50 130L349.50 12" />
<path stroke="#121316" stroke-width="6" d="M81 115L81 12M129 115L129 12M171 115L171 12M189 115L189 12M198 115L198  …(recortado)
```

## GET /v1/allowed-domains

```bash
curl -X GET  -H 'X-Requested-With: x' 'http://localhost:3000/v1/allowed-domains'
```

Respuesta **200**:

```json
{"domains":["equipo1.ejemplo.mx","equipo2.ejemplo.mx","equipo3.ejemplo.mx","equipo4.ejemplo.mx","equipo5.ejemplo.mx","equipo6.ejemplo.mx","equipo7.ejemplo.mx","equipo8.ejemplo.mx","equipo9.ejemplo.mx","github.com"]}
```

## POST /v1/builds

Personal o llave de integración. `configurator` es opcional (por defecto, el primero activo del negocio). Mismo BOM y precios ⇒ mismo GTIN (`reused: true`, 200). 422 con la regla violada si es incompatible.

```bash
curl -X POST -H 'cookie: sid=<sesión>' -H 'X-Requested-With: x' -H 'Content-Type: application/json' -d '{"configurator":"pc","lines":[{"productId":4,"qty":1},{"productId":8,"qty":1},{"productId":12,"qty":1},{"productId":17,"qty":1},{"productId":21,"qty":1},{"productId":24,"qty":1}]}' 'http://localhost:3000/v1/builds'
```

Respuesta **201**:

```json
{"gtin":"7500002000273","label":"Ensamble","name":"Ensamble 7500002000273","configurator":"pc","digitalLink":"http://localhost:3000/01/07500002000273","reused":false,"saved":true,"totalCents":1109400,"bom":[{"sku":"CPU-A5-7600","name":"Ryzen 5 7600","category":"cpu","qty":1,"unitPriceCents":369900},{"sku":"MB-B650-ATX","name":"Placa B650 ATX","category":"motherboard","qty":1,"unitPriceCents":289900},{"sku":"RAM-D5-16","name":"RAM 16 GB DDR5","category":"ram","qty":1,"unitPriceCents":109900},{"sku":"SSD-1T","name":"SSD NVMe 1 TB","category":"storage","qty":1,"unitPriceCents":129900},{"sku":"PSU-650","name":"Fuente 650 W","category":"psu","qty":1,"unitPriceCents":109900},{"sku":"CASE-ATX","nam …(recortado)
```

## POST /v1/sales

`Idempotency-Key` obligatorio; repetirla devuelve la venta original (200, `replayed: true`). 409 con detalle si falta stock.

```bash
curl -X POST -H 'idempotency-key: 6b82cc60-911e-4bd9-8844-f872c44b409d' -H 'cookie: sid=<sesión>' -H 'X-Requested-With: x' -H 'Content-Type: application/json' -d '{"items":[{"gtin":"7500002000273","qty":1}],"paymentMethod":"efectivo"}' 'http://localhost:3000/v1/sales'
```

Respuesta **201**:

```json
{"id":1,"totalCents":1109400,"taxCents":153021,"items":[{"gtin":"7500002000273","name":"Ensamble 7500002000273","qty":1,"unitPriceCents":1109400}],"replayed":false}
```

## POST /v1/products

Función de administrador: SuperAdmin con contraseña confirmada (ver `POST /v1/auth/admin-unlock`). Emite el GTIN en la misma transacción.

```bash
curl -X POST -H 'cookie: sid=<sesión>' -H 'X-Requested-With: x' -H 'Content-Type: application/json' -d '{"sku":"DOC-1791022469790","name":"Producto de ejemplo","category":"extra","priceCents":1999}' 'http://localhost:3000/v1/products'
```

Respuesta **201**:

```json
{"id":298,"gtin":"7500002000280"}
```

## GET /v1/admin/configurators

Consola: exige TOTP y contraseña confirmada. `POST` crea y `PATCH /:id` edita (definición validada; 422 `definicion_invalida`).

```bash
curl -X GET -H 'cookie: sid=<sesión>' -H 'X-Requested-With: x' 'http://localhost:3000/v1/admin/configurators'
```

Respuesta **200**:

```json
[{"id":1,"tenant_id":2,"tenant_slug":"tienda-0002","tenant_name":"Cómputo Nova","slug":"pc","name":"PC a medida","description":"Arma tu computadora pieza por pieza","definition":{"rules":[{"a":{"attr":"socket","group":"cpu"},"b":{"attr":"socket","group":"motherboard"},"id":"socket","type":"equals"},{"a":{"attr":"ram_type","group":"ram"},"b":{"attr":"ram_types","group":"motherboard"},"id":"memoria","type":"in"},{"a":{"attr":"form_factor","group":"motherboard"},"b":{"attr":"form_factors","group":"case"},"id":"formato","type":"in"},{"id":"potencia","attr":"tdp_w","type":"sum_lte","unit":"W","limit":{"attr":"watts","group":"psu"},"factor":1.3}],"groups":[{"max":1,"min":1,"label":"Procesador","ca …(recortado)
```

## GET /v1/admin/tenants

```bash
curl -X GET -H 'cookie: sid=<sesión>' -H 'X-Requested-With: x' 'http://localhost:3000/v1/admin/tenants'
```

Respuesta **200**:

```json
[{"id":1,"slug":"tienda-0001","name":"Papelería Aurora","gs1_prefix":"750","company_prefix":"0001","product_url_tpl":"https://equipo1.ejemplo.mx/producto/{sku}","build_url_tpl":"https://equipo1.ejemplo.mx/ensamble/{gtin}","allowed_domains":["equipo1.ejemplo.mx"],"link_status":"unknown","rules":{"powerFactor":1.3}},{"id":2,"slug":"tienda-0002","name":"Cómputo Nova","gs1_prefix":"750","company_prefix":"0002","product_url_tpl":"https://equipo2.ejemplo.mx/producto/{sku}","build_url_tpl":"https://equipo2.ejemplo.mx/ensamble/{gtin}","allowed_domains":["equipo2.ejemplo.mx"],"link_status":"unknown","rules":{"powerFactor":1.3}},{"id":3,"slug":"tienda-0003","name":"Café Origen","gs1_prefix":"750","com …(recortado)
```

## POST /v1/admin/products (con variantes)

Agrega un producto a la página web de cualquier negocio (consola: TOTP + contraseña confirmada). Cada variante (talla, tamaño, gramaje) es un producto con su GTIN: `SKU-VARIANTE`. Origen `scanbar`: la web lo recibe por `/catalog`. 409 si el SKU existe.

```bash
curl -X POST -H 'cookie: sid=<sesión>' -H 'X-Requested-With: x' -H 'Content-Type: application/json' -d '{"tenantId":10,"sku":"DOC-1791022469806","name":"Blusa de ejemplo","category":"Verano","priceCents":49900,"stock":5,"variants":[{"label":"CH"},{"label":"M","priceCents":52900}]}' 'http://localhost:3000/v1/admin/products'
```

Respuesta **201**:

```json
{"tenant":"yokrem","created":[{"id":299,"sku":"DOC-1791022469806-CH","name":"Blusa de ejemplo — CH","gtin":"7500010000494"},{"id":300,"sku":"DOC-1791022469806-M","name":"Blusa de ejemplo — M","gtin":"7500010000500"}]}
```

## GET /v1/admin/products?tenantId=

Todos los productos del negocio (activos y retirados) con su GTIN y su origen (`repo` = definido en el código de la web, `scanbar` = agregado aquí).

```bash
curl -X GET -H 'cookie: sid=<sesión>' -H 'X-Requested-With: x' 'http://localhost:3000/v1/admin/products?tenantId=10'
```

Respuesta **200**:

```json
[{"id":112,"tenantId":10,"sku":"conjunto-invierno-CH","name":"Conjunto Invierno — CH","category":"conjunto","priceCents":180000,"stock":0,"attrs":{"piezas":["bomber-azul-marino","sueter-cuello-alto-blanco","pantalon-beige"],"temporada":"invierno"},"active":true,"origin":"repo","description":"","imageUrl":null,"variantOf":"conjunto-invierno","variant":"CH","gtin":"7500010000418"},{"id":113,"tenantId":10,"sku":"conjunto-invierno-M","name":"Conjunto Invierno — M","category":"conjunto","priceCents":180000,"stock":0,"attrs":{"piezas":["bomber-azul-marino","sueter-cuello-alto-blanco","pantalon-beige"],"temporada":"invierno"},"active":true,"origin":"repo","description":"","imageUrl":null,"variantOf …(recortado)
```

## PATCH /v1/admin/products/:id (retirar)

Edita nombre, categoría, precio, existencias, descripción, imagen, atributos o `active`. Retirar no borra: el código queda retirado (el resolver responde 404 propio) y `active: true` lo reactiva. Un producto de origen `repo` solo admite `stock` (409 `administrado_por_repo`).

```bash
curl -X PATCH -H 'cookie: sid=<sesión>' -H 'X-Requested-With: x' -H 'Content-Type: application/json' -d '{"active":false}' 'http://localhost:3000/v1/admin/products/299'
```

Respuesta **200**:

```json
{"id":299,"tenantId":10,"sku":"DOC-1791022469806-CH","name":"Blusa de ejemplo — CH","category":"verano","priceCents":49900,"stock":5,"attrs":{},"active":false,"origin":"scanbar","description":"","imageUrl":null,"variantOf":"DOC-1791022469806","variant":"CH","gtin":"7500010000494"}
```

## GET /v1/admin/tenants/:id/labels.pdf

Hoja de etiquetas para recortar: nombre del producto encima de su EAN-13 (y QR con `qr=1`), con guías de corte. Parámetros: `paper=letter|a4`, `qr=0|1`, `copies=1..50`, `scale=80..100` (% del tamaño nominal), `category`, `origin=repo|scanbar`. Máximo 2000 etiquetas por archivo.

```bash
curl -X GET -H 'cookie: sid=<sesión>' -H 'X-Requested-With: x' 'http://localhost:3000/v1/admin/tenants/10/labels.pdf?paper=letter&qr=0&copies=1'
```

Respuesta **200**:

```json
(PDF de 76898 bytes, 3 página(s); attachment; filename="etiquetas-yokrem-2026-10-03.pdf")
```

## GET /v1/labels.pdf

Cada negocio descarga desde su cuenta (caja o personal) la hoja de etiquetas con todos sus códigos: el negocio de la sesión (RLS); `tenant=<slug>` de otro negocio → 403. El SuperAdmin elige con `tenant=<slug>` cualquier negocio o `tenant=*` todos en un archivo (cada negocio en páginas propias). Mismos parámetros que la versión de la consola; 404 si no hay productos para esas opciones; 10 descargas por minuto por cuenta.

```bash
curl -X GET -H 'cookie: sid=<sesión>' -H 'X-Requested-With: x' 'http://localhost:3000/v1/labels.pdf?paper=letter&qr=0&copies=1'
```

Respuesta **200**: PDF (`attachment; filename="etiquetas-<negocio>-<fecha>.pdf"`; con `tenant=*`, `etiquetas-todos-los-negocios-<fecha>.pdf`).

## GET /v1/labels/tenants

Negocios cuyas etiquetas puede descargar la cuenta (para el selector de Catálogo): el personal, solo el suyo; el SuperAdmin, todos. Con productos activos con código y sus categorías.

```bash
curl -X GET -H 'cookie: sid=<sesión>' -H 'X-Requested-With: x' 'http://localhost:3000/v1/labels/tenants'
```

Respuesta **200**:

```json
[{"slug":"tienda-0002","name":"Cómputo Nova","products":26,"categories":["case","cpu","gpu","motherboard","psu","ram","storage"]}]
```

## GET /v1/admin/db/:vista

Vistas: v_products, v_codes, v_builds, v_sales, v_scan_events. Columna fuera de la lista → 422.

```bash
curl -X GET -H 'cookie: sid=<sesión>' -H 'X-Requested-With: x' 'http://localhost:3000/v1/admin/db/v_products?tenant_id=2&category=cpu'
```

Respuesta **200**:

```json
{"view":"v_products","columns":["id","tenant_id","sku","name","category","price_cents","stock","active","origin"],"page":0,"rows":[{"id":"4","tenant_id":2,"sku":"CPU-A5-7600","name":"Ryzen 5 7600","category":"cpu","price_cents":369900,"stock":19,"active":true,"origin":"scanbar"},{"id":"5","tenant_id":2,"sku":"CPU-A7-7700","name":"Ryzen 7 7700","category":"cpu","price_cents":689900,"stock":20,"active":true,"origin":"scanbar"},{"id":"6","tenant_id":2,"sku":"CPU-I5-12400","name":"Core i5-12400","category":"cpu","price_cents":329900,"stock":20,"active":true,"origin":"scanbar"},{"id":"7","tenant_id":2,"sku":"CPU-I7-14700","name":"Core i7-14700","category":"cpu","price_cents":849900,"stock":20,"ac …(recortado)
```

## GET /v1/admin/metrics

```bash
curl -X GET -H 'cookie: sid=<sesión>' -H 'X-Requested-With: x' 'http://localhost:3000/v1/admin/metrics'
```

Respuesta **200**:

```json
{"latency":[],"resolution":[],"buildP95":{"n":0,"p95_ms":null},"errors15m":{"total":55,"errors":0,"pct":"0.00"},"links":[{"tenant_id":1,"slug":"tienda-0001","link_status":"unknown"},{"tenant_id":2,"slug":"tienda-0002","link_status":"unknown"},{"tenant_id":3,"slug":"tienda-0003","link_status":"unknown"},{"tenant_id":4,"slug":"tienda-0004","link_status":"unknown"},{"tenant_id":5,"slug":"tienda-0005","link_status":"unknown"},{"tenant_id":6,"slug":"tienda-0006","link_status":"unknown"},{"tenant_id":7,"slug":"tienda-0007","link_status":"unknown"},{"tenant_id":8,"slug":"tienda-0008","link_status":"unknown"},{"tenant_id":9,"slug":"tienda-0009","link_status":"unknown"},{"tenant_id":10,"slug":"yokrem …(recortado)
```

## GET /v1/admin/alerts

```bash
curl -X GET -H 'cookie: sid=<sesión>' -H 'X-Requested-With: x' 'http://localhost:3000/v1/admin/alerts'
```

Respuesta **200**:

```json
[]
```

## GET /v1/admin/requests

Depurador; detalle en `/v1/admin/requests/:request_id` (cabeceras redactadas + cURL).

```bash
curl -X GET -H 'cookie: sid=<sesión>' -H 'X-Requested-With: x' 'http://localhost:3000/v1/admin/requests'
```

Respuesta **200**:

```json
[{"id":"55","request_id":"b4d3604d-2367-4f9f-9a84-dd2b6a01e039","method":"POST","route":"/v1/auth/totp/verify","tenant_id":2,"status":200,"duration_ms":8.125572,"created_at":"2026-10-03T10:13:59.500Z"},{"id":"54","request_id":"82ad3329-8ddd-485f-a532-ba691f7bf73f","method":"POST","route":"/v1/auth/totp/setup","tenant_id":2,"status":200,"duration_ms":31.28672,"created_at":"2026-10-03T10:13:59.500Z"},{"id":"53","request_id":"fbde8f19-655b-4ba6-8668-53249ed75ebc","method":"POST","route":"/v1/auth/login","tenant_id":null,"status":200,"duration_ms":57.37871,"created_at":"2026-10-03T10:13:59.497Z"},{"id":"52","request_id":"d1de36e4-1ef5-4375-9a4d-91fc26f2897b","method":"GET","route":"/v1/public/t/ …(recortado)
```

## POST /v1/auth/admin-lock

Bloquea las funciones de administrador de la sesión.

```bash
curl -X POST -H 'cookie: sid=<sesión>' -H 'X-Requested-With: x' 'http://localhost:3000/v1/auth/admin-lock'
```

Respuesta **200**:

```json
{"adminUnlocked":false}
```

## GET /v1/admin/tenants (bloqueado)

Con la sesión bloqueada → 403 `admin_locked`. Se desbloquea con `POST /v1/auth/admin-unlock {password}` (15 min, se renueva con el uso; 5 fallos = bloqueo de 15 min).

```bash
curl -X GET -H 'cookie: sid=<sesión>' -H 'X-Requested-With: x' 'http://localhost:3000/v1/admin/tenants'
```

Respuesta **403**:

```json
{"error":"admin_locked","message":"Confirma tu contraseña para usar las funciones de administrador","requestId":"dac75656-a2d0-42b3-b270-a14ab4558923"}
```

## GET /v1/admin/tenants (operador POS)

Ejemplo de 403 para el rol operador_pos.

```bash
curl -X GET -H 'cookie: sid=<sesión>' -H 'X-Requested-With: x' 'http://localhost:3000/v1/admin/tenants'
```

Respuesta **403**:

```json
{"error":"forbidden","message":"forbidden","requestId":"52375372-5a00-4ee7-a256-dacb0bb22216"}
```

## Otros endpoints

`POST /v1/auth/logout`, `GET /v1/auth/me`, `POST /v1/auth/totp/setup|verify`, `POST /v1/products/import` (CSV `sku,name,category,price_cents,stock[,attrs]`), `GET /v1/me/builds` y `GET /v1/me/builds/:gtin` (configuraciones guardadas de la cuenta), `POST /v1/auth/admin-unlock`, `POST /v1/scan-events`, `GET /v1/box/metrics`, `POST /v1/tenants/:id/check-link`, `PATCH /v1/admin/tenants/:id`, `POST /v1/admin/tenants|users|keys|configurators`, `OPTIONS /v1/public/t/:slug/catalog|configurations` (preflight CORS), `PATCH /v1/admin/configurators/:id`, `POST /v1/admin/keys/:id/deactivate`, `POST /v1/admin/alerts/evaluate`, `GET /v1/admin/stream` (SSE). Llaves de integración: cabecera `x-api-key`, solo `POST /v1/builds` y `GET /v1/products`.
