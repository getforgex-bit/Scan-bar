// Tarjetas de acceso con QR: entrar como la caja de un negocio sin contraseña, escaneando su tarjeta impresa.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import zlib from 'node:zlib';
import { makeApp, login, H, ADMIN_PW, POS_PW } from './helpers';
import { prepareCards, hashToken } from '../apps/api/src/acceso';

let ctx: Awaited<ReturnType<typeof makeApp>>; let app: any; let admin: any;
let ipN = 0; const ip = () => `10.77.${Math.floor(ipN / 250)}.${1 + (ipN++ % 250)}`;
const call = (method: string, url: string, cookies: any = {}, payload?: any, remoteAddress = ip()) =>
  app.inject({ method, url, cookies, headers: H, payload, remoteAddress });
const entrar = (token: string, remoteAddress = ip()) => call('POST', '/v1/auth/acceso', {}, { token }, remoteAddress);
const sid = (r: any) => ({ sid: r.cookies.find((c: any) => c.name === 'sid')?.value });
/** Como el panel (dueño de la base), para conocer el token, que la consola solo pone dentro del PDF. `nuevas` = tarjeta nueva. */
const tarjeta = async (tenantId: number, nuevas: boolean) => {
  const r = await prepareCards((sql, p) => ctx.owner.query(sql, p), { tenantIds: [tenantId], createdBy: null, base: 'https://scan-bar.ejemplo.workers.dev', nuevas });
  return r.cards[0].url.split('#k=')[1];
};
const emitir = (tenantId: number) => tarjeta(tenantId, true);

beforeAll(async () => {
  ctx = await makeApp(); app = ctx.app;
  admin = (await login(app, 'admin1@ejemplo.mx', ADMIN_PW, ip())).cookies; // solo contraseña (sin ADMIN_TOTP)
});
afterAll(async () => { await ctx.close(); });

