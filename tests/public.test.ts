import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import fs from 'node:fs';
import { makeApp, login, H, ADMIN_PW, POS_PW } from './helpers';
import { roleUrl } from '../apps/api/src/env';
import { totpNow } from '../apps/api/src/totp';
import { isValidGtin13 } from '../packages/codes/src/index';

let ctx: Awaited<ReturnType<typeof makeApp>>; let app: any;
let ipN = 0; const ip = () => `10.77.${Math.floor(ipN / 250)}.${1 + (ipN++ % 250)}`; // una IP por llamada: los límites de tasa se prueban aparte
const call = (method: string, url: string, cookies: any = {}, payload?: any, headers: any = {}, remoteAddress = ip()) =>
  app.inject({ method, url, cookies, headers: { ...H, ...headers }, payload, remoteAddress });
const sid = (r: any) => { const c = r.cookies?.find((x: any) => x.name === 'sid'); return c ? { sid: c.value } : {}; };

let admin8Recovery: string[] = []; // códigos de recuperación del SuperAdmin con TOTP (para iniciar sesión más adelante)
let cafe: Record<string, number> = {}; // sku → id (catálogo público de la cafetería)
const lines = (...skus: (string | [string, number])[]) => skus.map(s => (Array.isArray(s) ? { productId: cafe[s[0]], qty: s[1] } : { productId: cafe[s], qty: 1 }));
const order = (l: ReturnType<typeof lines>, cookies: any = {}) => call('POST', '/v1/public/t/tienda-0003/builds', cookies, { configurator: 'bebida', lines: l });

beforeAll(async () => {
  ctx = await makeApp(); app = ctx.app;
  const d = (await call('GET', '/v1/public/t/tienda-0003/configurators/bebida')).json();
  cafe = Object.fromEntries(d.products.map((p: any) => [p.sku, p.id]));
});
afterAll(async () => { await ctx.close(); });

describe('hallazgos de seguridad 1–5', () => {
  it('(1) CSP sin scripts en línea, X-Frame-Options y HSTS fuera de localhost', async () => {
    const r = await app.inject({ url: '/health' });
    const csp = r.headers['content-security-policy'] as string;
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'"); expect(csp).toContain("frame-ancestors 'none'");
    expect(csp.split(';').find(d => d.trim().startsWith('script-src'))).not.toContain('unsafe-inline');
    expect(csp.split(';').find(d => d.trim().startsWith('style-src'))).not.toContain('unsafe-inline');
    expect(r.headers['x-frame-options']).toBe('DENY'); expect(r.headers['permissions-policy']).toContain('camera=(self)');
    expect(r.headers['strict-transport-security']).toBeUndefined(); // localhost sin TLS
    const ext = await app.inject({ url: '/health', headers: { host: 'codigos.ejemplo.mx' } });
    expect(ext.headers['strict-transport-security']).toContain('max-age=31536000');
    const nf = await app.inject({ url: '/01/00000000000000', remoteAddress: ip() }); // página propia: sin scripts
    expect(nf.statusCode).toBe(404); expect(nf.headers['content-security-policy']).toContain("default-src 'none'");
  });
  it('(2) los roles de base no tienen contraseñas fijas: salen del entorno', async () => {
    for (const f of fs.readdirSync('db/migrations')) expect(fs.readFileSync(`db/migrations/${f}`, 'utf8'), f).not.toMatch(/PASSWORD\s+'/i);
    for (const [role, old] of [['app_rw', 'app_rw_dev'], ['admin_ro', 'admin_ro_dev'], ['admin_rw', 'admin_rw_dev']]) {
      const c = new pg.Client({ connectionString: roleUrl(ctx.urls.ownerUrl, role, old) });
      await expect(c.connect(), role).rejects.toThrow(/password authentication failed|autentific/i);
      await c.end().catch(() => {});
    }
  });
  it('(3) cookie Secure salvo en localhost', async () => {
    const body = { email: 'caja1@ejemplo.mx', password: POS_PW };
    const local = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: H, payload: body, remoteAddress: ip() });
    const ext = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { ...H, host: 'codigos.ejemplo.mx' }, payload: body, remoteAddress: ip() });
    const c = (r: any) => r.cookies.find((x: any) => x.name === 'sid');
    expect(c(local).secure).toBeFalsy(); expect(c(ext).secure).toBe(true);
    expect(c(ext).httpOnly).toBe(true); expect(String(c(ext).sameSite).toLowerCase()).toBe('lax');
  });
  it('(4) límite de tasa: resolver 120/min, SVG, guardado público 10/min y registro 5/h por IP', async () => {
    const hit = async (n: number, f: () => Promise<any>) => { const out: number[] = []; for (let i = 0; i < n; i++) out.push((await f()).statusCode); return out; };
    const res = await hit(121, () => app.inject({ url: '/01/00000000000000', remoteAddress: '10.50.0.1' }));
    expect(res.slice(0, 120).every(s => s === 404)).toBe(true); expect(res[120]).toBe(429);
    const last = await app.inject({ url: '/01/00000000000000', remoteAddress: '10.50.0.1' });
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    expect((await app.inject({ url: '/01/00000000000000', remoteAddress: '10.50.0.2' })).statusCode).toBe(404); // otra IP no se ve afectada
    const svg = await hit(301, () => app.inject({ url: '/v1/codes/7500002000891.svg', remoteAddress: '10.50.0.3' }));
    expect(svg[299]).toBe(200); expect(svg[300]).toBe(429);
    const pub = await hit(11, () => call('POST', '/v1/public/t/tienda-0003/builds', {}, { lines: [] }, {}, '10.50.0.4'));
    expect(pub.slice(0, 10).every(s => s === 422)).toBe(true); expect(pub[10]).toBe(429);
    const reg = await hit(6, () => call('POST', '/v1/auth/register', {}, { email: 'x@ejemplo.mx', password: 'corta' }, {}, '10.50.0.5'));
    expect(reg.slice(0, 5).every(s => s === 422)).toBe(true); expect(reg[5]).toBe(429);
  });
  it('(5) el secreto TOTP se guarda cifrado y el segundo factor sigue funcionando', async () => {
    const { cookies } = await login(app, 'admin8@ejemplo.mx', ADMIN_PW, ip());
    const setup = (await call('POST', '/v1/auth/totp/setup', cookies)).json();
    const stored = (await ctx.owner.query("SELECT totp_secret FROM users WHERE email='admin8@ejemplo.mx'")).rows[0].totp_secret as string;
    expect(stored.startsWith('v1:')).toBe(true); expect(stored).not.toContain(setup.secret);
    const verified = await call('POST', '/v1/auth/totp/verify', cookies, { code: totpNow(setup.secret) });
    expect(verified.statusCode).toBe(200); admin8Recovery = verified.json().recoveryCodes;
    const again = await call('POST', '/v1/auth/login', {}, { email: 'admin8@ejemplo.mx', password: ADMIN_PW, totp: totpNow(setup.secret, Date.now() + 30_000) });
    expect(again.statusCode).toBe(200); expect(again.json().totpEnabled).toBe(true);
  });
});

