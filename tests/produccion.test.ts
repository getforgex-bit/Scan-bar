// Lo que necesita el despliegue real: Postgres administrado (sin BYPASSRLS), contenedor que se reinicia,
// cuentas iniciales por variables de entorno, sincronización con el rol de la consola y CORS por cuenta de Cloudflare.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { makeApp, login, H, ADMIN_PW } from './helpers';
import { buildApp } from '../apps/api/src/app';
import { makeDb } from '../apps/api/src/db';
import { bootstrap, cajaEmail } from '../apps/api/src/bootstrap';
import { SOURCES, ensureTenant, siteUrl, syncSource } from '../apps/api/src/sync';
import { isValidGtin13 } from '../packages/codes/src/index';

let ctx: Awaited<ReturnType<typeof makeApp>>; let app: any;
let ipN = 0; const ip = () => `10.99.${Math.floor(ipN / 250)}.${1 + (ipN++ % 250)}`;
const call = (a: any, method: string, url: string, cookies: any = {}, payload?: any, headers: any = {}) =>
  a.inject({ method, url, cookies, headers: { ...H, ...headers }, payload, remoteAddress: ip() });
const ENV = { ADMIN_PASSWORD: 'Sierra-Madre-Cumbre-2026', CAJA_PASSWORD: 'Cobro-En-Caja-Motozintla' };

beforeAll(async () => { ctx = await makeApp(); app = ctx.app; });
afterAll(async () => { await ctx.close(); });
afterEach(() => { delete process.env.RESOLVER_HOST; });

describe('base de datos administrada', () => {
  it('los roles de la aplicación no necesitan BYPASSRLS: la consola ve todos los negocios por política', async () => {
    const roles = (await ctx.owner.query("SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('app_rw','admin_ro','admin_rw') ORDER BY 1")).rows;
    expect(roles.map((r: any) => r.rolname)).toEqual(['admin_ro', 'admin_rw', 'app_rw']);
    expect(roles.every((r: any) => r.rolbypassrls === false)).toBe(true);
    expect((await ctx.db.admin.query('SELECT count(DISTINCT tenant_id)::int AS n FROM products')).rows[0].n).toBe(9);
    expect((await ctx.db.app.query('SELECT count(*)::int AS n FROM products')).rows[0].n).toBe(0); // sin app.tenant_id, RLS no deja ver nada
  });
});

