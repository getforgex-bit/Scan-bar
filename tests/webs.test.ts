// Integración con las páginas web: productos agregados desde Scan-bar, catálogo público, configuraciones hechas
// en la web, CORS por dominio del negocio y hoja de etiquetas en PDF.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeApp, login, H, ADMIN_PW, POS_PW } from './helpers';
import { totpNow } from '../apps/api/src/totp';
import { isValidGtin13 } from '../packages/codes/src/index';

let ctx: Awaited<ReturnType<typeof makeApp>>; let app: any;
let admin: any; let caja3: any;
let ipN = 0; const ip = () => `10.88.${Math.floor(ipN / 250)}.${1 + (ipN++ % 250)}`; // una IP por llamada: los límites de tasa se prueban en public.test
const call = (method: string, url: string, cookies: any = {}, payload?: any, headers: any = {}) =>
  app.inject({ method, url, cookies, headers: { ...H, ...headers }, payload, remoteAddress: ip() });
const SITE = 'https://equipo3.ejemplo.mx'; // dominio registrado de tienda-0003 en la semilla
const cfg = (body: any, origin = SITE) => call('POST', '/v1/public/t/tienda-0003/configurations', {}, body, { origin });

beforeAll(async () => {
  ctx = await makeApp(); app = ctx.app;
  admin = (await login(app, 'admin1@ejemplo.mx', ADMIN_PW, ip())).cookies;
  const setup = (await call('POST', '/v1/auth/totp/setup', admin)).json();
  expect((await call('POST', '/v1/auth/totp/verify', admin, { code: totpNow(setup.secret) })).statusCode).toBe(200);
  caja3 = (await login(app, 'caja3@ejemplo.mx', POS_PW, ip())).cookies;
});
afterAll(async () => { await ctx.close(); });