describe('uso sin iniciar sesión', () => {
  it('lista de negocios y catálogo del configurador son públicos (sin stock ni GTIN)', async () => {
    const list = (await call('GET', '/v1/public/tenants')).json();
    expect(list.map((b: any) => b.slug)).toEqual(['tienda-0002', 'tienda-0003']);
    expect(list[1].configurators[0]).toMatchObject({ slug: 'bebida', name: 'Tu café' });
    const d = (await call('GET', '/v1/public/t/tienda-0003/configurators/bebida')).json();
    expect(d.configurator.definition.groups.map((g: any) => g.category)).toEqual(['bebida', 'tamano', 'leche', 'endulzante', 'extra']);
    expect(d.products.length).toBe(21); expect(Object.keys(d.products[0]).sort()).toEqual(['attrs', 'category', 'id', 'inStock', 'name', 'priceCents', 'sku']);
    expect((await call('GET', '/v1/public/t/no-existe/configurators/bebida')).statusCode).toBe(404);
  });
  it('un visitante anónimo arma un café y obtiene su código; el mismo pedido reutiliza el GTIN', async () => {
    const l = lines('BEB-LATTE', 'TAM-MEDIANO', 'LEC-AVENA', ['END-AZUCAR', 2], 'EXT-SHOT');
    const a = await order(l); const b = await order([...l].reverse());
    expect(a.statusCode).toBe(201); expect(b.statusCode).toBe(200);
    const j = a.json();
    expect(j.label).toBe('Bebida'); expect(isValidGtin13(j.gtin)).toBe(true); expect(j.gtin.startsWith('7500003')).toBe(true);
    expect(j.totalCents).toBe(5500 + 800 + 1200 + 0 + 1500); expect(j.saved).toBe(false);
    expect(j.bom.map((x: any) => x.name)).toEqual(['Latte', 'Mediano (12 oz)', 'Bebida de avena', 'Azúcar', 'Shot extra de espresso']); // orden de los grupos
    expect(j.bom.find((x: any) => x.name === 'Azúcar').qty).toBe(2);
    expect(b.json().gtin).toBe(j.gtin); expect(j.svg.qr).toContain('<svg');
    expect((await call('GET', '/v1/me/builds')).statusCode).toBe(401);
  });
  it('las reglas del café se aplican en el servidor y citan la regla violada', async () => {
    const rule = async (l: ReturnType<typeof lines>) => { const r = await order(l); expect(r.statusCode).toBe(422); return r.json().detail.map((v: any) => v.rule); };
    expect(await rule(lines('BEB-ESPRESSO', 'TAM-CHICO', 'LEC-AVENA'))).toContain('sin_leche');
    expect(await rule(lines('BEB-LATTE', 'TAM-CHICO'))).toContain('con_leche');
    expect(await rule(lines('BEB-ESPRESSO', 'TAM-GRANDE'))).toContain('tamano_disponible');
    expect(await rule(lines('BEB-LATTE', 'TAM-CHICO', 'LEC-ENTERA', ['END-AZUCAR', 4]))).toContain('cantidad_maxima');
    expect(await rule(lines('BEB-LATTE', 'BEB-AMERICANO', 'TAM-CHICO', 'LEC-ENTERA'))).toContain('grupo_maximo');
    expect(await rule(lines('TAM-CHICO'))).toContain('grupo_obligatorio');
    expect((await order(lines('BEB-AMERICANO', 'TAM-GRANDE', 'END-STEVIA', 'EXT-CANELA'))).statusCode).toBe(201);
    const pcPart = (await ctx.owner.query("SELECT id::int FROM products WHERE tenant_id=2 AND sku='CPU-A5-7600'")).rows[0].id;
    const cross = await order([...lines('BEB-AMERICANO', 'TAM-CHICO'), { productId: pcPart, qty: 1 }]);
    expect(cross.statusCode).toBe(422); expect(cross.json().error).toBe('producto_invalido');
  });
  it('el código de un café resuelve, y la caja de la cafetería lo vende descontando insumos', async () => {
    const b = (await order(lines('BEB-CAPUCHINO', 'TAM-GRANDE', 'LEC-ALMENDRA'))).json();
    const red = await app.inject({ url: `/01/0${b.gtin}`, remoteAddress: ip() });
    expect(red.statusCode).toBe(302); expect(red.headers.location).toBe(`https://equipo3.ejemplo.mx/ensamble/${b.gtin}`);
    await ctx.owner.query("UPDATE tenants SET link_status='down' WHERE id=3");
    const fb = await app.inject({ url: `/01/0${b.gtin}`, remoteAddress: ip() });
    expect(fb.body).toContain(`Bebida ${b.gtin}`); expect(fb.body).toContain('Capuchino'); expect(fb.body).toContain('$82.00');
    await ctx.owner.query("UPDATE tenants SET link_status='unknown' WHERE id=3");
    const caja = (await login(app, 'caja3@ejemplo.mx', POS_PW, ip())).cookies;
    const scan = (await call('GET', `/v1/scan/${b.gtin}`, caja)).json();
    expect(scan.name).toBe(`Bebida ${b.gtin}`); expect(scan.bom.length).toBe(3);
    const stock = async () => (await ctx.owner.query("SELECT stock FROM products WHERE tenant_id=3 AND sku='LEC-ALMENDRA'")).rows[0].stock;
    const before = await stock();
    const sale = await call('POST', '/v1/sales', caja, { items: [{ gtin: b.gtin, qty: 2 }] }, { 'idempotency-key': 'venta-cafe-0001' });
    expect(sale.statusCode).toBe(201); expect(sale.json().totalCents).toBe(2 * 8200); expect(await stock()).toBe(before - 2);
    const caja2 = (await login(app, 'caja2@ejemplo.mx', POS_PW, ip())).cookies; // otra empresa no lo ve
    expect((await call('GET', `/v1/scan/${b.gtin}`, caja2)).statusCode).toBe(404);
  });
});

