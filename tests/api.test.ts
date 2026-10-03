import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeApp, login, H, ADMIN_PW, POS_PW } from './helpers';
import { isValidGtin13 } from '../packages/codes/src/index';

let ctx: Awaited<ReturnType<typeof makeApp>>; let app: any;
let admin2: any, pos2: any, admin3: any;
beforeAll(async () => {
  ctx = await makeApp(); app = ctx.app;
  admin2 = (await login(app, 'admin2@ejemplo.mx', ADMIN_PW)).cookies;
  pos2 = (await login(app, 'caja2@ejemplo.mx', POS_PW)).cookies;
  admin3 = (await login(app, 'admin3@ejemplo.mx', ADMIN_PW)).cookies;
});
afterAll(async () => { await ctx.close(); });

const get = (url: string, cookies: any) => app.inject({ method: 'GET', url, cookies });
const post = (url: string, cookies: any, payload: any, headers: any = {}) => app.inject({ method: 'POST', url, cookies, headers: { ...H, ...headers }, payload });

describe('sesión y roles', () => {
  it('401 sin sesión, 403 sin cabecera CSRF, 403 operador en ruta de admin', async () => {
    expect((await get('/v1/products', {})).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/products', cookies: admin2, payload: {} })).statusCode).toBe(403);
    expect((await post('/v1/products', pos2, { sku: 'Z', name: 'z', category: 'x', priceCents: 1 })).statusCode).toBe(403);
  });
  it('un operador del tenant 2 solo ve datos del tenant 2 (no accede al tenant 3)', async () => {
    const mine = (await get('/v1/products', pos2)).json();
    const theirs = (await get('/v1/products', admin3)).json();
    const gtin3 = theirs[0].gtin;
    expect(mine.every((p: any) => p.gtin.startsWith('7500002'))).toBe(true);
    const r = await get(`/v1/scan/${gtin3}`, pos2);
    expect(r.statusCode).toBe(404);
    const sale = await post('/v1/sales', pos2, { items: [{ gtin: gtin3, qty: 1 }] }, { 'idempotency-key': 'cross-tenant-1' });
    expect(sale.statusCode).toBe(422);
  });
  it('bloqueo tras 5 intentos fallidos', async () => {
    for (let i = 0; i < 5; i++) expect((await login(app, 'admin5@ejemplo.mx', 'mala-contraseña-1', '10.9.9.9')).res.statusCode).toBe(401);
    expect((await login(app, 'admin5@ejemplo.mx', ADMIN_PW, '10.9.9.9')).res.statusCode).toBe(429);
  });
  it('cookie HttpOnly y SameSite=Lax', async () => {
    const r = await login(app, 'caja4@ejemplo.mx', POS_PW, '10.0.0.4');
    const c = r.res.cookies.find((x: any) => x.name === 'sid');
    expect(c.httpOnly).toBe(true); expect(String(c.sameSite).toLowerCase()).toBe('lax');
  });
});

describe('productos y códigos', () => {
  it('50 altas concurrentes → 50 GTIN distintos y válidos', async () => {
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => post('/v1/products', admin2, { sku: `CONC-${i}`, name: `Concurrente ${i}`, category: 'extra', priceCents: 100 + i })));
    expect(rs.every(r => r.statusCode === 201)).toBe(true);
    const g = rs.map(r => r.json().gtin);
    expect(new Set(g).size).toBe(50);
    expect(g.every(isValidGtin13)).toBe(true);
  });
  it('SKU duplicado → 409', async () => {
    expect((await post('/v1/products', admin2, { sku: 'CONC-1', name: 'x', category: 'x', priceCents: 1 })).statusCode).toBe(409);
  });
  it('importación CSV es atómica y reporta errores por fila', async () => {
    const before = (await get('/v1/products', admin2)).json().length;
    const bad = await app.inject({ method: 'POST', url: '/v1/products/import', cookies: admin2, headers: { ...H, 'content-type': 'text/csv' }, payload: 'sku,name,category,price_cents,stock\nIMP-1,Uno,x,100,1\nIMP-2,Dos,x,abc,1\n' });
    expect(bad.statusCode).toBe(422); expect(bad.json().errors[0].row).toBe(3);
    const ok = await app.inject({ method: 'POST', url: '/v1/products/import', cookies: admin2, headers: { ...H, 'content-type': 'text/csv' }, payload: 'sku,name,category,price_cents,stock\nIMP-1,Uno,x,100,1\nIMP-2,Dos,x,200,1\n' });
    expect(ok.statusCode).toBe(201);
    expect((await get('/v1/products', admin2)).json().length).toBe(before + 2);
  });
  it('SVG: 422 inválido, idéntico entre llamadas, contiene los 13 dígitos, caché inmutable', async () => {
    expect((await app.inject({ url: '/v1/codes/7500002000894.svg' })).statusCode).toBe(422);
    const a = await app.inject({ url: '/v1/codes/7500002000891.svg?kind=ean13' });
    const b = await app.inject({ url: '/v1/codes/7500002000891.svg?kind=ean13' });
    expect(a.body).toBe(b.body); expect(a.headers['cache-control']).toContain('immutable');
    expect(a.body).toContain('<svg'); expect(a.body).toContain("7500002000891");
    expect((await app.inject({ url: '/v1/codes/7500002000891.svg?kind=qr' })).body).toContain('<svg');
  });
});

