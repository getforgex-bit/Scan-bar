// Configuradores genéricos y artículos configurados (sección 5): PC a medida, bebidas, lo que el negocio defina.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { HttpError } from './errors';
import { withTenant, publicQuery, type Db, type Tx } from './db';
import { gtinSvg, digitalLink } from './svg';
import { buildGtin13, isValidGtin13 } from '../../../packages/codes/src/index';
import { evaluate, lintDefinition, type Definition } from '../../../packages/codes/src/rules';
import type { Session } from './session';

const ref = z.object({ group: z.string().min(1).max(40), attr: z.string().min(1).max(40) });
const when = z.object({ group: z.string().min(1).max(40), attr: z.string().min(1).max(40), equals: z.union([z.string(), z.number(), z.boolean()]) });
const ruleId = z.string().regex(/^[a-z0-9_-]{1,40}$/);
const text = z.string().min(1).max(160);
export const definitionSchema = z.object({
  itemLabel: z.string().min(1).max(40),
  groups: z.array(z.object({
    category: z.string().regex(/^[a-z0-9_-]{1,40}$/), label: z.string().min(1).max(60),
    min: z.number().int().min(0).max(20), max: z.number().int().min(1).max(20),
    maxQty: z.number().int().min(1).max(32).optional(), hint: z.string().max(80).optional(),
  })).min(1).max(20),
  rules: z.array(z.discriminatedUnion('type', [
    z.object({ id: ruleId, type: z.literal('equals'), a: ref, b: ref, message: text.optional() }),
    z.object({ id: ruleId, type: z.literal('in'), a: ref, b: ref, message: text.optional() }),
    z.object({ id: ruleId, type: z.literal('sum_lte'), attr: z.string().min(1).max(40), factor: z.number().min(0.1).max(10).optional(), limit: ref, unit: z.string().max(12).optional(), message: text.optional() }),
    z.object({ id: ruleId, type: z.literal('forbid'), when, group: z.string().min(1).max(40), message: text }),
    z.object({ id: ruleId, type: z.literal('require'), when, group: z.string().min(1).max(40), message: text }),
  ])).max(50).default([]),
});
/** Valida forma (Zod) y coherencia (grupos y referencias). 422 con la lista de problemas. */
export function parseDefinition(input: unknown): Definition {
  const d = definitionSchema.parse(input) as Definition;
  const errs = lintDefinition(d);
  if (errs.length) throw new HttpError(422, 'definicion_invalida', errs[0], errs);
  return d;
}

export function bomHash(tenantId: number, lines: { productId: number; qty: number; unitPriceCents: number }[]): string {
  const canonical = [...lines].sort((a, b) => a.productId - b.productId).map(l => `${l.productId}:${l.qty}:${l.unitPriceCents}`).join('|');
  return crypto.createHash('sha256').update(`${tenantId}#${canonical}`).digest('hex');
}

type Cfg = { id: number; slug: string; name: string; description: string; definition: Definition };
async function getConfigurator(tx: Tx, slug?: string): Promise<Cfg> {
  const r = slug
    ? (await tx.query('SELECT id, slug, name, description, definition FROM configurators WHERE slug=$1 AND active', [slug])).rows[0]
    : (await tx.query('SELECT id, slug, name, description, definition FROM configurators WHERE active ORDER BY id LIMIT 1')).rows[0];
  if (!r) throw new HttpError(slug ? 404 : 422, 'sin_configurador', slug ? 'Ese configurador no existe o está inactivo' : 'Esta empresa no tiene un configurador activo');
  return { ...r, id: Number(r.id) };
}

export const buildIn = z.object({
  configurator: z.string().regex(/^[a-z0-9-]{2,40}$/).optional(),
  lines: z.array(z.object({ productId: z.number().int(), qty: z.number().int().min(1).max(32) })).min(1).max(60),
});

