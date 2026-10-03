import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import argon2 from 'argon2';
import bwipjs from 'bwip-js';
import { z } from 'zod';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isProd } from './env';
import { makeDb, withTenant, publicQuery, type Db, type Tx } from './db';
import { gtinSvg } from './svg';
import { buildGtin13, isValidGtin13, parseDigitalLink } from '../../../packages/codes/src/index';
import { HttpError } from './errors';
import { registerAdmin, redactHeaders, redactQuery } from './admin';
import { registerBuilds, bomHash } from './builds';
import { registerWeb } from './web';
import { issueProductCode, buildLabels, sendLabels, labelsQuery } from './catalog';
import { isReservedEmail } from './bootstrap';
import { newSecret, verifyTotp, otpauthUri, sha256 } from './totp';
import { securityHeaders, rateLimiter, isLocalHost, encryptSecret, decryptSecret, passwordProblem, PAGE_CSP } from './security';
import { STAFF, ADMIN_UNLOCK_MS, SessionStore, type Role, type Session } from './session';
export { HttpError, bomHash, issueProductCode };

declare module 'fastify' { interface FastifyRequest { session?: Session; sessionId?: string } }

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const money = (c: number) => `$${(c / 100).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;

const audit = (tx: Tx, tenantId: number | null, userId: number | null, action: string, before: unknown, after: unknown) =>
  tx.query('INSERT INTO audit_log (tenant_id,user_id,action,before,after) VALUES ($1,$2,$3,$4,$5)', [tenantId, userId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(c => c !== '')) rows.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur); if (row.some(c => c !== '')) rows.push(row);
  return rows;
}

const productIn = z.object({
  sku: z.string().min(1).max(64), name: z.string().min(1).max(200), category: z.string().min(1).max(40),
  priceCents: z.number().int().min(0), stock: z.number().int().min(0).default(0), attrs: z.record(z.string(), z.any()).default({}),
});

export type AppOpts = { db?: Db; staticDir?: string; logRequests?: boolean; timers?: boolean };

export async function buildApp(opts: AppOpts = {}): Promise<FastifyInstance & { db: Db }> {
  if (isProd()) encryptSecret('arranque'); // en producción, sin TOTP_ENC_KEY no se arranca
  const db = opts.db ?? makeDb();
  // TRUST_PROXY=1 cuando hay un proxy TLS delante: req.ip y req.hostname salen de X-Forwarded-*.
  // PROXY_KEY: el servidor es público (Render) y solo debe hablar con el Worker de Cloudflare, que firma cada petición.
  const proxyKey = process.env.PROXY_KEY ?? '';
  const app = Fastify({ logger: false, genReqId: () => crypto.randomUUID(), trustProxy: proxyKey ? true : process.env.TRUST_PROXY === '1' }) as unknown as FastifyInstance & { db: Db };
  app.db = db;
  await app.register(cookie);
  app.addContentTypeParser('text/csv', { parseAs: 'string' }, (_r, body, done) => done(null, body));

  const sessions = new SessionStore(db.app);
  const fails = new Map<string, { n: number; first: number; lockedUntil: number }>();
  const lastStep = new Map<number, number>();
  const limit = rateLimiter();
  const audit2 = (s: Session, action: string) => db.adminRw.query('INSERT INTO audit_log (tenant_id,user_id,action) VALUES ($1,$2,$3)', [s.tenantId || null, s.userId, action]);

  // ---- hooks ----
  // Con PROXY_KEY, solo se atiende lo que llega por el Worker (encabezado x-scanbar-proxy); de él salen el host público y la
  // IP real. Así nadie que llame directo al servidor puede hacerse pasar por el Worker (p. ej. para que se aprenda otro host).
  if (proxyKey) app.addHook('onRequest', async (req, reply) => {
    const h = req.raw.headers;
    const given = h['x-scanbar-proxy'];
    if (typeof given !== 'string' || !crypto.timingSafeEqual(Buffer.from(sha256(given)), Buffer.from(sha256(proxyKey)))) {
      if (req.url === '/health') { delete h['x-forwarded-host']; delete h['x-forwarded-for']; delete h['x-forwarded-proto']; return; } // revisión de salud del servidor
      return reply.status(403).type('text/plain; charset=utf-8').send('Scan-bar solo responde en su dirección pública.');
    }
    delete h['x-scanbar-proxy'];
    h['x-forwarded-host'] = typeof h['x-scanbar-host'] === 'string' ? h['x-scanbar-host'] : '';
    h['x-forwarded-proto'] = 'https';
    h['x-forwarded-for'] = typeof h['x-scanbar-ip'] === 'string' ? h['x-scanbar-ip'] : '';
  });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
    securityHeaders(req, reply);
    // En Cloudflare (workers.dev) el host público se aprende de la primera petición: lo usan los QR y las URL de las webs.
    if (!process.env.RESOLVER_HOST && /^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/i.test(req.hostname)) process.env.RESOLVER_HOST = req.hostname;
    const sid = req.cookies?.sid;
    const s = sid && sid.length <= 100 ? await sessions.get(sid) : undefined;
    if (s) { req.session = s; req.sessionId = sid; if (s.role === 'superadmin') s.exp = Date.now() + 2 * 3600_000; } // 2 h de inactividad
    const apiKey = req.headers['x-api-key'];
    if (!req.session && typeof apiKey === 'string') {
      const hash = sha256(apiKey);
      const k = (await publicQuery(db, 'SELECT * FROM api_key_lookup($1)', [hash])).rows[0];
      if (!k) throw new HttpError(401, 'llave_invalida');
      const path = req.url.split('?')[0];
      const allowed = (req.method === 'POST' && path === '/v1/builds' && k.scope.includes('builds:create')) || (req.method === 'GET' && path === '/v1/products' && k.scope.includes('catalog:read'));
      if (!allowed) throw new HttpError(403, 'alcance_insuficiente');
      req.session = { userId: 0, tenantId: k.tenant_id, role: 'integration', exp: Date.now() + 60_000, scope: k.scope, keyId: hash.slice(0, 16) };
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.url.startsWith('/v1/') && !req.headers['x-requested-with'])
      throw new HttpError(403, 'csrf', 'Falta el encabezado X-Requested-With');
  });

  const logBuf: any[] = [];
  const flushLog = async () => {
    const batch = logBuf.splice(0, logBuf.length);
    for (const l of batch) await db.app.query('INSERT INTO http_log (request_id,method,route,tenant_id,status,duration_ms,headers,query,url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', l).catch(() => {});
  };
  const logTimer = opts.logRequests === false ? null : setInterval(() => { if (logBuf.length) flushLog(); }, 2000);
  logTimer?.unref();
  app.addHook('onResponse', async (req, reply) => {
    if (opts.logRequests === false) return;
    logBuf.push([req.id, req.method, req.routeOptions?.url ?? req.url.split('?')[0], req.session?.tenantId || null, reply.statusCode, reply.elapsedTime, JSON.stringify(redactHeaders(req.headers as any)), redactQuery(req.url.split('?')[1] ?? ''), req.url.split('?')[0]]);
    if (logBuf.length >= 50) await flushLog();
  });
  (app as any).flushLogs = flushLog;
  // Bloqueo, desbloqueo, segundo factor y vencimiento deslizante se guardan en la base (ver SessionStore.save).
  app.addHook('onResponse', async req => { if (req.session && req.sessionId) await sessions.save(req.sessionId, req.session).catch(() => {}); });
  app.addHook('onClose', async () => { if (logTimer) clearInterval(logTimer); await flushLog(); if (!opts.db) await db.close(); });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message, detail: err.detail, requestId: req.id });
    if (err instanceof z.ZodError) return reply.status(422).send({ error: 'validation', message: err.issues[0]?.message, issues: err.issues, requestId: req.id });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.code ?? 'bad_request', message: err.message, requestId: req.id });
    console.error(err);
    return reply.status(500).send({ error: 'internal', requestId: req.id });
  });

  // ---- guardas ----
  /** Sin roles = cualquier personal (SuperAdmin, operador o llave). Una cuenta de cliente nunca pasa. */
  const auth = (...roles: Role[]) => async (req: FastifyRequest) => {
    if (!req.session) throw new HttpError(401, 'unauthenticated');
    if (req.session.role === 'integration') return; // ya filtrada por alcance en onRequest
    if (!(roles.length ? roles : STAFF).includes(req.session.role)) throw new HttpError(403, 'forbidden');
  };
  /** Cualquier cuenta con sesión (incluye clientes registrados). */
  const anyUser = async (req: FastifyRequest) => {
    if (!req.session || req.session.role === 'integration') throw new HttpError(401, 'unauthenticated');
  };
  /** Funciones de administrador: SuperAdmin + contraseña confirmada hace menos de 15 min (se renueva con el uso). */
  const adminOnly = async (req: FastifyRequest) => {
    const s = req.session;
    if (!s) throw new HttpError(401, 'unauthenticated');
    if (s.role !== 'superadmin') throw new HttpError(403, 'forbidden');
    if ((s.adminUntil ?? 0) < Date.now()) throw new HttpError(403, 'admin_locked', 'Confirma tu contraseña para usar las funciones de administrador');
    s.adminUntil = Date.now() + ADMIN_UNLOCK_MS;
  };
  const S = (req: FastifyRequest) => req.session!;

  const noteFail = (key: string) => {
    const f = fails.get(key) ?? { n: 0, first: Date.now(), lockedUntil: 0 };
    if (Date.now() - f.first > 60_000) { f.n = 0; f.first = Date.now(); }
    f.n++; if (f.n >= 5) f.lockedUntil = Date.now() + 15 * 60_000;
    fails.set(key, f);
  };
  const startSession = async (req: FastifyRequest, reply: any, s: Omit<Session, 'exp'>) => {
    const hours = s.role === 'superadmin' ? 2 : 12;
    const sid = await sessions.create(s, hours * 3600_000); // rotación: siempre un id nuevo
    // Secure siempre, salvo en localhost (desarrollo sin TLS).
    reply.setCookie('sid', sid, { httpOnly: true, secure: !isLocalHost(req.hostname), sameSite: 'lax', path: '/', maxAge: hours * 3600 });
  };

  // ---- salud ----
  app.get('/health', async () => ({ ok: true }));

  // ---- cuentas: el inicio de sesión es opcional; registrarse crea una cuenta de cliente sin privilegios ----
  app.post('/v1/auth/register', async (req, reply) => {
    limit(reply, `register:${req.ip}`, 5, 3600_000);
    const b = z.object({ email: z.string().email().max(200), password: z.string().max(200) }).parse(req.body);
    const email = b.email.toLowerCase();
    if (isReservedEmail(email)) throw new HttpError(409, 'ya_registrado', 'Ese correo ya tiene una cuenta; inicia sesión');
    const problem = passwordProblem(b.password, email);
    if (problem) throw new HttpError(422, 'password_debil', problem);
    const hash = await argon2.hash(b.password, { type: argon2.argon2id });
    const id = (await publicQuery(db, 'SELECT register_user($1,$2) AS id', [email, hash])).rows[0].id;
    if (!id) throw new HttpError(409, 'ya_registrado', 'Ese correo ya tiene una cuenta; inicia sesión');
    await startSession(req, reply, { userId: Number(id), tenantId: 0, role: 'cliente', email });
    return reply.status(201).send({ role: 'cliente' });
  });

  app.post('/v1/auth/login', async (req, reply) => {
    limit(reply, `login:${req.ip}`, 30, 60_000);
    const body = z.object({ email: z.string().email(), password: z.string().min(1), tenantSlug: z.string().optional(), totp: z.string().optional(), recoveryCode: z.string().optional() }).parse(req.body);
    const email = body.email.toLowerCase();
    const key = `${email}|${req.ip}`;
    if ((fails.get(key)?.lockedUntil ?? 0) > Date.now()) throw new HttpError(429, 'locked', 'Cuenta bloqueada temporalmente');
    const rows = (await publicQuery(db, 'SELECT * FROM login_lookup($1)', [email])).rows;
    const ok = rows.length > 0 && await argon2.verify(rows[0].password_hash, body.password).catch(() => false);
    if (!ok) { noteFail(key); throw new HttpError(401, 'bad_credentials', 'Credenciales inválidas'); }
    let m = rows[0];
    if (body.tenantSlug) {
      const t = (await publicQuery(db, 'SELECT * FROM public_tenant($1)', [body.tenantSlug])).rows[0];
      m = rows.find(r => r.tenant_id === t?.id) ?? rows[0];
    }
    const role: Role = m.role ?? 'cliente'; // sin membresía = cliente registrado
    let totpOk = false;
    if (role === 'superadmin') {
      const t = (await publicQuery(db, 'SELECT * FROM user_totp($1)', [m.id])).rows[0];
      if (t?.totp_enabled) {
        let good = false;
        if (body.totp) { const step = verifyTotp(decryptSecret(t.totp_secret), body.totp); good = step !== null && step !== lastStep.get(Number(m.id)); if (good) lastStep.set(Number(m.id), step!); }
        else if (body.recoveryCode) good = (await publicQuery(db, 'SELECT use_recovery_code($1,$2) AS ok', [m.id, sha256(body.recoveryCode.trim().toLowerCase())])).rows[0].ok;
        else throw new HttpError(401, 'totp_required', 'Se requiere código de segundo factor');
        if (!good) { noteFail(key); throw new HttpError(401, 'totp_invalido', 'Código inválido'); }
        totpOk = true;
      }
    }
    fails.delete(key);
    await startSession(req, reply, { userId: Number(m.id), tenantId: m.tenant_id ?? 0, role, email, totp: totpOk, adminUntil: role === 'superadmin' ? Date.now() + ADMIN_UNLOCK_MS : undefined });
    return { role, tenantId: m.tenant_id ?? null, totpEnabled: totpOk };
  });
  app.post('/v1/auth/logout', async (req, reply) => {
    if (req.cookies?.sid) await sessions.destroy(req.cookies.sid);
    reply.clearCookie('sid', { path: '/' });
    return { ok: true };
  });
  // Sin sesión responde 200 { anonymous: true }: la app se usa sin cuenta y no debe ensuciar la consola con 401.
  app.get('/v1/auth/me', async req => {
    const s = req.session;
    if (!s || s.role === 'integration') return { anonymous: true };
    const tenant = s.tenantId ? (await withTenant(db, s.tenantId, tx => tx.query('SELECT id, slug, name FROM tenants WHERE id=$1', [s.tenantId]))).rows[0] : null;
    return { role: s.role, email: s.email, tenant, totp: !!s.totp, adminUnlocked: (s.adminUntil ?? 0) > Date.now() };
  });

  // ---- contraseña para las funciones de administrador (confirmación tipo "sudo") ----
  app.post('/v1/auth/admin-unlock', { preHandler: auth('superadmin') }, async req => {
    const s = S(req); const { password } = z.object({ password: z.string().min(1).max(200) }).parse(req.body);
    const key = `unlock|${s.userId}`;
    if ((fails.get(key)?.lockedUntil ?? 0) > Date.now()) throw new HttpError(429, 'locked', 'Demasiados intentos; espera 15 minutos');
    const u = (await publicQuery(db, 'SELECT * FROM user_auth($1)', [s.userId])).rows[0];
    if (!u || !(await argon2.verify(u.password_hash, password).catch(() => false))) { noteFail(key); throw new HttpError(401, 'bad_credentials', 'Contraseña incorrecta'); }
    fails.delete(key);
    s.adminUntil = Date.now() + ADMIN_UNLOCK_MS;
    await audit2(s, 'admin.unlocked');
    return { adminUnlocked: true, minutes: ADMIN_UNLOCK_MS / 60_000 };
  });
  app.post('/v1/auth/admin-lock', { preHandler: auth('superadmin') }, async req => { S(req).adminUntil = 0; return { adminUnlocked: false }; });

  // ---- TOTP del SuperAdmin ----
  app.post('/v1/auth/totp/setup', { preHandler: adminOnly }, async req => {
    const s = S(req);
    if (s.totp) throw new HttpError(409, 'totp_ya_activo');
    const secret = newSecret();
    await db.adminRw.query('UPDATE users SET totp_secret=$2, totp_enabled=false WHERE id=$1', [s.userId, encryptSecret(secret)]); // cifrado en reposo
    const uri = otpauthUri(secret, s.email ?? 'admin');
    return { secret, otpauth: uri, qr: (bwipjs as any).toSVG({ bcid: 'qrcode', text: uri, eclevel: 'M', scale: 4 }) };
  });
  app.post('/v1/auth/totp/verify', { preHandler: adminOnly }, async req => {
    const s = S(req); const { code } = z.object({ code: z.string() }).parse(req.body);
    const t = (await publicQuery(db, 'SELECT * FROM user_totp($1)', [s.userId])).rows[0];
    if (!t?.totp_secret || t.totp_enabled) throw new HttpError(409, 'totp_sin_configurar');
    const step = verifyTotp(decryptSecret(t.totp_secret), code);
    if (step === null) throw new HttpError(422, 'totp_invalido', 'Código inválido');
    lastStep.set(s.userId, step);
    const codes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex'));
    const c = await db.adminRw.connect();
    try {
      await c.query('BEGIN'); await c.query('UPDATE users SET totp_enabled=true WHERE id=$1', [s.userId]);
      for (const x of codes) await c.query('INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1,$2)', [s.userId, sha256(x)]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    s.totp = true;
    await audit2(s, 'totp.enabled');
    return { enabled: true, recoveryCodes: codes, note: 'Guárdalos: se muestran una sola vez y sirven una vez cada uno' };
  });

  // ---- catálogo ----
  app.get('/v1/products', { preHandler: auth() }, async req =>
    withTenant(db, S(req).tenantId, async tx => (await tx.query(
      `SELECT p.id::int AS id, p.sku, p.name, p.category, p.price_cents AS "priceCents", p.stock, p.attrs, p.active, c.gtin
         FROM products p LEFT JOIN codes c ON c.product_id=p.id WHERE p.active ORDER BY p.category, p.name`)).rows));

  // ---- etiquetas: cada negocio (su caja / su personal) descarga el PDF con todos sus códigos; el SuperAdmin, el de
  // cualquier negocio o el de todos juntos. Nombres y códigos ya son públicos (catálogo de las webs): no pide desbloqueo.
  const LABEL_TENANTS = `SELECT t.slug, t.name, count(c.gtin)::int AS products,
      coalesce(array_agg(DISTINCT p.category ORDER BY p.category) FILTER (WHERE c.gtin IS NOT NULL), '{}') AS categories
    FROM tenants t LEFT JOIN products p ON p.tenant_id = t.id AND p.active LEFT JOIN codes c ON c.product_id = p.id AND c.retired_at IS NULL
    WHERE $1::smallint IS NULL OR t.id = $1 GROUP BY t.id, t.slug, t.name ORDER BY t.name`;
  app.get('/v1/labels/tenants', { preHandler: auth('superadmin', 'operador_pos') }, async req => {
    const s = S(req);
    return s.role === 'superadmin' ? (await db.admin.query(LABEL_TENANTS, [null])).rows
      : (await withTenant(db, s.tenantId, tx => tx.query(LABEL_TENANTS, [s.tenantId]))).rows;
  });
  app.get('/v1/labels.pdf', { preHandler: auth('superadmin', 'operador_pos') }, async (req, reply) => {
    const s = S(req);
    limit(reply, `labels:${s.userId}`, 10, 60_000); // generar el PDF cuesta CPU
    const q = labelsQuery.parse(req.query);
    let r: Awaited<ReturnType<typeof buildLabels>>; let tenantId: number | null = s.tenantId;
    if (q.tenant && s.role === 'superadmin') {
      const all = (await db.admin.query('SELECT id::int AS id, slug, name FROM tenants ORDER BY name')).rows;
      const ts = q.tenant === '*' ? all : all.filter(t => t.slug === q.tenant);
      if (!ts.length) throw new HttpError(404, 'negocio_no_existe', 'Ese negocio no existe');
      r = await buildLabels((sql, params) => db.admin.query(sql, params), ts, q);
      tenantId = ts.length === 1 ? ts[0].id : null;
    } else {
      r = await withTenant(db, s.tenantId, async tx => {
        const t = (await tx.query('SELECT id::int AS id, slug, name FROM tenants WHERE id=$1', [s.tenantId])).rows[0];
        if (!t) throw new HttpError(404, 'negocio_no_existe', 'Esta cuenta no tiene negocio');
        if (q.tenant && q.tenant !== t.slug) throw new HttpError(403, 'solo_tu_negocio', 'Solo puedes descargar las etiquetas de tu negocio');
        return buildLabels((sql, params) => tx.query(sql, params), [t], q);
      });
    }
    await db.adminRw.query('INSERT INTO audit_log (tenant_id,user_id,action,after) VALUES ($1,$2,$3,$4)',
      [tenantId, s.userId, 'labels.pdf', JSON.stringify({ products: r.products, labels: r.labels, ...q })]);
    return sendLabels(reply, r);
  });

  app.post('/v1/products', { preHandler: adminOnly }, async (req, reply) => {
    const b = productIn.parse(req.body); const s = S(req);
    try {
      const r = await withTenant(db, s.tenantId, async tx => {
        const p = (await tx.query('INSERT INTO products (tenant_id,sku,name,category,price_cents,stock,attrs) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
          [s.tenantId, b.sku, b.name, b.category, b.priceCents, b.stock, b.attrs])).rows[0];
        const gtin = await issueProductCode(tx, s.tenantId, p.id);
        await audit(tx, s.tenantId, s.userId, 'product.created', null, { id: p.id, sku: b.sku, gtin });
        return { id: Number(p.id), gtin };
      });
      return reply.status(201).send(r);
    } catch (e: any) { if (e.code === '23505') throw new HttpError(409, 'sku_duplicado', `El SKU ${b.sku} ya existe`); throw e; }
  });

  app.post('/v1/products/import', { preHandler: adminOnly }, async (req, reply) => {
    const s = S(req);
    const rows = parseCsv(String(req.body ?? ''));
    const header = rows.shift()?.map(h => h.trim());
    if (!header) throw new HttpError(422, 'csv_vacio');
    const errors: { row: number; error: string }[] = []; const parsed: z.infer<typeof productIn>[] = []; const seen = new Set<string>();
    rows.forEach((r, i) => {
      const o: any = Object.fromEntries(header.map((h, j) => [h, r[j]]));
      try {
        const p = productIn.parse({ sku: o.sku, name: o.name, category: o.category, priceCents: Number(o.price_cents), stock: o.stock ? Number(o.stock) : 0, attrs: o.attrs ? JSON.parse(o.attrs) : {} });
        if (seen.has(p.sku)) throw new Error('SKU repetido en el archivo'); seen.add(p.sku); parsed.push(p);
      } catch (e: any) { errors.push({ row: i + 2, error: e instanceof z.ZodError ? e.issues.map(x => `${x.path.join('.')}: ${x.message}`).join('; ') : e.message }); }
    });
    if (errors.length) return reply.status(422).send({ error: 'import_invalido', errors });
    try {
      const out = await withTenant(db, s.tenantId, async tx => {
        const res = [];
        for (const b of parsed) {
          const p = (await tx.query('INSERT INTO products (tenant_id,sku,name,category,price_cents,stock,attrs) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [s.tenantId, b.sku, b.name, b.category, b.priceCents, b.stock, b.attrs])).rows[0];
          res.push({ sku: b.sku, gtin: await issueProductCode(tx, s.tenantId, p.id) });
        }
        await audit(tx, s.tenantId, s.userId, 'product.import', null, { count: res.length });
        return res;
      });
      return reply.status(201).send({ imported: out.length, items: out });
    } catch (e: any) {
      if (e.code === '23505') return reply.status(422).send({ error: 'import_invalido', errors: [{ row: 0, error: 'SKU ya existente en el catálogo' }] });
      throw e;
    }
  });

  // ---- SVG (público, con límite de tasa) ----
  app.get('/v1/codes/:file', async (req, reply) => {
    limit(reply, `svg:${req.ip}`, 300, 60_000);
    const { file } = req.params as { file: string };
    const m = /^(\d{13})\.svg$/.exec(file);
    if (!m || !isValidGtin13(m[1])) throw new HttpError(422, 'gtin_invalido');
    const kind = (req.query as any).kind === 'qr' ? 'qr' : 'ean13';
    // Público e inmutable: las webs de los negocios lo muestran en <img> o lo descargan (CORS abierto, sin credenciales).
    return reply.header('Content-Type', 'image/svg+xml').header('Cache-Control', 'public, max-age=31536000, immutable').header('Access-Control-Allow-Origin', '*').send(gtinSvg(m[1], kind));
  });

  // ---- resolver público (con límite de tasa) ----
  app.get('/01/:gtin14', async (req, reply) => {
    limit(reply, `resolve:${req.ip}`, 120, 60_000);
    const { gtin14 } = req.params as { gtin14: string };
    const g13 = /^0\d{13}$/.test(gtin14) ? gtin14.slice(1) : '';
    const html = (status: number, body: string) => reply.status(status).header('Content-Security-Policy', PAGE_CSP).type('text/html').send(body);
    const notFound = () => html(404, page('Código no encontrado', '<p>Este código no existe o fue retirado.</p>'));
    if (!isValidGtin13(g13)) return notFound();
    const r = (await publicQuery(db, 'SELECT * FROM resolve_gtin($1)', [g13])).rows[0];
    if (!r || r.retired) return notFound();
    const tpl: string | null = r.kind === 'product' ? r.product_url_tpl : r.build_url_tpl;
    let target: string | null = null;
    if (tpl && r.link_status !== 'down') {
      try {
        const u = new URL(tpl.replace('{sku}', encodeURIComponent(r.sku ?? '')).replace('{gtin}', g13));
        const host = new URL(tpl.replace('{sku}', 'x').replace('{gtin}', 'x')).hostname;
        if (/^https?:$/.test(u.protocol) && host === u.hostname && (r.allowed_domains as string[]).includes(host)) target = u.toString();
      } catch { /* plantilla inválida → ficha */ }
    }
    if (target) return reply.redirect(target, 302);
    let bom = '';
    if (r.kind === 'build') {
      const rows = (await publicQuery(db, 'SELECT * FROM resolve_build_bom($1)', [r.build_id])).rows;
      bom = `<h2>Contenido</h2><ol>${rows.map(x => `<li>${esc(x.name)} × ${x.qty} — ${money(x.unit_price_cents)}</li>`).join('')}</ol>`;
    }
    return html(200, page(r.name, `<p>Precio: <strong>${money(r.price_cents)}</strong></p>${bom}<p><small>Ficha de respaldo: la página del vendedor no está disponible.</small></p>`));
  });

  app.get('/v1/allowed-domains', async (req, reply) => { limit(reply, `pub:${req.ip}`, 120, 60_000); return { domains: (await publicQuery(db, 'SELECT allowed_domains_all() AS d')).rows[0].d }; });

  // ---- escaneo ----
  const buildLabel = async (tx: Tx, buildId: number) => (await tx.query(
    `SELECT b.total_cents, coalesce(b.label, cf.definition->>'itemLabel', 'Ensamble') AS label FROM builds b LEFT JOIN configurators cf ON cf.id=b.configurator_id WHERE b.id=$1`, [buildId])).rows[0] as { total_cents: number; label: string };

  app.get('/v1/scan/:gtin', { preHandler: auth() }, async req => {
    const { gtin } = req.params as { gtin: string };
    if (!isValidGtin13(gtin)) throw new HttpError(422, 'gtin_invalido');
    const s = S(req);
    const r = await withTenant(db, s.tenantId, async tx => {
      const c = (await tx.query('SELECT * FROM codes WHERE gtin=$1', [gtin])).rows[0];
      if (!c || c.retired_at) return null;
      if (c.kind === 'product') {
        const p = (await tx.query('SELECT name, price_cents, sku FROM products WHERE id=$1', [c.product_id])).rows[0];
        return { gtin, kind: 'product', name: p.name, sku: p.sku, priceCents: p.price_cents };
      }
      const b = await buildLabel(tx, c.build_id);
      const bom = (await tx.query(`SELECT p.name, p.sku, bi.qty, bi.unit_price_cents AS "frozenCents", p.price_cents AS "currentCents"
        FROM build_items bi JOIN products p ON p.id=bi.product_id JOIN builds b ON b.id=bi.build_id LEFT JOIN configurators cf ON cf.id=b.configurator_id
        WHERE bi.build_id=$1 ORDER BY group_order(cf.definition, p.category), p.name`, [c.build_id])).rows;
      return { gtin, kind: 'build', name: `${b.label} ${gtin}`, priceCents: b.total_cents, totalCents: b.total_cents, bom };
    });
    if (!r) throw new HttpError(404, 'no_encontrado', 'GTIN no existe en esta empresa');
    return r;
  });

  app.post('/v1/scan-events', { preHandler: auth() }, async (req, reply) => {
    const b = z.object({ events: z.array(z.object({ mode: z.string(), engine: z.string(), device: z.string().max(80).optional(), support: z.string().max(80).optional(), decodeMs: z.number().optional(), totalMs: z.number().optional(), result: z.string(), gtin: z.string().optional() })).max(200) }).parse(req.body);
    const s = S(req);
    await withTenant(db, s.tenantId, async tx => {
      for (const e of b.events) await tx.query('INSERT INTO scan_events (tenant_id,mode,engine,device,support,decode_ms,total_ms,result,gtin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [s.tenantId, e.mode, e.engine, e.device ?? null, e.support ?? null, e.decodeMs ?? null, e.totalMs ?? null, e.result, e.gtin ?? null]);
    });
    return reply.status(201).send({ stored: b.events.length });
  });

  // ---- ventas ----
  app.post('/v1/sales', { preHandler: auth() }, async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8) throw new HttpError(400, 'idempotency_key', 'Idempotency-Key obligatorio');
    const b = z.object({ items: z.array(z.object({ gtin: z.string(), qty: z.number().int().min(1).max(999) })).min(1), paymentMethod: z.enum(['efectivo', 'tarjeta_externa']).default('efectivo') }).parse(req.body);
    const s = S(req);
    const load = async (tx: Tx) => {
      const sale = (await tx.query('SELECT * FROM sales WHERE idempotency_key=$1', [key])).rows[0];
      if (!sale) return null;
      const items = (await tx.query('SELECT gtin, name, qty, unit_price_cents AS "unitPriceCents" FROM sale_items WHERE sale_id=$1 ORDER BY id', [sale.id])).rows;
      return { id: Number(sale.id), totalCents: sale.total_cents, taxCents: sale.tax_cents, items };
    };
    try {
      const { sale, created } = await withTenant(db, s.tenantId, async tx => {
        const prev = await load(tx);
        if (prev) return { sale: prev, created: false };
        const lines: { gtin: string; name: string; qty: number; price: number }[] = [];
        const stockNeeds = new Map<number, number>(); const missing: unknown[] = [];
        for (const it of b.items) {
          if (!isValidGtin13(it.gtin)) throw new HttpError(422, 'gtin_invalido', `GTIN inválido: ${it.gtin}`);
          const c = (await tx.query('SELECT * FROM codes WHERE gtin=$1 AND retired_at IS NULL', [it.gtin])).rows[0];
          if (!c) throw new HttpError(422, 'gtin_ajeno', `El GTIN ${it.gtin} no pertenece a esta empresa`);
          if (c.kind === 'product') {
            const p = (await tx.query('SELECT id,name,price_cents FROM products WHERE id=$1', [c.product_id])).rows[0];
            lines.push({ gtin: it.gtin, name: p.name, qty: it.qty, price: p.price_cents });
            stockNeeds.set(Number(p.id), (stockNeeds.get(Number(p.id)) ?? 0) + it.qty);
          } else {
            const bld = await buildLabel(tx, c.build_id);
            lines.push({ gtin: it.gtin, name: `${bld.label} ${it.gtin}`, qty: it.qty, price: bld.total_cents });
            for (const bi of (await tx.query('SELECT product_id, qty FROM build_items WHERE build_id=$1', [c.build_id])).rows)
              stockNeeds.set(Number(bi.product_id), (stockNeeds.get(Number(bi.product_id)) ?? 0) + bi.qty * it.qty);
          }
        }
        for (const [pid, need] of [...stockNeeds].sort((a, b) => a[0] - b[0])) {
          const u = await tx.query('UPDATE products SET stock = stock - $2 WHERE id=$1 AND stock >= $2 RETURNING id', [pid, need]);
          if (!u.rowCount) { const p = (await tx.query('SELECT name, stock FROM products WHERE id=$1', [pid])).rows[0]; missing.push({ productId: pid, name: p.name, stock: p.stock, needed: need }); }
        }
        if (missing.length) throw new HttpError(409, 'sin_stock', 'Stock insuficiente', missing);
        const total = lines.reduce((a, l) => a + l.qty * l.price, 0);
        const tax = Math.round(total * 16 / 116); // precios con IVA incluido
        const sale = (await tx.query('INSERT INTO sales (tenant_id,idempotency_key,total_cents,tax_cents,payment_method,user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [s.tenantId, key, total, tax, b.paymentMethod, s.userId])).rows[0];
        for (const l of lines) await tx.query('INSERT INTO sale_items (sale_id,tenant_id,gtin,name,qty,unit_price_cents) VALUES ($1,$2,$3,$4,$5,$6)', [sale.id, s.tenantId, l.gtin, l.name, l.qty, l.price]);
        return { sale: { id: Number(sale.id), totalCents: total, taxCents: tax, items: lines.map(l => ({ gtin: l.gtin, name: l.name, qty: l.qty, unitPriceCents: l.price })) }, created: true };
      });
      return reply.status(created ? 201 : 200).send({ ...sale, replayed: !created });
    } catch (e: any) {
      if (e.code === '23505') { const prev = await withTenant(db, s.tenantId, load); if (prev) return reply.status(200).send({ ...prev, replayed: true }); }
      throw e;
    }
  });

  registerBuilds(app, db, { staff: auth(), anyUser, limit });
  registerWeb(app, db, { limit });
  registerAdmin(app, db, { timers: opts.timers !== false && opts.logRequests !== false });

  // ---- PWA estática ----
  const dir = opts.staticDir ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (fs.existsSync(dir)) {
    await app.register(fstatic, { root: dir });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/v1/') && !req.url.startsWith('/01/')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: 'not_found' });
    });
  }
  return app;
}

const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font:16px/1.5 system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#121316;background:#F8F9FA"><h1 style="font-family:Georgia,serif;font-weight:400">${esc(title)}</h1>${body}</body>`;

export { parseDigitalLink };
