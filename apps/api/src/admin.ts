// Consola de administración (F3): tenants, usuarios, llaves, visor de BD, depurador, métricas, alertas, SSE.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import { z } from 'zod';
import { HttpError } from './errors';
import { withTenant, type Db } from './db';
import { sha256 } from './totp';
import { parseDefinition } from './builds';
import { ADMIN_UNLOCK_MS, type Session } from './session';
import { registerCatalogAdmin } from './catalog';
import { registerAccessAdmin } from './acceso';
import { syncNow, syncState } from './sync';

export type { Session };

// ---- lista blanca del visor: vistas y columnas filtrables. Nunca SQL libre. ----
export const VIEWS: Record<string, string[]> = {
  v_products: ['id', 'tenant_id', 'sku', 'name', 'category', 'price_cents', 'stock', 'active', 'origin'],
  v_codes: ['gtin', 'tenant_id', 'kind', 'product_id', 'build_id', 'issued_at', 'retired_at'],
  v_builds: ['id', 'tenant_id', 'total_cents', 'active', 'created_at'],
  v_sales: ['id', 'tenant_id', 'total_cents', 'tax_cents', 'payment_method', 'created_at'],
  v_scan_events: ['id', 'tenant_id', 'mode', 'engine', 'device', 'decode_ms', 'total_ms', 'result', 'created_at'],
};

const SENSITIVE_HEADERS = /^(authorization|cookie|set-cookie|idempotency-key|x-api-key|proxy-authorization)$/i;
const SENSITIVE_PARAM = /(password|token|secret|key|code)/i;
export function redactHeaders(h: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, SENSITIVE_HEADERS.test(k) || /password|token|secret/i.test(k) ? '[REDACTED]' : v]));
}
export function redactQuery(qs: string): string {
  if (!qs) return '';
  const p = new URLSearchParams(qs);
  for (const k of [...p.keys()]) if (SENSITIVE_PARAM.test(k)) p.set(k, '[REDACTED]');
  return p.toString();
}
export function toCurl(r: { method: string; url: string; query?: string; headers?: Record<string, unknown> }, base = 'http://localhost:3000'): string {
  const hs = Object.entries(r.headers ?? {}).filter(([k, v]) => !SENSITIVE_HEADERS.test(k) && v !== '[REDACTED]' && !['host', 'content-length', 'connection'].includes(k.toLowerCase()));
  const h = hs.map(([k, v]) => `-H '${k}: ${String(v).replace(/'/g, '')}'`).join(' ');
  return `curl -X ${r.method} ${h} '${base}${r.url}${r.query ? '?' + r.query : ''}'`.replace(/\s+/g, ' ');
}

// ---- monitor de enlaces ----
const failures = new Map<number, number>();
export async function checkLink(db: Db, tenantId: number, userId: number | null = null) {
  const t = (await db.admin.query('SELECT id, slug, product_url_tpl, link_status FROM tenants WHERE id=$1', [tenantId])).rows[0];
  if (!t) throw new HttpError(404, 'tenant_no_existe');
  const sku = (await db.admin.query('SELECT sku FROM products WHERE tenant_id=$1 AND active ORDER BY id LIMIT 1', [tenantId])).rows[0]?.sku ?? 'MUESTRA';
  let url = t.product_url_tpl.replace('{sku}', encodeURIComponent(sku));
  const host = new URL(url).hostname;
  let outcome: 'ok' | 'degraded' | 'fail' = 'fail'; let attempts = 0; const t0 = Date.now();
  for (; attempts < 3 && outcome === 'fail'; attempts++) {
    for (const method of ['HEAD', 'GET']) {
      try {
        let cur = url;
        for (let hop = 0; hop < 3; hop++) {
          const r = await fetch(cur, { method, redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'ForgexLinkMonitor/1.0 (+codigos)' } });
          if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
            const next = new URL(r.headers.get('location')!, cur);
            if (next.hostname !== host) throw new Error('redirección a otro dominio'); // solo mismo dominio
            cur = next.toString(); continue;
          }
          if (r.status < 400) outcome = 'ok'; else if (r.status >= 500 || method === 'GET') throw new Error('5xx'); else continue;
          break;
        }
        if (outcome === 'ok') break;
      } catch { /* siguiente método / reintento */ }
    }
  }
  const elapsed = Date.now() - t0;
  let status: string;
  if (outcome === 'ok') { failures.set(tenantId, 0); status = attempts > 1 || elapsed > 2000 ? 'degraded' : 'ok'; }
  else { const n = (failures.get(tenantId) ?? 0) + 1; failures.set(tenantId, n); status = n >= 3 ? 'down' : 'degraded'; }
  if (status !== t.link_status) {
    await db.adminRw.query('UPDATE tenants SET link_status=$2 WHERE id=$1', [tenantId, status]);
    await db.adminRw.query('INSERT INTO audit_log (tenant_id,user_id,action,before,after) VALUES ($1,$2,$3,$4,$5)', [tenantId, userId, 'link.status', JSON.stringify({ status: t.link_status }), JSON.stringify({ status })]);
  }
  return { tenantId, status, attempts, elapsedMs: elapsed };
}