describe('resolver', () => {
  it('redirige a la web del tenant (9 de 9) y rechaza hosts ajenos', async () => {
    const rows = (await ctx.owner.query("SELECT DISTINCT ON (tenant_id) gtin, tenant_id FROM codes WHERE kind='product' ORDER BY tenant_id, gtin")).rows;
    expect(rows.length).toBe(9);
    for (const r of rows) {
      const res = await app.inject({ url: `/01/0${r.gtin}` });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain(`equipo${r.tenant_id}.ejemplo.mx/producto/`);
    }
    await ctx.owner.query("UPDATE tenants SET product_url_tpl='https://evil.example/p/{sku}' WHERE slug='tienda-0004'");
    const g = (await ctx.owner.query("SELECT gtin FROM codes WHERE tenant_id=4 LIMIT 1")).rows[0].gtin;
    const res = await app.inject({ url: `/01/0${g}` });
    expect(res.statusCode).toBe(200); expect(res.headers['content-type']).toContain('text/html');
  });
  it('SKU con caracteres especiales no rompe la URL; enlace down muestra ficha; GTIN inválido 404', async () => {
    const p = await post('/v1/products', admin2, { sku: 'A B/ñ?x=1&y', name: 'Raro', category: 'x', priceCents: 12345 });
    const res = await app.inject({ url: `/01/0${p.json().gtin}` });
    expect(res.headers.location).toBe('https://equipo2.ejemplo.mx/producto/A%20B%2F%C3%B1%3Fx%3D1%26y');
    await ctx.owner.query("UPDATE tenants SET link_status='down' WHERE id=2");
    const fb = await app.inject({ url: `/01/0${p.json().gtin}` });
    expect(fb.statusCode).toBe(200); expect(fb.body).toContain('$123.45');
    await ctx.owner.query("UPDATE tenants SET link_status='unknown' WHERE id=2");
    expect((await app.inject({ url: '/01/07500002000894' })).statusCode).toBe(404);
  });
});

describe('criterio 6: cambiar la URL de un tenant no rompe códigos impresos', () => {
  it('el mismo GTIN redirige a la nueva plantilla', async () => {
    const g = (await ctx.owner.query("SELECT gtin FROM codes WHERE tenant_id=5 AND kind='product' LIMIT 1")).rows[0].gtin;
    const a = await app.inject({ url: `/01/0${g}` });
    expect(a.headers.location).toContain('equipo5.ejemplo.mx');
    await ctx.owner.query("UPDATE tenants SET product_url_tpl='https://nueva-web.ejemplo.mx/p/{sku}', allowed_domains=ARRAY['nueva-web.ejemplo.mx'] WHERE id=5");
    const b = await app.inject({ url: `/01/0${g}` });
    expect(b.statusCode).toBe(302); expect(b.headers.location).toContain('nueva-web.ejemplo.mx/p/');
  });
});

describe('ventas', () => {
  it('idempotencia: doble envío = una sola venta; stock insuficiente revierte todo', async () => {
    const prods = (await get('/v1/products', pos2)).json();
    const p = prods.find((x: any) => x.sku === 'RAM-D5-16');
    const stock0 = p.stock;
    const body = { items: [{ gtin: p.gtin, qty: 2 }] };
    const a = await post('/v1/sales', pos2, body, { 'idempotency-key': 'venta-0001-abc' });
    const b = await post('/v1/sales', pos2, body, { 'idempotency-key': 'venta-0001-abc' });
    expect(a.statusCode).toBe(201); expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id); expect(b.json().replayed).toBe(true);
    expect(a.json().totalCents).toBe(2 * 109900);
    expect(a.json().taxCents).toBe(Math.round(2 * 109900 * 16 / 116));
    const after = (await get('/v1/products', pos2)).json().find((x: any) => x.sku === 'RAM-D5-16');
    expect(after.stock).toBe(stock0 - 2);
    // stock insuficiente en la 2.ª línea revierte la 1.ª
    const gpu = prods.find((x: any) => x.sku === 'GPU-4090');
    const bad = await post('/v1/sales', pos2, { items: [{ gtin: p.gtin, qty: 1 }, { gtin: gpu.gtin, qty: 99 }] }, { 'idempotency-key': 'venta-0002-abc' });
    expect(bad.statusCode).toBe(409);
    expect((await get('/v1/products', pos2)).json().find((x: any) => x.sku === 'RAM-D5-16').stock).toBe(stock0 - 2);
    expect((await post('/v1/sales', pos2, body)).statusCode).toBe(400);
  });
  it('20 envíos simultáneos con la misma llave crean una sola venta', async () => {
    const p = (await get('/v1/products', pos2)).json().find((x: any) => x.sku === 'SSD-1T');
    const rs = await Promise.all(Array.from({ length: 20 }, () => post('/v1/sales', pos2, { items: [{ gtin: p.gtin, qty: 1 }] }, { 'idempotency-key': 'venta-concurrente-1' })));
    expect(rs.every(r => r.statusCode === 200 || r.statusCode === 201)).toBe(true);
    expect(new Set(rs.map(r => r.json().id)).size).toBe(1);
  });
});

