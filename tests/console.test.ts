import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { makeApp, login, H, ADMIN_PW, POS_PW } from './helpers';
import { totpNow, verifyTotp, unbase32, base32 } from '../apps/api/src/totp';

let ctx: Awaited<ReturnType<typeof makeApp>>; let app: any;
let admin: any; let adminSecret = ''; let pos: any; let raw: any; // raw = superadmin sin TOTP

const call = (method: string, url: string, cookies: any, payload?: any, headers: any = {}) =>
  app.inject({ method, url, cookies, headers: { ...H, ...headers }, payload });

/** Alta de TOTP + sesión de SuperAdmin con segundo factor. */
async function enroll(email: string, ip: string) {
  const { cookies } = await login(app, email, ADMIN_PW, ip);
  const setup = (await call('POST', '/v1/auth/totp/setup', cookies)).json();
  const v = await call('POST', '/v1/auth/totp/verify', cookies, { code: totpNow(setup.secret) });
  return { cookies, secret: setup.secret as string, recovery: v.json().recoveryCodes as string[], verify: v };
}

beforeAll(async () => {
  ctx = await makeApp({ logRequests: true, adminTotp: true }); app = ctx.app; // con ADMIN_TOTP=1: prueba el segundo factor
  const e = await enroll('admin4@ejemplo.mx', '10.1.0.4');
  admin = e.cookies; adminSecret = e.secret;
  pos = (await login(app, 'caja4@ejemplo.mx', POS_PW, '10.1.0.5')).cookies;
  raw = (await login(app, 'admin5@ejemplo.mx', ADMIN_PW, '10.1.0.6')).cookies;
});
afterAll(async () => { await ctx.close(); });

describe('TOTP', () => {
  it('RFC 6238: vector de prueba SHA-1', () => {
    const secret = base32(Buffer.from('12345678901234567890'));
    expect(totpNow(secret, 59_000)).toBe('287082'); // vector del RFC (8 díg. 94287082 → últimos 6)
    expect(verifyTotp(secret, '287082', 59_000)).not.toBeNull();
    expect(unbase32(secret).toString()).toBe('12345678901234567890');
  });
  it('el login del SuperAdmin exige segundo factor y el código de recuperación sirve una sola vez', async () => {
    const e = await enroll('admin6@ejemplo.mx', '10.1.1.6');
    expect(e.verify.statusCode).toBe(200); expect(e.recovery.length).toBe(8);
    const noCode = await login(app, 'admin6@ejemplo.mx', ADMIN_PW, '10.1.1.7');
    expect(noCode.res.statusCode).toBe(401); expect(noCode.res.json().error).toBe('totp_required');
    const bad = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: H, remoteAddress: '10.1.1.7', payload: { email: 'admin6@ejemplo.mx', password: ADMIN_PW, totp: '000000' } });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: H, remoteAddress: '10.1.1.8', payload: { email: 'admin6@ejemplo.mx', password: ADMIN_PW, totp: totpNow(e.secret, Date.now() + 30_000) } });
    expect(good.statusCode).toBe(200);
    const rc = (ip: string) => app.inject({ method: 'POST', url: '/v1/auth/login', headers: H, remoteAddress: ip, payload: { email: 'admin6@ejemplo.mx', password: ADMIN_PW, recoveryCode: e.recovery[0] } });
    expect((await rc('10.1.1.9')).statusCode).toBe(200);
    expect((await rc('10.1.1.10')).statusCode).toBe(401); // ya usado
    const stored = (await ctx.owner.query("SELECT code_hash FROM recovery_codes WHERE user_id=(SELECT id FROM users WHERE email='admin6@ejemplo.mx')")).rows;
    expect(stored.every((r: any) => !e.recovery.includes(r.code_hash))).toBe(true); // solo hashes
  });
  it('SuperAdmin sin TOTP no abre /v1/admin/*', async () => {
    const r = await call('GET', '/v1/admin/tenants', raw);
    expect(r.statusCode).toBe(403); expect(r.json().error).toBe('totp_required');
  });
});