// ---- tiempo real ----
class Hub {
  subs = new Map<number, Set<{ write(s: string): void; end(): void }>>();
  client: pg.Client | null = null;
  async start(url: string) {
    if (this.client) return;
    const c = new pg.Client({ connectionString: url });
    this.client = c; await c.connect(); await c.query('LISTEN events');
    c.on('notification', m => this.broadcast(m.payload ?? ''));
    // Si la base corta la conexión, se cierran los flujos: el navegador reconecta (retry) y se vuelve a escuchar.
    c.on('error', () => { if (this.client === c) this.client = null; for (const s of this.subs.values()) for (const w of s) w.end(); this.subs.clear(); });
  }
  broadcast(payload: string) { for (const set of this.subs.values()) for (const w of set) w.write(`data: ${payload}\n\n`); }
  count(uid: number) { return this.subs.get(uid)?.size ?? 0; }
  async stop() { for (const s of this.subs.values()) for (const w of s) w.end(); this.subs.clear(); await this.client?.end().catch(() => {}); this.client = null; }
}

export function registerAdmin(app: FastifyInstance, db: Db, opts: { timers: boolean }) {
  const S = (req: FastifyRequest) => (req as any).session as Session | undefined;
  const admin = async (req: FastifyRequest) => {
    const s = S(req);
    if (!s) throw new HttpError(401, 'unauthenticated');
    if (s.role !== 'superadmin') throw new HttpError(403, 'forbidden');
    if (!s.totp) throw new HttpError(403, 'totp_required', 'El SuperAdmin debe activar el segundo factor (TOTP)');
    if ((s.adminUntil ?? 0) < Date.now()) throw new HttpError(403, 'admin_locked', 'Confirma tu contraseña para usar las funciones de administrador');
    s.adminUntil = Date.now() + ADMIN_UNLOCK_MS; // se renueva con el uso
  };
  const audit = (s: Session, tenantId: number | null, action: string, before: unknown, after: unknown) =>
    db.adminRw.query('INSERT INTO audit_log (tenant_id,user_id,action,before,after) VALUES ($1,$2,$3,$4,$5)', [tenantId, s.userId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);

  const tplOk = (tpl: string, domains: string[]) => {
    let u: URL; try { u = new URL(tpl.replace('{sku}', 'x').replace('{gtin}', 'x')); } catch { throw new HttpError(422, 'plantilla_invalida', 'La plantilla no es una URL válida'); }
    if (!/^https?:$/.test(u.protocol)) throw new HttpError(422, 'plantilla_invalida', 'Solo http(s)');
    if (!domains.includes(u.hostname)) throw new HttpError(422, 'dominio_no_registrado', `El host ${u.hostname} no está en los dominios del tenant`);
  };

  // ----- tenants -----
  const tenantCols = 'id, slug, name, gs1_prefix, company_prefix, product_url_tpl, build_url_tpl, allowed_domains, link_status, rules';
  app.get('/v1/admin/tenants', { preHandler: admin }, async () => (await db.admin.query(`SELECT ${tenantCols} FROM tenants ORDER BY id`)).rows);
  app.post('/v1/admin/tenants', { preHandler: admin }, async (req, reply) => {
    const b = z.object({ slug: z.string().regex(/^[a-z0-9-]{2,40}$/), name: z.string().min(1), companyPrefix: z.string().regex(/^\d{4}$/), gs1Prefix: z.string().regex(/^\d{3}$/).default('750'), productUrlTpl: z.string(), buildUrlTpl: z.string().optional(), allowedDomains: z.array(z.string()).min(1) }).parse(req.body);
    tplOk(b.productUrlTpl, b.allowedDomains); if (b.buildUrlTpl) tplOk(b.buildUrlTpl, b.allowedDomains);
    try {
      const t = (await db.adminRw.query(`INSERT INTO tenants (slug,name,gs1_prefix,company_prefix,product_url_tpl,build_url_tpl,allowed_domains) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${tenantCols}`,
        [b.slug, b.name, b.gs1Prefix, b.companyPrefix, b.productUrlTpl, b.buildUrlTpl ?? null, b.allowedDomains])).rows[0];
      await db.adminRw.query('INSERT INTO code_counters (tenant_id) VALUES ($1)', [t.id]);
      await audit(S(req)!, t.id, 'tenant.created', null, t);
      return reply.status(201).send(t);
    } catch (e: any) { if (e.code === '23505') throw new HttpError(409, 'duplicado', 'Slug o prefijo de empresa ya existe'); throw e; }
  });
  app.patch('/v1/admin/tenants/:id', { preHandler: admin }, async req => {
    const id = Number((req.params as any).id);
    const b = z.object({ name: z.string().min(1).optional(), productUrlTpl: z.string().optional(), buildUrlTpl: z.string().nullable().optional(), allowedDomains: z.array(z.string()).min(1).optional(), rules: z.object({ powerFactor: z.number().min(1).max(3) }).optional() }).parse(req.body);
    const before = (await db.admin.query(`SELECT ${tenantCols} FROM tenants WHERE id=$1`, [id])).rows[0];
    if (!before) throw new HttpError(404, 'tenant_no_existe');
    const doms = b.allowedDomains ?? before.allowed_domains;
    const p = b.productUrlTpl ?? before.product_url_tpl; tplOk(p, doms);
    const bu = b.buildUrlTpl === undefined ? before.build_url_tpl : b.buildUrlTpl; if (bu) tplOk(bu, doms);
    const after = (await db.adminRw.query(`UPDATE tenants SET name=$2, product_url_tpl=$3, build_url_tpl=$4, allowed_domains=$5, rules=$6 WHERE id=$1 RETURNING ${tenantCols}`,
      [id, b.name ?? before.name, p, bu, doms, b.rules ?? before.rules])).rows[0];
    await audit(S(req)!, id, 'tenant.updated', before, after);
    return after;
  });
  app.post('/v1/admin/preview-link', { preHandler: admin }, async req => {
    const b = z.object({ template: z.string(), sku: z.string().default('MUESTRA-1') }).parse(req.body);
    return { url: b.template.replace('{sku}', encodeURIComponent(b.sku)).replace('{gtin}', '7500002000891') };
  });
  app.post('/v1/tenants/:id/check-link', { preHandler: admin }, async req => checkLink(db, Number((req.params as any).id), S(req)!.userId));

  // ----- usuarios y membresías -----
  app.get('/v1/admin/users', { preHandler: admin }, async () =>
    (await db.admin.query('SELECT u.id, u.email, u.totp_enabled, m.tenant_id, m.role FROM users u LEFT JOIN memberships m ON m.user_id=u.id ORDER BY u.id, m.tenant_id')).rows);
  app.post('/v1/admin/users', { preHandler: admin }, async (req, reply) => {
    const b = z.object({ email: z.string().email(), password: z.string().min(12), tenantId: z.number().int(), role: z.enum(['superadmin', 'operador_pos']) }).parse(req.body);
    const hash = await argon2.hash(b.password, { type: argon2.argon2id });
    const c = await db.adminRw.connect();
    try {
      await c.query('BEGIN');
      let u = (await c.query('SELECT id FROM users WHERE email=$1', [b.email.toLowerCase()])).rows[0];
      if (!u) u = (await c.query('INSERT INTO users (email,password_hash) VALUES ($1,$2) RETURNING id', [b.email.toLowerCase(), hash])).rows[0];
      await c.query('INSERT INTO memberships (user_id,tenant_id,role) VALUES ($1,$2,$3) ON CONFLICT (user_id,tenant_id) DO UPDATE SET role=EXCLUDED.role', [u.id, b.tenantId, b.role]);
      await c.query('COMMIT');
      await audit(S(req)!, b.tenantId, 'user.membership', null, { userId: Number(u.id), email: b.email, role: b.role });
      return reply.status(201).send({ id: Number(u.id) });
    } catch (e: any) { await c.query('ROLLBACK'); if (e.code === '23503') throw new HttpError(422, 'tenant_no_existe'); throw e; } finally { c.release(); }
  });

  // ----- llaves de integración -----
  app.get('/v1/admin/keys', { preHandler: admin }, async () => (await db.admin.query('SELECT id, tenant_id, prefix, scope, active, created_at FROM api_keys ORDER BY id')).rows);
  app.post('/v1/admin/keys', { preHandler: admin }, async (req, reply) => {
    const { tenantId } = z.object({ tenantId: z.number().int() }).parse(req.body);
    const prefix = crypto.randomBytes(4).toString('hex'); const secret = crypto.randomBytes(24).toString('base64url');
    const key = `fk_${prefix}_${secret}`;
    try {
      const r = (await db.adminRw.query('INSERT INTO api_keys (tenant_id,prefix,key_hash) VALUES ($1,$2,$3) RETURNING id', [tenantId, prefix, sha256(key)])).rows[0];
      await audit(S(req)!, tenantId, 'key.created', null, { id: Number(r.id), prefix }); // nunca se guarda ni registra la llave
      return reply.status(201).send({ id: Number(r.id), prefix, key, note: 'Se muestra una sola vez' });
    } catch (e: any) { if (e.code === '23503') throw new HttpError(422, 'tenant_no_existe'); throw e; }
  });
  app.post('/v1/admin/keys/:id/deactivate', { preHandler: admin }, async req => {
    const id = Number((req.params as any).id);
    const r = await db.adminRw.query('UPDATE api_keys SET active=false WHERE id=$1 AND active RETURNING tenant_id, prefix', [id]);
    if (!r.rowCount) throw new HttpError(404, 'llave_no_existe_o_inactiva');
    await audit(S(req)!, r.rows[0].tenant_id, 'key.deactivated', { id, active: true }, { id, active: false });
    return { ok: true };
  });

  // ----- productos de todas las webs y hoja de etiquetas en PDF -----
  registerCatalogAdmin(app, db, { admin, audit });
  registerAccessAdmin(app, db, { admin, audit });

  // ----- catálogo de las webs desde GitHub (también corre solo; esto lo fuerza) -----
  app.get('/v1/admin/sync', { preHandler: admin }, async () => syncState);
  app.post('/v1/admin/sync', { preHandler: admin }, async req => {
    const last = await syncNow(db.adminRw, { force: true });
    await audit(S(req)!, null, 'catalog.sync', null, last);
    return { ...syncState, last };
  });

  // ----- configuradores: las reglas son datos y se editan sin desplegar -----
  const cfgCols = 'c.id::int AS id, c.tenant_id, t.slug AS tenant_slug, t.name AS tenant_name, c.slug, c.name, c.description, c.definition, c.active';
  app.get('/v1/admin/configurators', { preHandler: admin }, async () =>
    (await db.admin.query(`SELECT ${cfgCols} FROM configurators c JOIN tenants t ON t.id=c.tenant_id ORDER BY c.tenant_id, c.id`)).rows);
  app.post('/v1/admin/configurators', { preHandler: admin }, async (req, reply) => {
    const b = z.object({ tenantId: z.number().int(), slug: z.string().regex(/^[a-z0-9-]{2,40}$/), name: z.string().min(1).max(80), description: z.string().max(200).default(''), definition: z.unknown() }).parse(req.body);
    const def = parseDefinition(b.definition);
    try {
      const r = (await db.adminRw.query('INSERT INTO configurators (tenant_id,slug,name,description,definition) VALUES ($1,$2,$3,$4,$5) RETURNING id', [b.tenantId, b.slug, b.name, b.description, JSON.stringify(def)])).rows[0];
      await audit(S(req)!, b.tenantId, 'configurator.created', null, { id: Number(r.id), slug: b.slug, definition: def });
      return reply.status(201).send({ id: Number(r.id) });
    } catch (e: any) {
      if (e.code === '23505') throw new HttpError(409, 'duplicado', 'Ese negocio ya tiene un configurador con ese identificador');
      if (e.code === '23503') throw new HttpError(422, 'tenant_no_existe');
      throw e;
    }
  });
  app.patch('/v1/admin/configurators/:id', { preHandler: admin }, async req => {
    const id = Number((req.params as any).id);
    const b = z.object({ name: z.string().min(1).max(80).optional(), description: z.string().max(200).optional(), active: z.boolean().optional(), definition: z.unknown().optional() }).parse(req.body);
    const before = (await db.admin.query('SELECT tenant_id, name, description, active, definition FROM configurators WHERE id=$1', [id])).rows[0];
    if (!before) throw new HttpError(404, 'configurador_no_existe');
    const def = b.definition === undefined ? before.definition : parseDefinition(b.definition);
    const after = (await db.adminRw.query('UPDATE configurators SET name=$2, description=$3, active=$4, definition=$5 WHERE id=$1 RETURNING tenant_id, name, description, active, definition',
      [id, b.name ?? before.name, b.description ?? before.description, b.active ?? before.active, JSON.stringify(def)])).rows[0];
    await audit(S(req)!, before.tenant_id, 'configurator.updated', before, after);
    return { id, ...after };
  });

  // ----- visor de base de datos (lista blanca) -----
  app.get('/v1/admin/db/:view', { preHandler: admin }, async req => {
    const { view } = req.params as { view: string };
    const cols = VIEWS[view];
    if (!cols) throw new HttpError(422, 'vista_no_permitida', `Vistas permitidas: ${Object.keys(VIEWS).join(', ')}`);
    const q = req.query as Record<string, string>;
    const where: string[] = []; const params: unknown[] = [];
    for (const [k, v] of Object.entries(q)) {
      if (k === 'page') continue;
      if (!cols.includes(k)) throw new HttpError(422, 'columna_no_permitida', `Columna no permitida: ${k}`);
      params.push(v); where.push(`"${k}"::text = $${params.length}`); // nombre validado contra la lista; valor parametrizado
    }
    const page = Math.max(0, Number(q.page ?? 0) | 0);
    const c = await db.admin.connect();
    try {
      await c.query('BEGIN READ ONLY'); await c.query("SET LOCAL statement_timeout = '2s'");
      const rows = (await c.query(`SELECT ${cols.map(x => `"${x}"`).join(',')} FROM ${view} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY 1 LIMIT 500 OFFSET ${page * 500}`, params)).rows;
      await c.query('COMMIT'); return { view, columns: cols, page, rows };
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  });

  // ----- depurador -----
  app.get('/v1/admin/requests', { preHandler: admin }, async req => {
    const q = req.query as any; const params: unknown[] = []; const w: string[] = [];
    if (q.requestId) { params.push(q.requestId); w.push(`request_id=$${params.length}`); }
    if (q.status) { params.push(Number(q.status)); w.push(`status=$${params.length}`); }
    return (await db.admin.query(`SELECT id, request_id, method, route, tenant_id, status, duration_ms, created_at FROM http_log ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`, params)).rows;
  });
  app.get('/v1/admin/requests/:rid', { preHandler: admin }, async req => {
    const r = (await db.admin.query('SELECT * FROM http_log WHERE request_id=$1', [(req.params as any).rid])).rows[0];
    if (!r) throw new HttpError(404, 'no_encontrada');
    return { ...r, curl: toCurl({ method: r.method, url: r.url ?? r.route, query: r.query, headers: r.headers }) };
  });

  // ----- métricas y alertas -----
  app.get('/v1/admin/metrics', { preHandler: admin }, async () => {
    const q = async (sql: string) => (await db.admin.query(sql)).rows;
    return {
      latency: await q('SELECT * FROM v_latency_p95'), resolution: await q('SELECT * FROM v_resolution_rate ORDER BY tenant_id'),
      buildP95: (await q('SELECT * FROM v_build_p95'))[0], errors15m: (await q('SELECT * FROM v_error_rate_15m'))[0],
      links: await q('SELECT * FROM v_link_health ORDER BY tenant_id'), salesByBox: await q('SELECT * FROM v_sales_by_box ORDER BY day DESC, tenant_id LIMIT 90'),
    };
  });
  app.get('/v1/admin/alerts', { preHandler: admin }, async () => (await db.admin.query('SELECT * FROM alerts ORDER BY id DESC LIMIT 100')).rows);
  app.post('/v1/admin/alerts/evaluate', { preHandler: admin }, async () => { await db.app.query('SELECT evaluate_alerts()'); return (await db.admin.query('SELECT * FROM alerts WHERE active')).rows; });
  // El operador POS ve solo su caja
  app.get('/v1/box/metrics', async req => {
    const s = S(req); if (!s || s.role === 'integration') throw new HttpError(401, 'unauthenticated');
    if (s.role === 'cliente') throw new HttpError(403, 'forbidden');
    return withTenant(db, s.tenantId, async tx => ({
      salesToday: (await tx.query("SELECT count(*)::int AS n, coalesce(sum(total_cents),0)::bigint AS total_cents FROM sales WHERE created_at::date = now()::date")).rows[0],
      scans: (await tx.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE result='resolved')::int AS resolved FROM scan_events WHERE created_at > now() - interval '1 day'")).rows[0],
    }));
  });

  // ----- tiempo real (SSE) -----
  const hub = new Hub(); const MAX_CONN = 3;
  app.get('/v1/admin/stream', { preHandler: admin }, async (req, reply) => {
    const s = S(req)!;
    if (hub.count(s.userId) >= MAX_CONN) throw new HttpError(429, 'demasiadas_conexiones');
    await hub.start(db.urls.adminUrl);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Request-Id': req.id });
    res.write('retry: 2000\n: conectado\n\n');
    const w = { write: (x: string) => res.write(x), end: () => res.end() };
    if (!hub.subs.has(s.userId)) hub.subs.set(s.userId, new Set());
    hub.subs.get(s.userId)!.add(w);
    const hb = setInterval(() => res.write(': hb\n\n'), 20000);
    req.raw.on('close', () => { clearInterval(hb); hub.subs.get(s.userId)?.delete(w); });
  });

  // ----- tareas periódicas -----
  const timers: NodeJS.Timeout[] = [];
  if (opts.timers) {
    const every = (ms: number, f: () => Promise<unknown>) => { const t = setInterval(() => f().catch(() => {}), ms); t.unref(); timers.push(t); };
    every(60_000, async () => { await db.app.query('SELECT refresh_metrics()'); await db.app.query('SELECT evaluate_alerts()'); });
    every(6 * 3600_000, async () => { for (const t of (await db.admin.query('SELECT id FROM tenants')).rows) await checkLink(db, t.id); });
    every(24 * 3600_000, () => db.app.query("DELETE FROM http_log WHERE created_at < now() - interval '14 days'"));
    every(3600_000, () => db.app.query('DELETE FROM sessions WHERE expires_at < now()'));
  }
  app.addHook('onClose', async () => { timers.forEach(clearInterval); await hub.stop(); });
}