/** Guarda (o reutiliza) un artículo configurado dentro de la transacción del llamador. */
export async function saveBuild(tx: Tx, tenantId: number, input: z.infer<typeof buildIn>, userId: number | null) {
  const cfg = await getConfigurator(tx, input.configurator);
  const def = cfg.definition;
  const merged = new Map<number, number>(); for (const l of input.lines) merged.set(l.productId, (merged.get(l.productId) ?? 0) + l.qty);
  const ids = [...merged.keys()];
  const parts = (await tx.query('SELECT id, category, price_cents, attrs, name, sku FROM products WHERE id = ANY($1) AND active FOR SHARE', [ids])).rows;
  if (parts.length !== ids.length) throw new HttpError(422, 'producto_invalido', 'Alguna opción no existe, está inactiva o es de otra empresa');
  const viol = evaluate(def, parts.map(p => ({ id: Number(p.id), category: p.category, attrs: p.attrs, name: p.name, qty: merged.get(Number(p.id)) })));
  if (viol.length) throw new HttpError(422, 'incompatible', viol[0].message, viol);
  const t = (await tx.query('SELECT gs1_prefix, company_prefix FROM tenants WHERE id=$1', [tenantId])).rows[0];
  const bl = parts.map(p => ({ productId: Number(p.id), qty: merged.get(Number(p.id))!, unitPriceCents: p.price_cents as number }));
  const hash = bomHash(tenantId, bl);
  const order = (c: string) => { const i = def.groups.findIndex(g => g.category === c); return i < 0 ? 999 : i; };

  const present = async (buildId: number, reused: boolean) => {
    if (userId) await tx.query('INSERT INTO build_saves (user_id, build_id, tenant_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [userId, buildId, tenantId]);
    const g = (await tx.query('SELECT gtin FROM codes WHERE build_id=$1', [buildId])).rows[0].gtin as string;
    const total = (await tx.query('SELECT total_cents FROM builds WHERE id=$1', [buildId])).rows[0].total_cents as number;
    const bom = (await tx.query(`SELECT p.sku, p.name, p.category, bi.qty, bi.unit_price_cents AS "unitPriceCents" FROM build_items bi JOIN products p ON p.id=bi.product_id WHERE bi.build_id=$1`, [buildId])).rows
      .sort((a, b) => order(a.category) - order(b.category) || a.name.localeCompare(b.name));
    return { gtin: g, label: def.itemLabel, name: `${def.itemLabel} ${g}`, configurator: cfg.slug, digitalLink: digitalLink(g), reused, saved: !!userId, totalCents: total, bom, svg: { ean13: gtinSvg(g, 'ean13'), qr: gtinSvg(g, 'qr') } };
  };

  const ex = (await tx.query('SELECT id FROM builds WHERE tenant_id=$1 AND bom_hash=$2', [tenantId, hash])).rows[0];
  if (ex) return present(Number(ex.id), true);
  const item = (await tx.query('SELECT allocate_item($1::smallint) AS n', [tenantId])).rows[0].n as number;
  const gtin = buildGtin13(t.gs1_prefix, t.company_prefix, item);
  const total = bl.reduce((a, l) => a + l.qty * l.unitPriceCents, 0);
  const b = (await tx.query('INSERT INTO builds (tenant_id,bom_hash,total_cents,configurator_id) VALUES ($1,$2,$3,$4) RETURNING id', [tenantId, hash, total, cfg.id])).rows[0];
  for (const l of bl) await tx.query('INSERT INTO build_items (build_id,product_id,tenant_id,qty,unit_price_cents) VALUES ($1,$2,$3,$4,$5)', [b.id, l.productId, tenantId, l.qty, l.unitPriceCents]);
  await tx.query("INSERT INTO codes (gtin,tenant_id,kind,build_id) VALUES ($1,$2,'build',$3)", [gtin, tenantId, b.id]);
  await tx.query('INSERT INTO audit_log (tenant_id,user_id,action,after) VALUES ($1,$2,$3,$4)', [tenantId, userId, 'build.created', JSON.stringify({ buildId: Number(b.id), gtin, configurator: cfg.slug })]);
  return present(Number(b.id), false);
}

type Guard = (req: FastifyRequest) => Promise<void>;
type Limit = (reply: FastifyReply, key: string, max: number, windowMs: number) => void;

export function registerBuilds(app: FastifyInstance, db: Db, h: { staff: Guard; anyUser: Guard; limit: Limit }) {
  const S = (req: FastifyRequest) => (req as any).session as Session | undefined;
  /** Un solo reintento ante la carrera de dos guardados idénticos (UNIQUE tenant_id, bom_hash). */
  const saveWithRetry = async (tenantId: number, input: z.infer<typeof buildIn>, userId: number | null) => {
    try { return await withTenant(db, tenantId, tx => saveBuild(tx, tenantId, input, userId)); }
    catch (e: any) { if (e.code !== '23505') throw e; return withTenant(db, tenantId, tx => saveBuild(tx, tenantId, input, userId)); }
  };
  const tenantBySlug = async (slug: string) => {
    const t = (await publicQuery(db, 'SELECT * FROM public_tenant($1)', [slug])).rows[0];
    if (!t) throw new HttpError(404, 'negocio_no_existe', 'Ese negocio no existe');
    return t as { id: number; slug: string; name: string };
  };

  // ---- público: sin sesión, con límite de tasa por IP ----
  app.get('/v1/public/tenants', async (req, reply) => {
    h.limit(reply, `pub:${req.ip}`, 120, 60_000);
    const rows = (await publicQuery(db, 'SELECT * FROM public_configurators()')).rows;
    const out: { slug: string; name: string; configurators: { slug: string; name: string; description: string }[] }[] = [];
    for (const r of rows) {
      let t = out.find(x => x.slug === r.tenant_slug);
      if (!t) { t = { slug: r.tenant_slug, name: r.tenant_name, configurators: [] }; out.push(t); }
      t.configurators.push({ slug: r.slug, name: r.name, description: r.description });
    }
    return out;
  });

  app.get('/v1/public/t/:slug/configurators/:cslug', async (req, reply) => {
    h.limit(reply, `pub:${req.ip}`, 120, 60_000);
    const { slug, cslug } = req.params as { slug: string; cslug: string };
    const t = await tenantBySlug(slug);
    return withTenant(db, t.id, async tx => {
      const cfg = await getConfigurator(tx, cslug);
      const products = (await tx.query(
        `SELECT id::int AS id, sku, name, category, price_cents AS "priceCents", attrs, (stock > 0) AS "inStock"
           FROM products WHERE active AND category = ANY($1) ORDER BY category, price_cents, name`, [cfg.definition.groups.map(g => g.category)])).rows;
      return { tenant: { slug: t.slug, name: t.name }, configurator: { slug: cfg.slug, name: cfg.name, description: cfg.description, definition: cfg.definition }, products };
    });
  });

  app.post('/v1/public/t/:slug/builds', async (req, reply) => {
    h.limit(reply, `pubbuild:${req.ip}`, 10, 60_000);
    const t = await tenantBySlug((req.params as { slug: string }).slug);
    const b = buildIn.parse(req.body); const s = S(req);
    const out = await saveWithRetry(t.id, b, s && s.userId > 0 ? s.userId : null);
    return reply.status(out.reused ? 200 : 201).send(out);
  });

  // ---- personal y llaves de integración ----
  app.post('/v1/builds', { preHandler: h.staff }, async (req, reply) => {
    const s = S(req)!;
    if (s.role === 'integration') h.limit(reply, `key:${s.keyId}`, 60, 60_000);
    const out = await saveWithRetry(s.tenantId, buildIn.parse(req.body), s.userId > 0 ? s.userId : null);
    return reply.status(out.reused ? 200 : 201).send(out);
  });

  // ---- configuraciones guardadas del usuario (cualquier cuenta) ----
  app.get('/v1/me/builds', { preHandler: h.anyUser }, async req =>
    (await publicQuery(db, 'SELECT * FROM user_builds($1)', [S(req)!.userId])).rows.map(r => ({
      gtin: r.gtin, tenantSlug: r.tenant_slug, tenantName: r.tenant_name, label: r.label, configurator: r.configurator, totalCents: r.total_cents, savedAt: r.saved_at })));
  app.get('/v1/me/builds/:gtin', { preHandler: h.anyUser }, async req => {
    const { gtin } = req.params as { gtin: string };
    if (!isValidGtin13(gtin)) throw new HttpError(422, 'gtin_invalido');
    const bom = (await publicQuery(db, 'SELECT * FROM user_build_detail($1,$2)', [S(req)!.userId, gtin])).rows;
    if (!bom.length) throw new HttpError(404, 'no_encontrado');
    return { gtin, digitalLink: digitalLink(gtin), bom: bom.map(b => ({ name: b.name, qty: b.qty, unitPriceCents: b.unit_price_cents })), svg: { ean13: gtinSvg(gtin, 'ean13'), qr: gtinSvg(gtin, 'qr') } };
  });
}