describe('registro y cuentas de cliente', () => {
  it('registrarse crea una cuenta sin privilegios; contraseñas débiles y duplicados se rechazan', async () => {
    const reg = (email: string, password: string) => call('POST', '/v1/auth/register', {}, { email, password });
    expect((await reg('ana@ejemplo.mx', 'corta')).statusCode).toBe(422);
    expect((await reg('ana@ejemplo.mx', 'password1234')).statusCode).toBe(422);
    expect((await reg('ana.cliente@ejemplo.mx', 'x-ana.cliente-2026')).json().error).toBe('password_debil'); // contiene el correo
    const ok = await reg('Ana@Ejemplo.mx', 'cafe-con-leche-de-avena');
    expect(ok.statusCode).toBe(201);
    const me = (await call('GET', '/v1/auth/me', sid(ok))).json();
    expect(me).toMatchObject({ role: 'cliente', email: 'ana@ejemplo.mx', tenant: null, adminUnlocked: false });
    expect((await reg('ana@ejemplo.mx', 'otra-clave-larga-123')).statusCode).toBe(409);
    expect((await ctx.owner.query("SELECT count(*)::int AS n FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='ana@ejemplo.mx'")).rows[0].n).toBe(0);
    const again = await call('POST', '/v1/auth/login', {}, { email: 'ana@ejemplo.mx', password: 'cafe-con-leche-de-avena' });
    expect(again.statusCode).toBe(200); expect(again.json().role).toBe('cliente');
  });
  it('un cliente no entra a nada del personal ni de administración', async () => {
    const c = sid(await call('POST', '/v1/auth/login', {}, { email: 'ana@ejemplo.mx', password: 'cafe-con-leche-de-avena' }));
    const tries: [string, string, any?][] = [['GET', '/v1/products'], ['POST', '/v1/products', {}], ['GET', '/v1/scan/7500002000891'], ['POST', '/v1/sales', { items: [] }], ['POST', '/v1/builds', { lines: [] }],
      ['POST', '/v1/scan-events', { events: [] }], ['GET', '/v1/box/metrics'], ['GET', '/v1/admin/tenants'], ['GET', '/v1/admin/configurators'], ['POST', '/v1/auth/admin-unlock', { password: 'x' }], ['POST', '/v1/auth/totp/setup']];
    for (const [m, u, body] of tries) expect((await call(m, u, c, body, { 'idempotency-key': 'cliente-0001' })).statusCode, `${m} ${u}`).toBe(403);
  });
  it('las configuraciones de un cliente quedan guardadas en su cuenta y solo en la suya', async () => {
    const ana = sid(await call('POST', '/v1/auth/login', {}, { email: 'ana@ejemplo.mx', password: 'cafe-con-leche-de-avena' }));
    const saved = (await order(lines('BEB-FLATWHITE', 'TAM-MEDIANO', 'LEC-SOYA', 'EXT-VAINILLA'), ana)).json();
    expect(saved.saved).toBe(true);
    const mine = (await call('GET', '/v1/me/builds', ana)).json();
    expect(mine.length).toBe(1); expect(mine[0]).toMatchObject({ gtin: saved.gtin, label: 'Bebida', tenantName: 'Café Origen', configurator: 'Tu café', totalCents: 5800 + 800 + 1000 + 1000 });
    const det = (await call('GET', `/v1/me/builds/${saved.gtin}`, ana)).json();
    expect(det.bom.length).toBe(4); expect(det.svg.ean13).toContain('<svg');
    const beto = sid(await call('POST', '/v1/auth/register', {}, { email: 'beto@ejemplo.mx', password: 'otra-clave-muy-larga' }));
    expect((await call('GET', '/v1/me/builds', beto)).json()).toEqual([]);
    expect((await call('GET', `/v1/me/builds/${saved.gtin}`, beto)).statusCode).toBe(404);
  });
});

