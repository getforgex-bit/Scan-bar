// Genera docs/API.md ejecutando la API real (dev: :3000, BD :5433). Uso: tsx scripts/gen-api-docs.ts
import pg from 'pg';
import fs from 'node:fs';
import '../apps/api/src/env';
import { totpNow } from '../apps/api/src/totp';
import { decryptSecret } from '../apps/api/src/security';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const creds = Object.fromEntries(fs.readFileSync('.dev-credentials.txt', 'utf8').split('\n').filter(Boolean).map(l => l.split('=')));
const owner = new pg.Client({ connectionString: 'postgres://postgres:postgres@localhost:5433/codes' }); await owner.connect();
const H = { 'content-type': 'application/json', 'x-requested-with': 'docs' };
let md = '# API (generada ejecutando el sistema real)\n\nBase: `http://localhost:3000`. Toda petición que cambia estado a `/v1/*` exige `X-Requested-With`. La sesión es **opcional**: el resolver, los SVG y todo `/v1/public/*` funcionan sin cuenta (con límite de tasa por IP; 429 + `Retry-After`). Sesión por cookie `sid`. Errores: `{error, message, requestId}`.\n';
const cut = (s: string) => (s.length > 700 ? s.slice(0, 700) + ' …(recortado)' : s);
const login = async (email: string, pw: string, extra: object = {}) => {
  const r = await fetch(`${BASE}/v1/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ email, password: pw, ...extra }) });
  return { r, cookie: r.headers.getSetCookie()[0]?.split(';')[0] ?? '' };
};
const doc = async (title: string, method: string, path: string, opts: { cookie?: string; body?: unknown; headers?: Record<string, string>; note?: string } = {}) => {
  const headers: Record<string, string> = { 'x-requested-with': 'docs', ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}), ...(opts.cookie ? { cookie: opts.cookie } : {}) };
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined, redirect: 'manual' });
  const pdf = res.headers.get('content-type') === 'application/pdf';
  const bin = pdf ? Buffer.from(await res.arrayBuffer()) : null;
  const text = bin ? `(PDF de ${bin.length} bytes, ${/\/Count (\d+)/.exec(bin.toString('latin1'))?.[1]} página(s); ${res.headers.get('content-disposition')})` : await res.text();
  const cors = res.headers.get('access-control-allow-origin');
  const shownHeaders = Object.entries(headers).filter(([k]) => !['x-requested-with', 'content-type'].includes(k)).map(([k, v]) => `-H '${k}: ${k === 'cookie' ? 'sid=<sesión>' : v}'`).join(' ');
  md += `\n## ${title}\n\n${opts.note ? opts.note + '\n\n' : ''}\`\`\`bash\ncurl -X ${method} ${shownHeaders} -H 'X-Requested-With: x'${opts.body ? ` -H 'Content-Type: application/json' -d '${JSON.stringify(opts.body)}'` : ''} '${BASE}${path}'\n\`\`\`\n\nRespuesta **${res.status}**${res.headers.get('location') ? ` → Location: \`${res.headers.get('location')}\`` : ''}${cors ? ` · \`Access-Control-Allow-Origin: ${cors}\`` : ''}:\n\n\`\`\`json\n${cut(text)}\n\`\`\`\n`;
  try { return JSON.parse(text); } catch { return text; }
};

const pos = await login('caja2@ejemplo.mx', creds.SEED_POS_PASSWORD);
const sec = (await owner.query("SELECT totp_secret FROM users WHERE email='admin2@ejemplo.mx'")).rows[0]?.totp_secret;
await doc('POST /v1/auth/login', 'POST', '/v1/auth/login', { body: { email: 'caja2@ejemplo.mx', password: '<contraseña>' }, note: 'Argon2id, bloqueo tras 5 intentos fallidos (15 min). El SuperAdmin con TOTP activo debe enviar además `totp` (6 dígitos) o `recoveryCode`.' });
const adm = sec ? await login('admin2@ejemplo.mx', creds.SEED_ADMIN_PASSWORD, { totp: totpNow(decryptSecret(sec)) }) : null;
await doc('GET /v1/public/tenants (sin sesión)', 'GET', '/v1/public/tenants', { note: 'Negocios con configurador activo.' });
const cafe = await doc('GET /v1/public/t/:slug/configurators/:configurador (sin sesión)', 'GET', '/v1/public/t/tienda-0003/configurators/bebida', { note: 'Definición (grupos y reglas) + opciones del catálogo. No expone stock exacto ni GTIN.' });
const cid = (sku: string) => cafe.products.find((p: any) => p.sku === sku).id;
await doc('POST /v1/public/t/:slug/builds (sin sesión)', 'POST', '/v1/public/t/tienda-0003/builds', { body: { configurator: 'bebida', lines: [{ productId: cid('BEB-LATTE'), qty: 1 }, { productId: cid('TAM-MEDIANO'), qty: 1 }, { productId: cid('LEC-AVENA'), qty: 1 }, { productId: cid('END-AZUCAR'), qty: 2 }] }, note: '10 por minuto por IP. Con sesión de cliente, además queda en `/v1/me/builds`. 422 con la regla violada (`detail[].rule`).' });
await doc('POST /v1/public/t/:slug/builds — regla violada', 'POST', '/v1/public/t/tienda-0003/builds', { body: { configurator: 'bebida', lines: [{ productId: cid('BEB-ESPRESSO'), qty: 1 }, { productId: cid('TAM-GRANDE'), qty: 1 }, { productId: cid('LEC-AVENA'), qty: 1 }] } });
// ---- Integración con las páginas web (docs/INTEGRACION-WEBS.md); requiere haber corrido npm run sync:repos ----
await doc('GET /v1/public/t/:slug/catalog (sin sesión, para las webs)', 'GET', '/v1/public/t/yokrem/catalog', { headers: { origin: 'http://localhost:8001' }, note: 'Productos que se agregaron desde Scan-bar (origen `scanbar`), agrupados por variante, para que la web los pinte. Sin GTIN ni existencias exactas. CORS solo para los `allowed_domains` del negocio (y localhost). 120/min por IP.' });
await doc('POST /v1/public/t/:slug/configurations (sin sesión, para las webs)', 'POST', '/v1/public/t/cafe-motz/configurations', { headers: { origin: 'http://localhost:8005' }, body: { label: 'Bebida', lines: [{ sku: 'americano-gde', qty: 1 }, { sku: 'LECHE-AVENA', qty: 1 }, { sku: 'EXTRA-ESPRESSO', qty: 1 }] }, note: 'Código para lo que el cliente configuró en la web (líneas por SKU). Precios de Scan-bar, nunca del cliente. Misma lista + misma etiqueta ⇒ mismo GTIN (200, `reused: true`). Una sola unidad de un solo producto devuelve el código propio del producto. `label` ∈ Pedido, Bebida, Ensamble, Paquete, Personalizado. `configurator` opcional aplica además las reglas de un configurador de Scan-bar. 30/min por IP; desde un dominio no registrado → 403 `origen_no_permitido`.' });
await doc('POST /v1/public/t/:slug/configurations — SKU desconocido', 'POST', '/v1/public/t/cafe-motz/configurations', { headers: { origin: 'http://localhost:8005' }, body: { label: 'Bebida', lines: [{ sku: 'americano-gde', qty: 1 }, { sku: 'NO-EXISTE', qty: 1 }] } });
await doc('POST /v1/auth/register', 'POST', '/v1/auth/register', { body: { email: 'alguien@ejemplo.mx', password: 'corta' }, note: 'Crea una cuenta de **cliente** (sin privilegios de personal) e inicia sesión. Contraseña ≥ 12 caracteres y no trivial; 5 intentos por hora por IP. Ejemplo de rechazo:' });
const list = await doc('GET /v1/products', 'GET', '/v1/products', { cookie: pos.cookie });
const cpu = list.find((p: any) => p.sku === 'CPU-A5-7600');
await doc('GET /v1/scan/:gtin', 'GET', `/v1/scan/${cpu.gtin}`, { cookie: pos.cookie, note: 'Solo GTIN del tenant de la sesión (404 si es de otro).' });
await doc('GET /v1/labels.pdf', 'GET', '/v1/labels.pdf?paper=letter&qr=0&copies=1', { cookie: pos.cookie, note: 'Cada negocio descarga desde su cuenta (caja o personal) la hoja de etiquetas con todos sus códigos: siempre el negocio de la sesión (RLS), nunca otro. Mismos parámetros que la versión de la consola; 404 si no hay productos para esas opciones; 10 descargas por minuto por cuenta.' });
await doc('GET /01/:gtin14 (resolver público)', 'GET', `/01/0${cpu.gtin}`, { note: '302 a la plantilla del tenant (host validado contra `allowed_domains`); ficha de respaldo HTML si el enlace está `down`; 404 propio si no existe.' });
await doc('GET /v1/codes/:gtin.svg', 'GET', `/v1/codes/${cpu.gtin}.svg?kind=ean13`, { note: '`kind=ean13|qr`; `Cache-Control: public, max-age=31536000, immutable`; 422 si el GTIN es inválido.' });
await doc('GET /v1/allowed-domains', 'GET', '/v1/allowed-domains');
const ids = ['CPU-A5-7600', 'MB-B650-ATX', 'RAM-D5-16', 'SSD-1T', 'PSU-650', 'CASE-ATX'].map(s => list.find((p: any) => p.sku === s).id);
if (adm) {
  const b = await doc('POST /v1/builds', 'POST', '/v1/builds', { cookie: adm.cookie, body: { configurator: 'pc', lines: ids.map((productId: number) => ({ productId, qty: 1 })) }, note: 'Personal o llave de integración. `configurator` es opcional (por defecto, el primero activo del negocio). Mismo BOM y precios ⇒ mismo GTIN (`reused: true`, 200). 422 con la regla violada si es incompatible.' });
  await doc('POST /v1/sales', 'POST', '/v1/sales', { cookie: pos.cookie, headers: { 'idempotency-key': crypto.randomUUID() }, body: { items: [{ gtin: b.gtin, qty: 1 }], paymentMethod: 'efectivo' }, note: '`Idempotency-Key` obligatorio; repetirla devuelve la venta original (200, `replayed: true`). 409 con detalle si falta stock.' });
  await doc('POST /v1/products', 'POST', '/v1/products', { cookie: adm.cookie, body: { sku: `DOC-${Date.now()}`, name: 'Producto de ejemplo', category: 'extra', priceCents: 1999 }, note: 'Función de administrador: SuperAdmin con contraseña confirmada (ver `POST /v1/auth/admin-unlock`). Emite el GTIN en la misma transacción.' });
  await doc('GET /v1/admin/configurators', 'GET', '/v1/admin/configurators', { cookie: adm.cookie, note: 'Consola: exige TOTP y contraseña confirmada. `POST` crea y `PATCH /:id` edita (definición validada; 422 `definicion_invalida`).' });
  const tenants = await doc('GET /v1/admin/tenants', 'GET', '/v1/admin/tenants', { cookie: adm.cookie });
  const yokrem = tenants.find((t: any) => t.slug === 'yokrem')?.id ?? 1;
  const alta = await doc('POST /v1/admin/products (con variantes)', 'POST', '/v1/admin/products', { cookie: adm.cookie, body: { tenantId: yokrem, sku: `DOC-${Date.now()}`, name: 'Blusa de ejemplo', category: 'Verano', priceCents: 49900, stock: 5, variants: [{ label: 'CH' }, { label: 'M', priceCents: 52900 }] }, note: 'Agrega un producto a la página web de cualquier negocio (consola: TOTP + contraseña confirmada). Cada variante (talla, tamaño, gramaje) es un producto con su GTIN: `SKU-VARIANTE`. Origen `scanbar`: la web lo recibe por `/catalog`. 409 si el SKU existe.' });
  await doc('GET /v1/admin/products?tenantId=', 'GET', `/v1/admin/products?tenantId=${yokrem}`, { cookie: adm.cookie, note: 'Todos los productos del negocio (activos y retirados) con su GTIN y su origen (`repo` = definido en el código de la web, `scanbar` = agregado aquí).' });
  const nuevo = (await (await fetch(`${BASE}/v1/admin/products?tenantId=${yokrem}`, { headers: { cookie: adm.cookie } })).json()).find((p: any) => p.sku === alta.created?.[0]?.sku);
  if (nuevo) await doc('PATCH /v1/admin/products/:id (retirar)', 'PATCH', `/v1/admin/products/${nuevo.id}`, { cookie: adm.cookie, body: { active: false }, note: 'Edita nombre, categoría, precio, existencias, descripción, imagen, atributos o `active`. Retirar no borra: el código queda retirado (el resolver responde 404 propio) y `active: true` lo reactiva. Un producto de origen `repo` solo admite `stock` (409 `administrado_por_repo`).' });
  await doc('GET /v1/admin/tenants/:id/labels.pdf', 'GET', `/v1/admin/tenants/${yokrem}/labels.pdf?paper=letter&qr=0&copies=1`, { cookie: adm.cookie, note: 'Hoja de etiquetas para recortar: nombre del producto encima de su EAN-13 (y QR con `qr=1`), con guías de corte. Parámetros: `paper=letter|a4`, `qr=0|1`, `copies=1..50`, `scale=80..100` (% del tamaño nominal), `category`, `origin=repo|scanbar`. Máximo 2000 etiquetas por archivo.' });
  await doc('GET /v1/admin/db/:vista', 'GET', '/v1/admin/db/v_products?tenant_id=2&category=cpu', { cookie: adm.cookie, note: 'Vistas: v_products, v_codes, v_builds, v_sales, v_scan_events. Columna fuera de la lista → 422.' });
  await doc('GET /v1/admin/metrics', 'GET', '/v1/admin/metrics', { cookie: adm.cookie });
  await doc('GET /v1/admin/alerts', 'GET', '/v1/admin/alerts', { cookie: adm.cookie });
  await doc('GET /v1/admin/requests', 'GET', '/v1/admin/requests', { cookie: adm.cookie, note: 'Depurador; detalle en `/v1/admin/requests/:request_id` (cabeceras redactadas + cURL).' });
  await doc('POST /v1/auth/admin-lock', 'POST', '/v1/auth/admin-lock', { cookie: adm.cookie, note: 'Bloquea las funciones de administrador de la sesión.' });
  await doc('GET /v1/admin/tenants (bloqueado)', 'GET', '/v1/admin/tenants', { cookie: adm.cookie, note: 'Con la sesión bloqueada → 403 `admin_locked`. Se desbloquea con `POST /v1/auth/admin-unlock {password}` (15 min, se renueva con el uso; 5 fallos = bloqueo de 15 min).' });
}
await doc('GET /v1/admin/tenants (operador POS)', 'GET', '/v1/admin/tenants', { cookie: pos.cookie, note: 'Ejemplo de 403 para el rol operador_pos.' });
md += '\n## Otros endpoints\n\n`POST /v1/auth/logout`, `GET /v1/auth/me`, `POST /v1/auth/totp/setup|verify`, `POST /v1/products/import` (CSV `sku,name,category,price_cents,stock[,attrs]`), `GET /v1/me/builds` y `GET /v1/me/builds/:gtin` (configuraciones guardadas de la cuenta), `POST /v1/auth/admin-unlock`, `POST /v1/scan-events`, `GET /v1/box/metrics`, `POST /v1/tenants/:id/check-link`, `PATCH /v1/admin/tenants/:id`, `POST /v1/admin/tenants|users|keys|configurators`, `OPTIONS /v1/public/t/:slug/catalog|configurations` (preflight CORS), `PATCH /v1/admin/configurators/:id`, `POST /v1/admin/keys/:id/deactivate`, `POST /v1/admin/alerts/evaluate`, `GET /v1/admin/stream` (SSE). Llaves de integración: cabecera `x-api-key`, solo `POST /v1/builds` y `GET /v1/products`.\n';
fs.writeFileSync('docs/API.md', md); console.log('docs/API.md', md.length, 'bytes'); await owner.end();