describe('agregar productos a una web desde Scan-bar', () => {
  let created: any[] = [];
  it('un producto con tallas crea una variante por talla, cada una con su GTIN', async () => {
    const r = await call('POST', '/v1/admin/products', admin, {
      tenantId: 3, sku: 'TAZA-SIERRA', name: 'Taza Sierra Madre', category: 'Mercancía', priceCents: 18000, stock: 12,
      description: 'Taza de barro de Motozintla', imageUrl: 'https://images.ejemplo.mx/taza.jpg', variants: [{ label: 'Chica' }, { label: 'Grande (450 ml)', priceCents: 22000 }],
    });
    expect(r.statusCode).toBe(201);
    created = r.json().created;
    expect(created.map((c: any) => c.sku)).toEqual(['TAZA-SIERRA-CHICA', 'TAZA-SIERRA-GRANDE-450-ML']);
    expect(created.map((c: any) => c.name)).toEqual(['Taza Sierra Madre — Chica', 'Taza Sierra Madre — Grande (450 ml)']);
    expect(created.every((c: any) => isValidGtin13(c.gtin) && c.gtin.startsWith('7500003'))).toBe(true);
    const list = (await call('GET', '/v1/admin/products?tenantId=3', admin)).json();
    const taza = list.find((p: any) => p.sku === 'TAZA-SIERRA-GRANDE-450-ML');
    expect(taza).toMatchObject({ origin: 'scanbar', category: 'mercancia', priceCents: 22000, variantOf: 'TAZA-SIERRA', variant: 'Grande (450 ml)', gtin: created[1].gtin });
    expect((await call('POST', '/v1/admin/products', admin, { tenantId: 3, sku: 'TAZA-SIERRA-CHICA', name: 'x', category: 'x', priceCents: 1 })).statusCode).toBe(409);
    expect((await call('POST', '/v1/admin/products', admin, { tenantId: 3, sku: 'MALA', name: 'x', category: 'x', priceCents: 1, imageUrl: 'javascript:alert(1)' })).statusCode).toBe(422);
    expect((await call('POST', '/v1/admin/products', admin, { tenantId: 99, sku: 'X', name: 'x', category: 'x', priceCents: 1 })).statusCode).toBe(404);
    expect((await ctx.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE action='product.created'")).rows[0].n).toBe(1);
  });

  it('la web lee su catálogo: solo lo agregado en Scan-bar, agrupado por variante, sin GTIN ni existencias exactas', async () => {
    const r = await call('GET', '/v1/public/t/tienda-0003/catalog', {}, undefined, { origin: SITE });
    expect(r.statusCode).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe(SITE);
    const { tenant, products } = r.json();
    expect(tenant).toEqual({ slug: 'tienda-0003', name: 'Café Origen' });
    // tienda-0003 no viene de un repositorio: todo su catálogo se administra en Scan-bar y la web lo recibe completo
    const taza = products.find((p: any) => p.sku === 'TAZA-SIERRA');
    expect(products.find((p: any) => p.sku === 'BEB-LATTE')).toMatchObject({ name: 'Latte', variants: [{ sku: 'BEB-LATTE', label: null, priceCents: 5500, inStock: true }] });
    expect(taza).toMatchObject({ sku: 'TAZA-SIERRA', name: 'Taza Sierra Madre', category: 'mercancia', priceCents: 18000, imageUrl: 'https://images.ejemplo.mx/taza.jpg' });
    expect(taza.variants).toEqual([
      { sku: 'TAZA-SIERRA-CHICA', label: 'Chica', priceCents: 18000, inStock: true },
      { sku: 'TAZA-SIERRA-GRANDE-450-ML', label: 'Grande (450 ml)', priceCents: 22000, inStock: true },
    ]);
    expect(JSON.stringify(products)).not.toMatch(/750000\d{7}|"stock"/);
    // lo que define el código de una web (origen repo) no se publica: la web ya lo tiene
    await ctx.owner.query("UPDATE products SET origin='repo' WHERE tenant_id=3 AND sku='BEB-LATTE'");
    expect((await call('GET', '/v1/public/t/tienda-0003/catalog')).json().products.some((p: any) => p.sku === 'BEB-LATTE')).toBe(false);
    await ctx.owner.query("UPDATE products SET origin='scanbar' WHERE tenant_id=3 AND sku='BEB-LATTE'");
    expect((await call('GET', '/v1/public/t/no-existe/catalog')).statusCode).toBe(404);
  });

  it('lo que viene del código de una web no se edita aquí (salvo existencias)', async () => {
    await ctx.owner.query("UPDATE products SET origin='repo' WHERE tenant_id=3 AND sku='ART-1'");
    const id = (await ctx.owner.query("SELECT id::int FROM products WHERE tenant_id=3 AND sku='ART-1'")).rows[0].id;
    const bad = await call('PATCH', `/v1/admin/products/${id}`, admin, { name: 'Otro nombre' });
    expect(bad.statusCode).toBe(409); expect(bad.json().error).toBe('administrado_por_repo');
    expect((await call('PATCH', `/v1/admin/products/${id}`, admin, { stock: 7 })).json().stock).toBe(7);
  });

  it('retirar un producto retira su código (no se borra) y lo saca de la web; reactivarlo lo devuelve', async () => {
    const id = (await call('GET', '/v1/admin/products?tenantId=3', admin)).json().find((p: any) => p.sku === 'TAZA-SIERRA-CHICA').id;
    const off = await call('PATCH', `/v1/admin/products/${id}`, admin, { active: false });
    expect(off.statusCode).toBe(200); expect(off.json().active).toBe(false);
    expect((await call('GET', `/01/0${created[0].gtin}`)).statusCode).toBe(404);
    const taza = (await call('GET', '/v1/public/t/tienda-0003/catalog')).json().products.find((p: any) => p.sku === 'TAZA-SIERRA');
    expect(taza.variants.map((v: any) => v.sku)).toEqual(['TAZA-SIERRA-GRANDE-450-ML']);
    expect((await cfg({ lines: [{ sku: 'TAZA-SIERRA-CHICA', qty: 2 }] })).statusCode).toBe(422);
    expect((await ctx.owner.query('SELECT count(*)::int AS n FROM codes WHERE gtin=$1', [created[0].gtin])).rows[0].n).toBe(1);
    expect((await call('PATCH', `/v1/admin/products/${id}`, admin, { active: true, priceCents: 19000 })).json()).toMatchObject({ active: true, priceCents: 19000 });
    expect((await call('GET', `/01/0${created[0].gtin}`)).statusCode).toBe(302);
    expect((await call('PATCH', `/v1/admin/products/${id}`, admin, { sku: 'NO-SE-CAMBIA' })).statusCode).toBe(422); // el SKU es la llave: no se edita
  });

  it('ni la caja ni un cliente registrado administran productos ni descargan etiquetas', async () => {
    const cliente = (await call('POST', '/v1/auth/register', {}, { email: 'cliente.web@ejemplo.mx', password: 'una-clave-bastante-larga' })).cookies.find((c: any) => c.name === 'sid');
    for (const c of [caja3, { sid: cliente.value }]) {
      expect((await call('GET', '/v1/admin/products?tenantId=3', c)).statusCode).toBe(403);
      expect((await call('GET', '/v1/admin/tenants/3/labels.pdf', c)).statusCode).toBe(403);
    }
  });
});

describe('CORS: solo los dominios del negocio (y localhost para pruebas)', () => {
  it('preflight de un dominio registrado → 204; de otro dominio → 403 y sin cabecera', async () => {
    const pre = (origin: string) => app.inject({ method: 'OPTIONS', url: '/v1/public/t/tienda-0003/configurations', headers: { origin, 'access-control-request-method': 'POST' }, remoteAddress: ip() });
    const ok = await pre(SITE);
    expect(ok.statusCode).toBe(204); expect(ok.headers['access-control-allow-origin']).toBe(SITE);
    expect(ok.headers['access-control-allow-headers']).toContain('X-Requested-With'); expect(ok.headers['access-control-allow-credentials']).toBeUndefined();
    expect((await pre('http://localhost:5500')).headers['access-control-allow-origin']).toBe('http://localhost:5500');
    const bad = await pre('https://otra-tienda.ejemplo.com');
    expect(bad.statusCode).toBe(403); expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    expect((await pre('https://equipo2.ejemplo.mx')).statusCode).toBe(403); // dominio de otro negocio
  });
  it('un POST desde un dominio no registrado no emite código', async () => {
    const before = (await ctx.owner.query('SELECT count(*)::int AS n FROM codes')).rows[0].n;
    const r = await cfg({ label: 'Pedido', lines: [{ sku: 'ART-2', qty: 3 }] }, 'https://otra-tienda.ejemplo.com');
    expect(r.statusCode).toBe(403); expect(r.json().error).toBe('origen_no_permitido');
    expect((await ctx.owner.query('SELECT count(*)::int AS n FROM codes')).rows[0].n).toBe(before);
  });
  it('el SVG del código es público para que la web lo muestre', async () => {
    expect((await call('GET', '/v1/codes/7500002000891.svg')).headers['access-control-allow-origin']).toBe('*');
  });
});

describe('configuraciones hechas en la web → código en Scan-bar', () => {
  const latte = [{ sku: 'BEB-LATTE', qty: 1 }, { sku: 'TAM-GRANDE', qty: 1 }, { sku: 'LEC-AVENA', qty: 1 }, { sku: 'EXT-SHOT', qty: 1 }];
  let bebida: any;
  it('una bebida configurada en la web recibe un GTIN; repetirla reutiliza el mismo', async () => {
    const r = await cfg({ label: 'Bebida', lines: latte });
    expect(r.statusCode).toBe(201); expect(r.headers['access-control-allow-origin']).toBe(SITE);
    bebida = r.json();
    expect(bebida).toMatchObject({ kind: 'build', label: 'Bebida', name: `Bebida ${bebida.gtin}`, reused: false, totalCents: 5500 + 1500 + 1200 + 1500 });
    expect(bebida.taxCents).toBe(Math.round(bebida.totalCents * 16 / 116));
    expect(isValidGtin13(bebida.gtin) && bebida.gtin.startsWith('7500003')).toBe(true);
    expect(bebida.lines.map((l: any) => l.sku).sort()).toEqual(['BEB-LATTE', 'EXT-SHOT', 'LEC-AVENA', 'TAM-GRANDE']);
    expect(bebida.svg).toEqual({ ean13: `/v1/codes/${bebida.gtin}.svg?kind=ean13`, qr: `/v1/codes/${bebida.gtin}.svg?kind=qr` });
    const again = await cfg({ label: 'Bebida', lines: [...latte].reverse() });
    expect(again.statusCode).toBe(200); expect(again.json()).toMatchObject({ gtin: bebida.gtin, reused: true });
    const asOrder = (await cfg({ label: 'Pedido', lines: latte })).json(); // misma lista, otra etiqueta → otro código
    expect(asOrder.gtin).not.toBe(bebida.gtin); expect(asOrder.name).toBe(`Pedido ${asOrder.gtin}`);
  });
  it('los precios salen de Scan-bar; cantidades repetidas se suman', async () => {
    const r = (await cfg({ label: 'Pedido', lines: [{ sku: 'ART-2', qty: 2 }, { sku: 'ART-2', qty: 1 }, { sku: 'END-AZUCAR', qty: 1 }], priceCents: 1 })).json();
    expect(r.lines.find((l: any) => l.sku === 'ART-2')).toMatchObject({ qty: 3, unitPriceCents: 20000 });
    expect(r.totalCents).toBe(60000);
  });
  it('una sola unidad de un solo producto devuelve el código propio del producto', async () => {
    const own = (await ctx.owner.query("SELECT c.gtin FROM codes c JOIN products p ON p.id=c.product_id WHERE p.tenant_id=3 AND p.sku='BEB-ESPRESSO'")).rows[0].gtin;
    const r = await cfg({ label: 'Bebida', lines: [{ sku: 'BEB-ESPRESSO', qty: 1 }] });
    expect(r.statusCode).toBe(200); expect(r.json()).toMatchObject({ kind: 'product', gtin: own, name: 'Espresso', totalCents: 3500 });
  });
  it('SKU desconocido, de otro negocio o etiqueta fuera de la lista → 422', async () => {
    const unknown = await cfg({ lines: [{ sku: 'BEB-LATTE', qty: 1 }, { sku: 'NO-EXISTE', qty: 1 }] });
    expect(unknown.statusCode).toBe(422); expect(unknown.json().detail).toEqual(['NO-EXISTE']);
    expect((await cfg({ lines: [{ sku: 'CPU-A5-7600', qty: 1 }, { sku: 'BEB-LATTE', qty: 1 }] })).statusCode).toBe(422); // CPU es de tienda-0002
    expect((await cfg({ label: '<script>', lines: latte })).statusCode).toBe(422);
    expect((await cfg({ lines: [] })).statusCode).toBe(422);
    expect((await cfg({ lines: [{ sku: 'BEB-LATTE', qty: 0 }] })).statusCode).toBe(422);
  });
  it('si la web pide un configurador de Scan-bar, sus reglas también se aplican', async () => {
    const bad = await cfg({ configurator: 'bebida', lines: [{ sku: 'BEB-ESPRESSO', qty: 1 }, { sku: 'TAM-CHICO', qty: 1 }, { sku: 'LEC-AVENA', qty: 1 }] });
    expect(bad.statusCode).toBe(422); expect(bad.json().detail.map((v: any) => v.rule)).toContain('sin_leche');
    expect((await cfg({ configurator: 'bebida', lines: latte })).json().label).toBe('Bebida');
  });
  it('el código de la web resuelve, se escanea en Caja con su contenido y se vende descontando existencias', async () => {
    await ctx.owner.query("UPDATE tenants SET link_status='down' WHERE id=3");
    const fb = await call('GET', `/01/0${bebida.gtin}`);
    expect(fb.body).toContain(`Bebida ${bebida.gtin}`); expect(fb.body).toContain('Bebida de avena');
    await ctx.owner.query("UPDATE tenants SET link_status='unknown' WHERE id=3");
    const scan = (await call('GET', `/v1/scan/${bebida.gtin}`, caja3)).json();
    expect(scan).toMatchObject({ kind: 'build', name: `Bebida ${bebida.gtin}`, priceCents: bebida.totalCents }); expect(scan.bom).toHaveLength(4);
    const stock = async () => (await ctx.owner.query("SELECT stock FROM products WHERE tenant_id=3 AND sku='LEC-AVENA'")).rows[0].stock;
    const before = await stock();
    const sale = await call('POST', '/v1/sales', caja3, { items: [{ gtin: bebida.gtin, qty: 2 }] }, { 'idempotency-key': 'venta-web-0001' });
    expect(sale.statusCode).toBe(201); expect(sale.json().totalCents).toBe(2 * bebida.totalCents); expect(await stock()).toBe(before - 2);
  });
});

describe('hoja de etiquetas en PDF', () => {
  const pdf = (q = '') => app.inject({ method: 'GET', url: `/v1/admin/tenants/3/labels.pdf${q}`, cookies: admin, remoteAddress: ip() });
  const pages = (b: Buffer) => Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(b.toString('latin1'))![1]);
  it('todas las etiquetas activas del negocio, con el nombre encima de cada código', async () => {
    const active = (await ctx.owner.query('SELECT count(*)::int AS n FROM products p JOIN codes c ON c.product_id=p.id AND c.retired_at IS NULL WHERE p.tenant_id=3 AND p.active')).rows[0].n;
    const r = await pdf();
    expect(r.statusCode).toBe(200); expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="etiquetas-tienda-0003-\d{4}-\d{2}-\d{2}\.pdf"/);
    const b = r.rawPayload as Buffer;
    expect(b.subarray(0, 8).toString()).toBe('%PDF-1.4');
    // xref: cada desplazamiento apunta al inicio de su objeto
    const s = b.toString('latin1'); const start = Number(/startxref\n(\d+)/.exec(s)![1]);
    const offs = [...s.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map(m => Number(m[1]));
    expect(offs.length).toBeGreaterThan(5); offs.forEach((o, i) => expect(s.startsWith(`${i + 1} 0 obj\n`, o)).toBe(true));
    expect(pages(b)).toBe(Math.ceil(active / 21)); // carta, 3 columnas × 7 filas
    expect((await ctx.owner.query("SELECT after FROM audit_log WHERE action='labels.pdf' ORDER BY id DESC LIMIT 1")).rows[0].after.labels).toBe(active);
    const two = (await pdf('?copies=2&category=mercancia&qr=1&paper=a4')).rawPayload as Buffer;
    expect(pages(two)).toBe(1);
    expect((await pdf('?copies=51')).statusCode).toBe(422);
    expect((await pdf('?paper=oficio')).statusCode).toBe(422);
  });
  it('el texto y los códigos del PDF se leen (pdftotext + ZXing, si están instalados)', async () => {
    const has = (bin: string) => { try { execFileSync(bin, ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } };
    if (!has('pdftotext') || !has('pdftoppm')) return; // sin poppler en esta máquina: se valida solo la estructura
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etiquetas-'));
    fs.writeFileSync(path.join(dir, 'e.pdf'), (await pdf('?category=mercancia&qr=1')).rawPayload as Buffer);
    const text = execFileSync('pdftotext', ['-layout', path.join(dir, 'e.pdf'), '-']).toString();
    expect(text).toContain('Taza Sierra Madre — Chica'); expect(text).toContain('Taza Sierra Madre — Grande (450 ml)');
    execFileSync('pdftoppm', ['-r', '300', '-png', path.join(dir, 'e.pdf'), path.join(dir, 'p')]);
    const { readBarcodes, prepareZXingModule } = await import('zxing-wasm/reader');
    prepareZXingModule({ overrides: { wasmBinary: fs.readFileSync('node_modules/zxing-wasm/dist/reader/zxing_reader.wasm').buffer as ArrayBuffer } });
    const found = await readBarcodes(new Blob([fs.readFileSync(path.join(dir, 'p-1.png'))], { type: 'image/png' }), { formats: ['EAN13', 'QRCode'] });
    const codes = (await call('GET', '/v1/admin/products?tenantId=3', admin)).json().filter((p: any) => p.category === 'mercancia').map((p: any) => p.gtin);
    expect(found.filter(f => f.format === 'EAN13').map(f => f.text).sort()).toEqual([...codes].sort());
    expect(found.filter(f => f.format === 'QRCode').map(f => f.text.split('/01/')[1]).sort()).toEqual(codes.map((g: string) => `0${g}`).sort());
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