describe('contraseña para las funciones de administrador', () => {
  it('bloqueadas → 403 admin_locked; contraseña incorrecta → 401; correcta → desbloquea', async () => {
    const admin = (await login(app, 'admin9@ejemplo.mx', ADMIN_PW, ip())).cookies;
    const mk = (sku: string) => call('POST', '/v1/products', admin, { sku, name: 'Prueba', category: 'general', priceCents: 100 });
    expect((await mk('LOCK-1')).statusCode).toBe(201); // recién iniciada la sesión, la contraseña está fresca
    expect((await call('POST', '/v1/auth/admin-lock', admin)).json().adminUnlocked).toBe(false);
    const locked = await mk('LOCK-2');
    expect(locked.statusCode).toBe(403); expect(locked.json().error).toBe('admin_locked');
    expect((await call('GET', '/v1/auth/me', admin)).json().adminUnlocked).toBe(false);
    expect((await call('GET', '/v1/products', admin)).statusCode).toBe(200); // lo que no es de administrador sigue disponible
    expect((await call('POST', '/v1/auth/admin-unlock', admin, { password: 'no-es-la-clave' })).statusCode).toBe(401);
    expect((await call('POST', '/v1/auth/admin-unlock', admin, { password: ADMIN_PW })).statusCode).toBe(200);
    expect((await mk('LOCK-2')).statusCode).toBe(201);
    expect((await ctx.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE action='admin.unlocked'")).rows[0].n).toBe(1);
    for (let i = 0; i < 5; i++) await call('POST', '/v1/auth/admin-unlock', admin, { password: 'mala' });
    expect((await call('POST', '/v1/auth/admin-unlock', admin, { password: ADMIN_PW })).statusCode).toBe(429); // 5 fallos → bloqueo temporal
  });
});

describe('configuradores como datos: otro negocio sin tocar código', () => {
  it('el administrador crea un configurador para la papelería y los clientes lo usan de inmediato', async () => {
    const admin = sid(await call('POST', '/v1/auth/login', {}, { email: 'admin8@ejemplo.mx', password: ADMIN_PW, recoveryCode: admin8Recovery[0] }));
    const def = { itemLabel: 'Paquete', groups: [{ category: 'general', label: 'Artículos', min: 2, max: 3, maxQty: 5 }], rules: [] };
    const bad = await call('POST', '/v1/admin/configurators', admin, { tenantId: 1, slug: 'paquete', name: 'Paquete escolar', definition: { ...def, rules: [{ id: 'r1', type: 'forbid', when: { group: 'no-existe', attr: 'a', equals: true }, group: 'general', message: 'x' }] } });
    expect(bad.statusCode).toBe(422); expect(bad.json().error).toBe('definicion_invalida'); expect(bad.json().detail[0]).toContain('no-existe');
    expect((await call('POST', '/v1/admin/configurators', admin, { tenantId: 1, slug: 'paquete', name: 'Paquete escolar', definition: { itemLabel: 'x' } })).statusCode).toBe(422);
    const mk = await call('POST', '/v1/admin/configurators', admin, { tenantId: 1, slug: 'paquete', name: 'Paquete escolar', description: 'Arma tu paquete', definition: def });
    expect(mk.statusCode).toBe(201);
    expect((await call('POST', '/v1/admin/configurators', admin, { tenantId: 1, slug: 'paquete', name: 'Otro', definition: def })).statusCode).toBe(409);
    expect((await call('GET', '/v1/public/tenants')).json().map((b: any) => b.slug)).toContain('tienda-0001');
    const d = (await call('GET', '/v1/public/t/tienda-0001/configurators/paquete')).json();
    expect(d.products.length).toBe(3);
    const one = await call('POST', '/v1/public/t/tienda-0001/builds', {}, { configurator: 'paquete', lines: [{ productId: d.products[0].id, qty: 1 }] });
    expect(one.statusCode).toBe(422); expect(one.json().detail[0].rule).toBe('grupo_obligatorio');
    const two = await call('POST', '/v1/public/t/tienda-0001/builds', {}, { configurator: 'paquete', lines: d.products.slice(0, 2).map((p: any) => ({ productId: p.id, qty: 2 })) });
    expect(two.statusCode).toBe(201); expect(two.json().label).toBe('Paquete'); expect(two.json().gtin.startsWith('7500001')).toBe(true);
    // editar la regla (mínimo 1) surte efecto sin desplegar; desactivar lo oculta
    const id = mk.json().id;
    expect((await call('PATCH', `/v1/admin/configurators/${id}`, admin, { definition: { ...def, groups: [{ ...def.groups[0], min: 1 }] } })).statusCode).toBe(200);
    expect((await call('POST', '/v1/public/t/tienda-0001/builds', {}, { configurator: 'paquete', lines: [{ productId: d.products[0].id, qty: 1 }] })).statusCode).toBe(201);
    expect((await call('PATCH', `/v1/admin/configurators/${id}`, admin, { active: false })).statusCode).toBe(200);
    expect((await call('GET', '/v1/public/tenants')).json().map((b: any) => b.slug)).not.toContain('tienda-0001');
    expect((await call('GET', '/v1/public/t/tienda-0001/configurators/paquete')).statusCode).toBe(404);
    const au = (await ctx.owner.query("SELECT action, before, after FROM audit_log WHERE action LIKE 'configurator.%' ORDER BY id")).rows;
    expect(au.map((a: any) => a.action)).toEqual(['configurator.created', 'configurator.updated', 'configurator.updated']);
    expect(au[2].before.active).toBe(true); expect(au[2].after.active).toBe(false);
    // la consola también se bloquea con contraseña
    await call('POST', '/v1/auth/admin-lock', admin);
    expect((await call('GET', '/v1/admin/configurators', admin)).json().error).toBe('admin_locked');
  });
});

