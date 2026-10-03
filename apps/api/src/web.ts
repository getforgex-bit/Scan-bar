// Integración con las páginas web de los negocios (docs/INTEGRACION-WEBS.md):
// 1) catálogo público de lo que se agregó desde Scan-bar, para que cada web lo muestre;
// 2) código para cada configuración que el cliente arma en la web (bebida, ensamble de PC, pedido).
// Sin sesión, con límite de tasa y CORS solo para los dominios registrados del negocio.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from './errors';
import { withTenant, publicQuery, type Db, type Tx } from './db';
import { digitalLink } from './svg';
import { isProd } from './env';
import { isLocalHost } from './security';
import { evaluate } from '../../../packages/codes/src/rules';
import { getConfigurator, issueBuild } from './builds';

type Limit = (reply: FastifyReply, key: string, max: number, windowMs: number) => void;

/** Lo que el cliente arma en una web se nombra con una lista cerrada: el texto se muestra en la ficha del resolver y en Caja. */
export const WEB_LABELS = ['Pedido', 'Bebida', 'Ensamble', 'Paquete', 'Personalizado'] as const;
export const skuSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'SKU inválido');
export const webConfigIn = z.object({
  label: z.enum(WEB_LABELS).default('Pedido'),
  /** Opcional: si el negocio definió un configurador en Scan-bar, sus reglas se aplican además de las de la web. */
  configurator: z.string().regex(/^[a-z0-9-]{2,40}$/).optional(),
  lines: z.array(z.object({ sku: skuSchema, qty: z.number().int().min(1).max(99) })).min(1).max(60),
});
export type WebConfigIn = z.infer<typeof webConfigIn>;

const svgPaths = (gtin: string) => ({ ean13: `/v1/codes/${gtin}.svg?kind=ean13`, qr: `/v1/codes/${gtin}.svg?kind=qr` });
const taxOf = (total: number) => Math.round(total * 16 / 116); // IVA incluido

/** Registra (o reutiliza) el código de una configuración hecha en la web del negocio. Precios: los de Scan-bar, nunca los del cliente. */
export async function saveWebConfiguration(tx: Tx, tenantId: number, input: WebConfigIn) {
  const merged = new Map<string, number>();
  for (const l of input.lines) merged.set(l.sku, (merged.get(l.sku) ?? 0) + l.qty);
  const skus = [...merged.keys()];
  const parts = (await tx.query('SELECT id, sku, name, category, price_cents, attrs FROM products WHERE sku = ANY($1) AND active FOR SHARE', [skus])).rows;
  if (parts.length !== skus.length) {
    const found = new Set(parts.map(p => p.sku as string));
    const missing = skus.filter(s => !found.has(s));
    throw new HttpError(422, 'producto_invalido', `No existen en este negocio o están retirados: ${missing.join(', ')}`, missing);
  }
  const cfg = input.configurator ? await getConfigurator(tx, input.configurator) : null;
  if (cfg) {
    const viol = evaluate(cfg.definition, parts.map(p => ({ id: Number(p.id), category: p.category, attrs: p.attrs, name: p.name, qty: merged.get(p.sku) })));
    if (viol.length) throw new HttpError(422, 'incompatible', viol[0].message, viol);
  }
  // Una sola unidad de un solo producto ya tiene código propio: no se emite otro.
  if (!cfg && parts.length === 1 && merged.get(parts[0].sku) === 1) {
    const p = parts[0];
    const c = (await tx.query('SELECT gtin FROM codes WHERE product_id=$1 AND retired_at IS NULL', [p.id])).rows[0];
    if (c) return {
      gtin: c.gtin as string, kind: 'product' as const, label: p.name as string, name: p.name as string, reused: true,
      totalCents: p.price_cents as number, taxCents: taxOf(p.price_cents), lines: [{ sku: p.sku, name: p.name, qty: 1, unitPriceCents: p.price_cents }],
      digitalLink: digitalLink(c.gtin), svg: svgPaths(c.gtin),
    };
  }
  const label = cfg ? cfg.definition.itemLabel : input.label;
  const bl = parts.map(p => ({ productId: Number(p.id), qty: merged.get(p.sku)!, unitPriceCents: p.price_cents as number }));
  const r = await issueBuild(tx, tenantId, bl, { configuratorId: cfg?.id ?? null, label: cfg ? null : input.label, userId: null, audit: { source: 'web', label } });
  const gtin = (await tx.query('SELECT gtin FROM codes WHERE build_id=$1', [r.buildId])).rows[0].gtin as string;
  const total = (await tx.query('SELECT total_cents FROM builds WHERE id=$1', [r.buildId])).rows[0].total_cents as number;
  const lines = (await tx.query(`SELECT p.sku, p.name, bi.qty, bi.unit_price_cents AS "unitPriceCents"
    FROM build_items bi JOIN products p ON p.id=bi.product_id WHERE bi.build_id=$1 ORDER BY p.name`, [r.buildId])).rows;
  return { gtin, kind: 'build' as const, label, name: `${label} ${gtin}`, reused: r.reused, totalCents: total, taxCents: taxOf(total), lines, digitalLink: digitalLink(gtin), svg: svgPaths(gtin) };
}