describe('ensambles', () => {
  const parts = async (skus: string[]) => { const ps = (await get('/v1/products', admin2)).json(); return skus.map(s => ps.find((p: any) => p.sku === s).id); };
  const lines = (ids: number[]) => ids.map(productId => ({ productId, qty: 1 }));
  const ok = ['CPU-A5-7600', 'MB-B650-ATX', 'RAM-D5-16', 'SSD-1T', 'PSU-650', 'CASE-ATX'];

  it('mismo BOM en distinto orden → mismo GTIN; reconstrucción por escaneo', async () => {
    const ids = await parts(ok);
    const a = await post('/v1/builds', admin2, { lines: lines(ids) });
    const b = await post('/v1/builds', admin2, { lines: lines([...ids].reverse()) });
    expect(a.statusCode).toBe(201); expect(b.statusCode).toBe(200);
    expect(b.json().gtin).toBe(a.json().gtin); expect(b.json().reused).toBe(true);
    expect(isValidGtin13(a.json().gtin)).toBe(true);
    expect(a.json().svg.ean13).toContain('<svg'); expect(a.json().digitalLink).toContain('/01/0');
    const scan = (await get(`/v1/scan/${a.json().gtin}`, pos2)).json();
    expect(scan.kind).toBe('build'); expect(scan.bom.length).toBe(6); expect(scan.totalCents).toBe(a.json().totalCents);
  });
  it('cambiar un precio produce un GTIN nuevo y el anterior conserva su precio congelado', async () => {
    const ids = await parts(ok);
    const a = (await post('/v1/builds', admin2, { lines: lines(ids) })).json();
    await ctx.owner.query("UPDATE products SET price_cents = price_cents + 100 WHERE sku='RAM-D5-16' AND tenant_id=2");
    const b = (await post('/v1/builds', admin2, { lines: lines(ids) })).json();
    expect(b.gtin).not.toBe(a.gtin);
    const old = (await get(`/v1/scan/${a.gtin}`, pos2)).json();
    const ram = old.bom.find((x: any) => x.sku === 'RAM-D5-16');
    expect(ram.currentCents - ram.frozenCents).toBe(100);
  });
  it('20 guardados idénticos simultáneos crean un solo registro', async () => {
    const ids = await parts(['CPU-A7-7700', 'MB-B650-MATX', 'RAM-D5-32', 'SSD-2T', 'PSU-750', 'CASE-MATX']);
    const rs = await Promise.all(Array.from({ length: 20 }, () => post('/v1/builds', admin2, { lines: lines(ids) })));
    expect(rs.every(r => [200, 201].includes(r.statusCode))).toBe(true);
    expect(new Set(rs.map(r => r.json().gtin)).size).toBe(1);
  });
  it('incompatibilidad cita la regla; componente de otro tenant → 422', async () => {
    const bad = await post('/v1/builds', admin2, { lines: lines(await parts(['CPU-I5-12400', 'MB-B650-ATX', 'RAM-D5-16', 'SSD-1T', 'PSU-650', 'CASE-ATX'])) });
    expect(bad.statusCode).toBe(422); expect(bad.json().detail[0].rule).toBe('socket');
    const weak = await post('/v1/builds', admin2, { lines: lines(await parts(['CPU-I7-14700', 'MB-B760-ATX', 'RAM-D5-16', 'SSD-1T', 'PSU-550', 'CASE-ATX', 'GPU-4090'])) });
    expect(weak.json().detail.some((v: any) => v.rule === 'potencia')).toBe(true);
    const other = (await get('/v1/products', admin3)).json()[0].id;
    expect((await post('/v1/builds', admin2, { lines: [{ productId: other, qty: 1 }] })).statusCode).toBe(422);
  });
  it('vender un ensamble descuenta stock por componente', async () => {
    const ids = await parts(['CPU-A5-7600', 'MB-B650-ATX', 'RAM-D5-16', 'SSD-1T', 'PSU-650', 'CASE-ATX']);
    const b = (await post('/v1/builds', admin2, { lines: lines(ids) })).json();
    const before = (await get('/v1/products', pos2)).json().find((p: any) => p.sku === 'CPU-A5-7600').stock;
    const s = await post('/v1/sales', pos2, { items: [{ gtin: b.gtin, qty: 1 }] }, { 'idempotency-key': 'venta-ensamble-1' });
    expect(s.statusCode).toBe(201);
    expect((await get('/v1/products', pos2)).json().find((p: any) => p.sku === 'CPU-A5-7600').stock).toBe(before - 1);
  });
});

describe('misc', () => {
  it('allowed-domains público, X-Request-Id en respuestas, health', async () => {
    const d = await app.inject({ url: '/v1/allowed-domains' });
    expect(d.json().domains.length).toBe(9);
    expect(d.headers['x-request-id']).toBeTruthy();
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
  });
});