describe('sesiones que sobreviven a un reinicio del contenedor', () => {
  it('la sesión sigue viva en otra instancia del servidor y el bloqueo de administrador se conserva', async () => {
    const { cookies } = await login(app, 'admin1@ejemplo.mx', ADMIN_PW, ip());
    expect((await call(app, 'GET', '/v1/auth/me', cookies)).json()).toMatchObject({ role: 'superadmin', adminUnlocked: true });
    await call(app, 'POST', '/v1/auth/admin-lock', cookies);
    const db2 = makeDb(ctx.db.urls); const app2 = await buildApp({ db: db2, logRequests: false, timers: false });
    try {
      const me = (await call(app2, 'GET', '/v1/auth/me', cookies)).json();
      expect(me).toMatchObject({ role: 'superadmin', email: 'admin1@ejemplo.mx', adminUnlocked: false });
      expect((await ctx.owner.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n).toBeGreaterThan(0);
      expect((await ctx.owner.query('SELECT id FROM sessions')).rows.every((r: any) => r.id !== cookies.sid)).toBe(true); // solo el hash
      await call(app2, 'POST', '/v1/auth/logout', cookies);
      expect((await call(app, 'GET', '/v1/auth/me', cookies)).json()).toMatchObject({ role: 'superadmin' }); // la otra instancia aún la tiene en caché…
      const app3 = await buildApp({ db: makeDb(ctx.db.urls), logRequests: false, timers: false });
      expect((await call(app3, 'GET', '/v1/auth/me', cookies)).json()).toEqual({ anonymous: true }); // …pero ya no existe en la base
      await app3.close(); await (app3 as any).db.close();
    } finally { await app2.close(); await db2.close(); }
  });
});

describe('arranque de producción', () => {
  it('crea los seis negocios, el administrador y una caja por negocio; es idempotente y rechaza contraseñas débiles', async () => {
    await expect(bootstrap(ctx.db.adminRw, { ADMIN_PASSWORD: 'corta' })).rejects.toThrow(/no sirve/);
    const notes = await bootstrap(ctx.db.adminRw, ENV);
    expect(notes.join('\n')).toContain('admin@scanbar.mx');
    expect((await bootstrap(ctx.db.adminRw, ENV)).length).toBe(2); // segunda vez: nada nuevo, sin errores
    const slugs = (await ctx.owner.query('SELECT slug FROM tenants WHERE company_prefix >= $1 ORDER BY company_prefix', ['0010'])).rows.map((r: any) => r.slug);
    expect(slugs).toEqual(SOURCES.map(s => s.slug));
    const admin = await call(app, 'POST', '/v1/auth/login', {}, { email: 'admin@scanbar.mx', password: ENV.ADMIN_PASSWORD });
    expect(admin.statusCode).toBe(200); expect(admin.json().role).toBe('superadmin');
    expect((await ctx.owner.query("SELECT count(*)::int AS n FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='admin@scanbar.mx'")).rows[0].n).toBe(6);
    const caja = await call(app, 'POST', '/v1/auth/login', {}, { email: cajaEmail('cafe-motz'), password: ENV.CAJA_PASSWORD });
    expect(caja.json().role).toBe('operador_pos');
    const me = (await call(app, 'GET', '/v1/auth/me', { sid: caja.cookies.find((c: any) => c.name === 'sid').value })).json();
    expect(me.tenant.slug).toBe('cafe-motz');
  });

  it('el secreto manda: cambiar ADMIN_PASSWORD y reiniciar cambia la contraseña y cierra las sesiones; nadie puede registrar los correos reservados', async () => {
    for (const email of ['admin@scanbar.mx', 'caja.yokrem@scanbar.mx', 'otro@scanbar.mx'])
      expect((await call(app, 'POST', '/v1/auth/register', {}, { email, password: 'Una-Clave-Bastante-Larga-1' })).statusCode).toBe(409);
    await bootstrap(ctx.db.adminRw, ENV);
    const before = await call(app, 'POST', '/v1/auth/login', {}, { email: 'admin@scanbar.mx', password: ENV.ADMIN_PASSWORD });
    const sid = before.cookies.find((c: any) => c.name === 'sid').value;
    const NEW = { ...ENV, ADMIN_PASSWORD: 'Otra-Cumbre-De-La-Sierra-2027' };
    expect(await bootstrap(ctx.db.adminRw, NEW)).toContain('Contraseña actualizada: admin@scanbar.mx');
    const fresh = await buildApp({ db: makeDb(ctx.db.urls), logRequests: false, timers: false }); // como un contenedor recién arrancado
    try {
      expect((await call(fresh, 'GET', '/v1/auth/me', { sid })).json()).toEqual({ anonymous: true });
      expect((await call(fresh, 'POST', '/v1/auth/login', {}, { email: 'admin@scanbar.mx', password: ENV.ADMIN_PASSWORD })).statusCode).toBe(401);
      expect((await call(fresh, 'POST', '/v1/auth/login', {}, { email: 'admin@scanbar.mx', password: NEW.ADMIN_PASSWORD })).statusCode).toBe(200);
    } finally { await fresh.close(); await (fresh as any).db.close(); }
    expect(await bootstrap(ctx.db.adminRw, NEW)).not.toContain('Contraseña actualizada: admin@scanbar.mx');
  });

  it('la URL de cada web se deduce de la cuenta de workers.dev de Scan-bar (o de WEB_URL_<NEGOCIO>)', async () => {
    const src = SOURCES.find(s => s.slug === 'cafe-motz')!;
    expect(siteUrl(src, {})).toBeNull();
    expect(siteUrl(src, { RESOLVER_HOST: 'scan-bar.forgex.workers.dev' })).toBe('https://motz-cafe.forgex.workers.dev/');
    expect(siteUrl(src, { RESOLVER_HOST: 'scan-bar.forgex.workers.dev', WEB_URL_CAFE_MOTZ: 'https://cafe.ejemplo.mx' })).toBe('https://cafe.ejemplo.mx/');
    // un negocio creado con la URL provisional de GitHub se actualiza en cuanto se conoce la real
    process.env.RESOLVER_HOST = 'scan-bar.forgex.workers.dev';
    const c = await ctx.db.adminRw.connect();
    try { await ensureTenant(c, src); } finally { c.release(); }
    const t = (await ctx.owner.query("SELECT product_url_tpl, allowed_domains FROM tenants WHERE slug='cafe-motz'")).rows[0];
    expect(t).toEqual({ product_url_tpl: 'https://motz-cafe.forgex.workers.dev/', allowed_domains: ['motz-cafe.forgex.workers.dev'] });
  });
});

describe('sincronización con el rol de la consola (sin superusuario)', () => {
  it('crea con GTIN, actualiza, retira lo que desaparece y no toca lo agregado desde Scan-bar', async () => {
    const src = SOURCES.find(s => s.slug === 'dulce-encanto')!;
    const item = (sku: string, cents: number) => ({ sku, name: `Prueba ${sku}`, category: 'Pasteles', cents, attrs: {} });
    const first = await syncSource(ctx.db.adminRw, src, [item('PASTEL-A', 30000), item('PASTEL-B', 25000)]);
    expect(first).toMatchObject({ items: 2, created: 2, updated: 0, retired: 0 });
    const tid = (await ctx.owner.query("SELECT id FROM tenants WHERE slug='dulce-encanto'")).rows[0].id;
    await ctx.owner.query("INSERT INTO products (tenant_id, sku, name, category, price_cents, origin) VALUES ($1,'PASTEL-C','De la consola','pasteles',100,'scanbar')", [tid]);
    const second = await syncSource(ctx.db.adminRw, src, [item('PASTEL-A', 32000), item('PASTEL-C', 1)]);
    expect(second).toMatchObject({ created: 0, updated: 1, retired: 1, skipped: 1 });
    const rows = (await ctx.owner.query("SELECT p.sku, p.active, p.price_cents, p.origin, c.gtin, c.retired_at IS NOT NULL AS retirado FROM products p LEFT JOIN codes c ON c.product_id=p.id WHERE p.tenant_id=$1 ORDER BY p.sku", [tid])).rows;
    expect(rows.map((r: any) => [r.sku, r.active, r.price_cents, r.origin, r.retirado])).toEqual([
      ['PASTEL-A', true, 32000, 'repo', false], ['PASTEL-B', false, 25000, 'repo', true], ['PASTEL-C', true, 100, 'scanbar', false]]);
    expect(isValidGtin13(rows[0].gtin) && rows[0].gtin.startsWith('7500012')).toBe(true);
    await expect(syncSource(ctx.db.adminRw, src, [])).rejects.toThrow(/ningún producto/); // un repo vacío nunca retira todo
  });
});

describe('CORS para las webs de la misma cuenta de Cloudflare', () => {
  it('una web en *.cuenta.workers.dev puede leer el catálogo de Scan-bar en la misma cuenta; otra cuenta no', async () => {
    const pre = (origin: string) => app.inject({ method: 'OPTIONS', url: '/v1/public/t/tienda-0003/configurations', headers: { origin, host: 'scan-bar.forgex.workers.dev', 'access-control-request-method': 'POST' }, remoteAddress: ip() });
    const ok = await pre('https://motz-cafe.forgex.workers.dev');
    expect(ok.statusCode).toBe(204); expect(ok.headers['access-control-allow-origin']).toBe('https://motz-cafe.forgex.workers.dev');
    expect((await pre('https://motz-cafe.otra-cuenta.workers.dev')).statusCode).toBe(403);
    expect((await pre('https://forgex.workers.dev.malo.com')).statusCode).toBe(403);
    expect(process.env.RESOLVER_HOST).toBe('scan-bar.forgex.workers.dev'); // aprendido de la primera petición en workers.dev
  });
});