describe('control de acceso', () => {
  it('operador POS recibe 403 en todas las rutas /v1/admin/*', async () => {
    const routes: [string, string][] = [['GET', '/v1/admin/tenants'], ['POST', '/v1/admin/tenants'], ['PATCH', '/v1/admin/tenants/1'], ['GET', '/v1/admin/users'], ['POST', '/v1/admin/users'],
      ['GET', '/v1/admin/keys'], ['POST', '/v1/admin/keys'], ['POST', '/v1/admin/keys/1/deactivate'], ['GET', '/v1/admin/db/v_products'], ['GET', '/v1/admin/requests'],
      ['GET', '/v1/admin/requests/x'], ['GET', '/v1/admin/metrics'], ['GET', '/v1/admin/alerts'], ['POST', '/v1/admin/alerts/evaluate'], ['GET', '/v1/admin/stream'], ['POST', '/v1/tenants/1/check-link'], ['POST', '/v1/admin/preview-link'],
      ['GET', '/v1/admin/configurators'], ['POST', '/v1/admin/configurators'], ['PATCH', '/v1/admin/configurators/1']];
    for (const [m, u] of routes) expect((await call(m, u, pos, {})).statusCode, `${m} ${u}`).toBe(403);
    for (const [m, u] of routes) expect((await call(m, u, {}, {})).statusCode, `anon ${m} ${u}`).toBe(401);
  });
  it('el operador ve solo las métricas de su caja', async () => {
    const r = await call('GET', '/v1/box/metrics', pos);
    expect(r.statusCode).toBe(200); expect(Object.keys(r.json())).toEqual(['salesToday', 'scans']);
  });
});

describe('tenants, usuarios y llaves (con auditoría)', () => {
  it('alta y edición de tenant validan dominios; audit_log guarda antes y después', async () => {
    const mk = await call('POST', '/v1/admin/tenants', admin, { slug: 'tienda-0010', name: 'Nueva', companyPrefix: '0010', productUrlTpl: 'https://n.ejemplo.mx/p/{sku}', allowedDomains: ['n.ejemplo.mx'] });
    expect(mk.statusCode).toBe(201);
    const id = mk.json().id;
    expect((await call('PATCH', `/v1/admin/tenants/${id}`, admin, { productUrlTpl: 'https://otro.com/p/{sku}' })).statusCode).toBe(422);
    const ok = await call('PATCH', `/v1/admin/tenants/${id}`, admin, { productUrlTpl: 'https://n.ejemplo.mx/producto/{sku}', name: 'Nueva 2' });
    expect(ok.statusCode).toBe(200);
    const au = (await ctx.owner.query("SELECT before, after FROM audit_log WHERE action='tenant.updated' AND tenant_id=$1", [id])).rows[0];
    expect(au.before.name).toBe('Nueva'); expect(au.after.name).toBe('Nueva 2');
    expect((await call('POST', '/v1/admin/preview-link', admin, { template: 'https://n.ejemplo.mx/producto/{sku}', sku: 'A B' })).json().url).toBe('https://n.ejemplo.mx/producto/A%20B');
    expect((await call('POST', '/v1/admin/tenants', admin, { slug: 'x-dup', name: 'x', companyPrefix: '0010', productUrlTpl: 'https://n.ejemplo.mx/{sku}', allowedDomains: ['n.ejemplo.mx'] })).statusCode).toBe(409);
  });
  it('usuarios: contraseña mínima de 12 y el hash nunca se devuelve', async () => {
    expect((await call('POST', '/v1/admin/users', admin, { email: 'nuevo@ejemplo.mx', password: 'corta', tenantId: 4, role: 'operador_pos' })).statusCode).toBe(422);
    expect((await call('POST', '/v1/admin/users', admin, { email: 'nuevo@ejemplo.mx', password: 'una-clave-larga-123', tenantId: 4, role: 'operador_pos' })).statusCode).toBe(201);
    const list = await call('GET', '/v1/admin/users', admin);
    expect(list.body).not.toContain('password_hash'); expect(list.body).toContain('nuevo@ejemplo.mx');
    expect((await login(app, 'nuevo@ejemplo.mx', 'una-clave-larga-123', '10.1.2.1')).res.statusCode).toBe(200);
  });
  it('llaves: se muestran una vez, solo se guarda el hash, alcance limitado y la rotación desactiva la vieja', async () => {
    const k1 = (await call('POST', '/v1/admin/keys', admin, { tenantId: 4 })).json();
    const k2 = (await call('POST', '/v1/admin/keys', admin, { tenantId: 4 })).json();
    expect((await ctx.owner.query('SELECT key_hash FROM api_keys WHERE id=$1', [k1.id])).rows[0].key_hash).not.toContain(k1.key);
    expect(JSON.stringify((await call('GET', '/v1/admin/keys', admin)).json())).not.toContain(k1.key);
    const useKey = (k: string, url = '/v1/products', m = 'GET') => app.inject({ method: m, url, headers: { 'x-api-key': k, ...H }, payload: m === 'POST' ? {} : undefined });
    expect((await useKey(k1.key)).statusCode).toBe(200);
    expect((await useKey(k2.key)).statusCode).toBe(200); // dos llaves activas durante la rotación
    expect((await useKey(k1.key, '/v1/sales', 'POST')).statusCode).toBe(403); // fuera de alcance
    expect((await call('POST', `/v1/admin/keys/${k1.id}/deactivate`, admin)).statusCode).toBe(200);
    expect((await useKey(k1.key)).statusCode).toBe(401);
    expect((await useKey(k2.key)).statusCode).toBe(200);
    const acts = (await ctx.owner.query("SELECT action FROM audit_log WHERE action LIKE 'key.%'")).rows.map((r: any) => r.action);
    expect(acts).toContain('key.created'); expect(acts).toContain('key.deactivated');
  });
});