type CatalogRow = { sku: string; name: string; category: string; description: string; image_url: string | null; attrs: Record<string, unknown>; price_cents: number; in_stock: boolean; variant_of: string | null; variant: string | null };
/** Agrupa las variantes (talla, tamaño…) bajo su SKU base: la web pinta una tarjeta con selector. */
export function groupCatalog(rows: CatalogRow[]) {
  const out: { sku: string; name: string; category: string; description: string; imageUrl: string | null; attrs: Record<string, unknown>; priceCents: number; variants: { sku: string; label: string | null; priceCents: number; inStock: boolean }[] }[] = [];
  const byBase = new Map<string, (typeof out)[number]>();
  for (const r of rows) {
    const base = r.variant_of ?? r.sku;
    let g = byBase.get(base);
    if (!g) {
      const suffix = r.variant ? ` — ${r.variant}` : '';
      g = { sku: base, name: suffix && r.name.endsWith(suffix) ? r.name.slice(0, -suffix.length) : r.name, category: r.category, description: r.description, imageUrl: r.image_url, attrs: r.attrs, priceCents: r.price_cents, variants: [] };
      byBase.set(base, g); out.push(g);
    }
    g.variants.push({ sku: r.sku, label: r.variant, priceCents: r.price_cents, inStock: r.in_stock });
    g.priceCents = Math.min(g.priceCents, r.price_cents);
  }
  return out;
}

export function registerWeb(app: FastifyInstance, db: Db, h: { limit: Limit }) {
  const webTenant = async (slug: string) => {
    const t = (await publicQuery(db, 'SELECT * FROM public_tenant($1)', [slug])).rows[0];
    if (!t) throw new HttpError(404, 'negocio_no_existe', 'Ese negocio no existe');
    const domains = (await withTenant(db, t.id, tx => tx.query('SELECT allowed_domains FROM tenants WHERE id=$1', [t.id]))).rows[0]?.allowed_domains as string[] ?? [];
    return { id: Number(t.id), slug: t.slug as string, name: t.name as string, domains };
  };
  /** Webs de la misma cuenta de Cloudflare que Scan-bar (mismo subdominio *.cuenta.workers.dev): solo esa cuenta puede publicar ahí. */
  const sameAccount = (host: string, own: string) => {
    const acct = (h: string) => /\.([a-z0-9-]+\.workers\.dev)$/i.exec(h)?.[1]?.toLowerCase();
    return !!acct(host) && acct(host) === acct(own);
  };
  /** CORS por negocio: sus dominios registrados (los mismos a los que redirige el resolver), la misma cuenta de workers.dev y localhost para pruebas. Nunca con credenciales. */
  const allowOrigin = (req: FastifyRequest, reply: FastifyReply, domains: string[]): boolean => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string') return true; // misma origen o fuera de un navegador
    reply.header('Vary', 'Origin');
    let ok = false;
    if (origin === 'null') ok = !isProd(); // página abierta como archivo (file://) mientras se desarrolla
    else { try { const host = new URL(origin).hostname; ok = domains.includes(host) || isLocalHost(host) || sameAccount(host, req.hostname); } catch { ok = false; } }
    if (ok) reply.header('Access-Control-Allow-Origin', origin);
    return ok;
  };
  const slugOf = (req: FastifyRequest) => (req.params as { slug: string }).slug;

  for (const path of ['/v1/public/t/:slug/catalog', '/v1/public/t/:slug/configurations']) {
    app.options(path, async (req, reply) => {
      h.limit(reply, `pub:${req.ip}`, 120, 60_000);
      const t = await webTenant(slugOf(req));
      if (!allowOrigin(req, reply, t.domains)) return reply.status(403).send({ error: 'origen_no_permitido' });
      return reply.status(204).header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        .header('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With').header('Access-Control-Max-Age', '600').send();
    });
  }

  app.get('/v1/public/t/:slug/catalog', async (req, reply) => {
    h.limit(reply, `pub:${req.ip}`, 120, 60_000);
    const t = await webTenant(slugOf(req));
    allowOrigin(req, reply, t.domains);
    const rows = await withTenant(db, t.id, async tx => (await tx.query(
      `SELECT sku, name, category, description, image_url, attrs, price_cents, (stock > 0) AS in_stock, variant_of, variant
         FROM products WHERE active AND origin = 'scanbar' ORDER BY category, coalesce(variant_of, sku), id`)).rows as CatalogRow[]);
    reply.header('Cache-Control', 'public, max-age=60');
    return { tenant: { slug: t.slug, name: t.name }, products: groupCatalog(rows), generatedAt: new Date().toISOString() };
  });

  app.post('/v1/public/t/:slug/configurations', async (req, reply) => {
    h.limit(reply, `webcfg:${req.ip}`, 30, 60_000);
    const t = await webTenant(slugOf(req));
    if (!allowOrigin(req, reply, t.domains)) throw new HttpError(403, 'origen_no_permitido', 'Este dominio no está registrado para el negocio');
    const input = webConfigIn.parse(req.body);
    const run = () => withTenant(db, t.id, tx => saveWebConfiguration(tx, t.id, input));
    let out: Awaited<ReturnType<typeof run>>;
    try { out = await run(); } catch (e: any) { if (e.code !== '23505') throw e; out = await run(); } // dos guardados idénticos a la vez
    reply.header('Cache-Control', 'no-store');
    return reply.status(out.reused ? 200 : 201).send(out);
  });
}