describe('tarjetas de acceso con QR', () => {
  it('con la tarjeta se entra como la caja de ese negocio, sin contraseña', async () => {
    const token = await emitir(3);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const r = await entrar(token);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ role: 'operador_pos', tenant: { slug: 'tienda-0003', name: 'Café Origen' } });
    const me = (await call('GET', '/v1/auth/me', sid(r))).json();
    expect(me).toMatchObject({ role: 'operador_pos', email: 'caja3@ejemplo.mx', tenant: { slug: 'tienda-0003' } });
    expect((await call('GET', '/v1/labels.pdf', sid(r))).statusCode).toBe(200); // puede lo mismo que la caja
    expect((await call('GET', '/v1/admin/tenants', sid(r))).statusCode).toBe(403); // y nada de administración
    const card = (await ctx.owner.query('SELECT uses, last_used_at FROM access_cards WHERE token_hash=$1', [hashToken(token)])).rows[0];
    expect(card.uses).toBe(1); expect(card.last_used_at).not.toBeNull();
    expect((await ctx.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE action='login.tarjeta' AND tenant_id=3")).rows[0].n).toBe(1);
  });

  it('la consola baja el PDF reimprimiendo las mismas tarjetas; "Generar otra" reemplaza la anterior', async () => {
    const vieja = await emitir(5);
    expect((await entrar(vieja)).statusCode).toBe(200);
    // la copia para reimprimir va cifrada; nunca el token en claro
    const enc = (await ctx.owner.query('SELECT token_enc FROM access_cards WHERE token_hash=$1', [hashToken(vieja)])).rows[0].token_enc as string;
    expect(enc.startsWith('v1:')).toBe(true); expect(enc).not.toContain(vieja);
    const pdf = await call('POST', '/v1/admin/access-cards', admin, { tenantIds: [5] });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toMatch(/filename="tarjetas-acceso-/);
    const raw = (pdf.rawPayload as Buffer).toString('latin1');
    const texto = [...raw.matchAll(/\/FlateDecode >>\nstream\n/g)].map(m => { const i = m.index! + m[0].length; return zlib.inflateSync((pdf.rawPayload as Buffer).subarray(i, raw.indexOf('\nendstream', i))).toString('latin1'); }).join('');
    expect(texto).toContain('caja5@ejemplo.mx'); expect(texto).toContain('TARJETA DE ACCESO');
    expect(texto).not.toMatch(/#k=/); // el token solo va en el QR, nunca como texto
    // descargar otra vez no invalida la tarjeta entregada: es la misma
    expect((await entrar(vieja)).statusCode).toBe(200);
    expect(await tarjeta(5, false)).toBe(vieja);
    expect((await ctx.owner.query('SELECT count(*)::int AS n FROM access_cards WHERE tenant_id=5')).rows[0].n).toBe(1);
    expect((await ctx.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE action='access_card.printed' AND tenant_id=5")).rows[0].n).toBe(1);
    // "Generar otra": la anterior deja de servir
    expect((await call('POST', '/v1/admin/access-cards', admin, { tenantIds: [5], nuevas: true })).statusCode).toBe(200);
    expect((await entrar(vieja)).json()).toMatchObject({ error: 'tarjeta_invalida' });
    expect((await ctx.owner.query('SELECT count(*)::int AS n FROM access_cards WHERE tenant_id=5 AND revoked_at IS NULL')).rows[0].n).toBe(1);
    expect((await ctx.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE action='access_card.issued' AND tenant_id=5")).rows[0].n).toBe(1);
    const lista = (await call('GET', '/v1/admin/access-cards', admin)).json();
    expect(lista.find((t: any) => t.tenantId === 5)).toMatchObject({ caja: 'caja5@ejemplo.mx', card: { uses: 0 } });
    // desactivar sin emitir otra
    expect((await call('POST', '/v1/admin/access-cards/5/revoke', admin)).json()).toEqual({ revoked: 1 });
    expect((await call('GET', '/v1/admin/access-cards', admin)).json().find((t: any) => t.tenantId === 5).card).toBeNull();
    expect((await call('POST', '/v1/admin/access-cards/5/revoke', admin)).statusCode).toBe(404);
    // todas: crea las que faltan y conserva las activas
    const de3 = await emitir(3);
    expect((await call('POST', '/v1/admin/access-cards', admin, {})).statusCode).toBe(200);
    const conCaja = (await ctx.owner.query("SELECT count(DISTINCT tenant_id)::int AS n FROM memberships WHERE role='operador_pos'")).rows[0].n;
    expect((await ctx.owner.query('SELECT count(*)::int AS n FROM access_cards WHERE revoked_at IS NULL')).rows[0].n).toBe(conCaja);
    expect((await entrar(de3)).statusCode).toBe(200);
  });

  it('nunca da acceso de SuperAdmin ni sirve si la cuenta dejó de ser caja; tokens ajenos no entran', async () => {
    // una tarjeta apuntando al SuperAdmin (no la emite el sistema, pero si existiera) no entra
    const adminId = (await ctx.owner.query("SELECT id FROM users WHERE email='admin1@ejemplo.mx'")).rows[0].id;
    const falso = 'A'.repeat(43);
    await ctx.owner.query('UPDATE access_cards SET revoked_at=now() WHERE tenant_id=4 AND revoked_at IS NULL');
    await ctx.owner.query('INSERT INTO access_cards (tenant_id, user_id, token_hash) VALUES (4, $1, $2)', [adminId, hashToken(falso)]);
    expect((await entrar(falso)).statusCode).toBe(401);
    // la cuenta deja de ser caja del negocio: su tarjeta deja de servir
    const token = await emitir(6);
    const m = (await ctx.owner.query("DELETE FROM memberships WHERE tenant_id=6 AND role='operador_pos' RETURNING *")).rows;
    expect((await entrar(token)).statusCode).toBe(401);
    for (const x of m) await ctx.owner.query('INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1,$2,$3)', [x.user_id, x.tenant_id, x.role]);
    expect((await entrar(token)).statusCode).toBe(200);
    expect((await entrar('no-es-una-tarjeta')).statusCode).toBe(422);
    expect((await entrar('B'.repeat(43))).statusCode).toBe(401);
    // la caja no administra tarjetas
    const caja = (await login(app, 'caja3@ejemplo.mx', POS_PW, ip())).cookies;
    expect((await call('POST', '/v1/admin/access-cards', caja, { tenantIds: [3] })).statusCode).toBe(403);
    expect((await call('GET', '/v1/admin/access-cards', {})).statusCode).toBe(401);
  });

  it('bloquea la IP tras 5 tarjetas inválidas seguidas', async () => {
    const misma = '10.66.6.6';
    for (let i = 0; i < 5; i++) expect((await entrar('C'.repeat(42) + i, misma)).statusCode).toBe(401);
    const r = await entrar(await emitir(7), misma);
    expect(r.statusCode).toBe(429);
  });

});

describe('Administración solo con contraseña (sin ADMIN_TOTP)', () => {
  it('el SuperAdmin entra y administra con su contraseña, aunque antes hubiera activado el segundo factor', async () => {
    const r = await login(app, 'admin2@ejemplo.mx', ADMIN_PW, ip());
    expect(r.res.statusCode).toBe(200);
    expect((await call('GET', '/v1/auth/me', r.cookies)).json()).toMatchObject({ role: 'superadmin', totpRequired: false, adminUnlocked: true });
    expect((await call('GET', '/v1/admin/tenants', r.cookies)).statusCode).toBe(200);
    expect((await call('GET', '/v1/admin/access-cards', r.cookies)).statusCode).toBe(200);
    // quien activó el segundo factor con la versión anterior no se queda fuera
    await ctx.owner.query("UPDATE users SET totp_enabled=true, totp_secret='v1:x:y:z' WHERE email='admin3@ejemplo.mx'");
    const antes = await login(app, 'admin3@ejemplo.mx', ADMIN_PW, ip());
    expect(antes.res.statusCode).toBe(200);
    expect((await call('GET', '/v1/admin/tenants', antes.cookies)).statusCode).toBe(200);
    // la contraseña sigue siendo obligatoria y se bloquea tras 5 intentos
    const misma = '10.66.7.7';
    for (let i = 0; i < 5; i++) expect((await login(app, 'admin2@ejemplo.mx', 'mala-' + i, misma)).res.statusCode).toBe(401);
    expect((await login(app, 'admin2@ejemplo.mx', ADMIN_PW, misma)).res.statusCode).toBe(429);
  });

  it('Administración con un solo campo: basta la contraseña del administrador (sin correo)', async () => {
    const antes = process.env.ADMIN_EMAIL; process.env.ADMIN_EMAIL = 'admin4@ejemplo.mx'; // en producción: admin@scanbar.mx
    try {
      const r = await call('POST', '/v1/auth/login', {}, { password: ADMIN_PW });
      expect(r.statusCode).toBe(200); expect(r.json().role).toBe('superadmin');
      expect((await call('GET', '/v1/auth/me', sid(r))).json()).toMatchObject({ email: 'admin4@ejemplo.mx', role: 'superadmin', adminUnlocked: true });
      expect((await call('GET', '/v1/admin/access-cards', sid(r))).statusCode).toBe(200);
      expect((await call('POST', '/v1/auth/login', {}, { password: POS_PW })).statusCode).toBe(401); // otra contraseña no
      process.env.ADMIN_EMAIL = 'caja4@ejemplo.mx'; // aunque apunte a una caja, sin correo solo entra un SuperAdmin
      expect((await call('POST', '/v1/auth/login', {}, { password: POS_PW })).statusCode).toBe(401);
    } finally { if (antes === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = antes; }
  });
});