describe('visor de BD y depurador', () => {
  it('lista blanca: vistas y columnas fuera de ella → 422; sin password_hash; filtros parametrizados', async () => {
    expect((await call('GET', '/v1/admin/db/users', admin)).statusCode).toBe(422);
    expect((await call('GET', '/v1/admin/db/v_products?password_hash=x', admin)).statusCode).toBe(422);
    expect((await call('GET', '/v1/admin/db/v_products?sku=%27%20OR%201%3D1%20--', admin)).json().rows.length).toBe(0); // inyección tratada como valor
    const r = await call('GET', '/v1/admin/db/v_products?tenant_id=2&category=cpu', admin);
    expect(r.statusCode).toBe(200); expect(r.json().rows.length).toBe(4);
    expect(r.body).not.toContain('password_hash');
    expect((await call('GET', '/v1/admin/db/v_codes', admin)).json().rows.length).toBeLessThanOrEqual(500);
  });
  it('petición con token falso aparece redactada y el cURL no lleva credenciales', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/products?token=abc123', headers: { authorization: 'Bearer token-falso-999', cookie: 'sid=secreto', 'idempotency-key': 'k-secreta-123' } });
    const rid = r.headers['x-request-id'];
    expect(r.statusCode).toBe(401);
    await app.flushLogs();
    const d = (await call('GET', `/v1/admin/requests/${rid}`, admin)).json();
    expect(d.headers.authorization).toBe('[REDACTED]'); expect(d.headers.cookie).toBe('[REDACTED]'); expect(d.headers['idempotency-key']).toBe('[REDACTED]');
    expect(d.query).toBe('token=%5BREDACTED%5D');
    expect(d.curl).not.toMatch(/token-falso|secreto|k-secreta|abc123/);
    const list = (await call('GET', `/v1/admin/requests?requestId=${rid}`, admin)).json();
    expect(list.length).toBe(1);
  });
});

describe('métricas, alertas y tiempo real', () => {
  const kinds = async () => (await call('POST', '/v1/admin/alerts/evaluate', admin)).json().map((a: any) => a.kind).sort();

  it('cada umbral genera su alerta (y ninguna más) y se apaga al normalizarse', async () => {
    await ctx.owner.query('DELETE FROM http_log'); await ctx.owner.query('DELETE FROM scan_events');
    expect(await kinds()).toEqual([]);
    // resolución < 95 %: 30 escaneos, 20 resueltos
    for (let i = 0; i < 30; i++) await ctx.owner.query("INSERT INTO scan_events (tenant_id,mode,engine,decode_ms,total_ms,result) VALUES (2,'caja','wasm',50,120,$1)", [i < 20 ? 'resolved' : 'not_found']);
    expect(await kinds()).toEqual(['resolution_rate']);
    // error 5xx > 2 %: 30 peticiones, 5 con 500
    for (let i = 0; i < 30; i++) await ctx.owner.query("INSERT INTO http_log (request_id,method,route,status,duration_ms) VALUES ('r','GET','/x',$1,5)", [i < 5 ? 500 : 200]);
    expect(await kinds()).toEqual(['error_rate', 'resolution_rate']);
    // enlace down
    await ctx.owner.query("UPDATE tenants SET link_status='down' WHERE id=3");
    expect(await kinds()).toEqual(['error_rate', 'link_down', 'resolution_rate']);
    // normalizar
    await ctx.owner.query('DELETE FROM scan_events'); await ctx.owner.query('DELETE FROM http_log'); await ctx.owner.query("UPDATE tenants SET link_status='ok' WHERE id=3");
    expect(await kinds()).toEqual([]);
    const hist = (await call('GET', '/v1/admin/alerts', admin)).json();
    expect(hist.filter((a: any) => !a.active).length).toBe(3);
  });
  it('vistas de métricas devuelven percentiles por motor', async () => {
    for (let i = 1; i <= 20; i++) await ctx.owner.query("INSERT INTO scan_events (tenant_id,mode,engine,device,decode_ms,total_ms,result) VALUES (2,'caja','native','Android',$1,$2,'resolved')", [i * 5, i * 10]);
    await ctx.db.app.query('SELECT refresh_metrics()');
    const m = (await call('GET', '/v1/admin/metrics', admin)).json();
    const row = m.latency.find((l: any) => l.engine === 'native');
    expect(row.n).toBe(20); expect(row.decode_p95).toBeGreaterThan(90); expect(m.links.length).toBeGreaterThanOrEqual(9);
  });
  it('SSE entrega un evento en menos de 1 s y limita conexiones por usuario', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = app.server.address().port; const cookie = `sid=${admin.sid}`;
    const open = () => new Promise<{ req: http.ClientRequest; res: http.IncomingMessage }>((resolve, reject) => {
      const req = http.get({ port, host: '127.0.0.1', path: '/v1/admin/stream', headers: { cookie } }, res => resolve({ req, res })); req.on('error', reject);
    });
    const c1 = await open(); expect(c1.res.statusCode).toBe(200);
    const got = new Promise<{ ms: number; data: string }>(resolve => {
      let t0 = 0; c1.res.on('data', (b: Buffer) => { const s = b.toString(); if (/"type"\s*:\s*"scan"/.test(s)) resolve({ ms: Date.now() - t0, data: s }); }); setTimeout(() => { t0 = Date.now(); ctx.owner.query("INSERT INTO scan_events (tenant_id,mode,engine,result) VALUES (2,'caja','native','resolved')"); }, 200);
    });
    const ev = await got; expect(ev.ms).toBeLessThan(1000);
    const extra = [await open(), await open()]; expect(extra.every(c => c.res.statusCode === 200)).toBe(true);
    const fourth = await open(); expect(fourth.res.statusCode).toBe(429);
    [c1, ...extra, fourth].forEach(c => c.req.destroy());
  });
});

describe('monitor de enlaces', () => {
  it('pasa a down en la tercera revisión fallida y vuelve a ok al restablecerse', async () => {
    let mode: 'ok' | 'fail' = 'ok';
    const srv = http.createServer((q, r) => { if (mode === 'ok') { r.writeHead(200); r.end('ok'); } else { r.writeHead(500); r.end('x'); } });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as any).port;
    await ctx.owner.query("UPDATE tenants SET product_url_tpl=$1, allowed_domains=ARRAY['127.0.0.1'] WHERE id=7", [`http://127.0.0.1:${port}/producto/{sku}`]);
    const check = async () => (await call('POST', '/v1/tenants/7/check-link', admin)).json().status;
    expect(await check()).toBe('ok');
    mode = 'fail';
    expect(await check()).toBe('degraded'); expect(await check()).toBe('degraded'); expect(await check()).toBe('down');
    mode = 'ok'; expect(await check()).toBe('ok');
    const changes = (await ctx.owner.query("SELECT after FROM audit_log WHERE action='link.status' AND tenant_id=7 ORDER BY id")).rows.map((r: any) => r.after.status);
    expect(changes).toEqual(['ok', 'degraded', 'down', 'ok']);
    srv.close();
  });
});
