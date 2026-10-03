// Productos de todas las webs desde Administración (docs/INTEGRACION-WEBS.md): alta con variantes —cada una con su
// propio GTIN—, edición, retiro y hoja de etiquetas en PDF para recortar y pegar en los productos físicos.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from './errors';
import type { Db, Tx } from './db';
import type { Session } from './session';
import { buildGtin13 } from '../../../packages/codes/src/index';
import { skuSchema } from './web';
import { labelBook, MAX_LABELS } from './labels';

export async function issueProductCode(tx: Tx, tenantId: number, productId: number): Promise<string> {
  const t = (await tx.query('SELECT gs1_prefix, company_prefix FROM tenants WHERE id=$1', [tenantId])).rows[0];
  const item = (await tx.query('SELECT allocate_item($1::smallint) AS n', [tenantId])).rows[0].n as number;
  const gtin = buildGtin13(t.gs1_prefix, t.company_prefix, item);
  await tx.query("INSERT INTO codes (gtin, tenant_id, kind, product_id) VALUES ($1,$2,'product',$3)", [gtin, tenantId, productId]);
  return gtin;
}

/** Igual que la sincronización de repos: minúsculas, sin acentos, guiones ("Otoño" → "otono"). */
export const slugify = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** Sufijo de SKU de una variante: "Grande (420 ml)" → "GRANDE-420-ML". */
export const variantSuffix = (label: string) => label.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');

// Se guarda normalizada (comillas y espacios codificados): las webs la ponen en atributos HTML.
const imageUrl = z.string().trim().max(500).url().refine(u => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u), 'La imagen debe ser una URL https')
  .transform(u => new URL(u).href);
const category = z.string().trim().min(1).max(40).transform(slugify).refine(Boolean, 'Categoría inválida');
const cents = z.number().int().min(0).max(100_000_000);
const productCreate = z.object({
  tenantId: z.number().int().positive(),
  sku: skuSchema.refine(s => s.length <= 40, 'SKU de máximo 40 caracteres'),
  name: z.string().trim().min(1).max(160), category, priceCents: cents,
  stock: z.number().int().min(0).max(1_000_000).default(0),
  description: z.string().trim().max(600).default(''),
  imageUrl: imageUrl.nullable().optional(),
  attrs: z.record(z.string(), z.unknown()).default({}),
  /** Talla, tamaño, gramaje…: cada variante es un producto con su propio código. Sin variantes = un solo producto. */
  variants: z.array(z.object({ label: z.string().trim().min(1).max(30), priceCents: cents.optional() })).max(20).default([]),
});
const productPatch = z.object({
  name: z.string().trim().min(1).max(160), category, priceCents: cents, stock: z.number().int().min(0).max(1_000_000),
  description: z.string().trim().max(600), imageUrl: imageUrl.nullable(), attrs: z.record(z.string(), z.unknown()), active: z.boolean(),
}).partial().strict();
export const labelsQuery = z.object({
  paper: z.enum(['letter', 'a4']).default('letter'), qr: z.enum(['0', '1']).default('0'),
  copies: z.coerce.number().int().min(1).max(50).default(1), scale: z.coerce.number().int().min(80).max(100).default(100),
  category: z.string().max(40).optional(), origin: z.enum(['repo', 'scanbar']).optional(),
  /** /v1/labels.pdf: slug del negocio o "*" = todos (solo SuperAdmin; el personal de un negocio, solo el suyo). */
  tenant: z.union([z.literal('*'), z.string().regex(/^[a-z0-9-]{2,40}$/)]).optional(),
});

const cols = `p.id::int AS id, p.tenant_id AS "tenantId", p.sku, p.name, p.category, p.price_cents AS "priceCents", p.stock, p.attrs, p.active, p.origin,
  p.description, p.image_url AS "imageUrl", p.variant_of AS "variantOf", p.variant, c.gtin`;

type Guard = (req: FastifyRequest) => Promise<void>;
type Audit = (s: Session, tenantId: number | null, action: string, before: unknown, after: unknown) => Promise<unknown>;

export function registerCatalogAdmin(app: FastifyInstance, db: Db, h: { admin: Guard; audit: Audit }) {
  const S = (req: FastifyRequest) => (req as any).session as Session;
  const tenantOf = async (id: number) => {
    const t = (await db.admin.query('SELECT id, slug, name FROM tenants WHERE id=$1', [id])).rows[0];
    if (!t) throw new HttpError(404, 'tenant_no_existe', 'Ese negocio no existe');
    return t as { id: number; slug: string; name: string };
  };

  app.get('/v1/admin/products', { preHandler: h.admin }, async req => {
    const { tenantId } = z.object({ tenantId: z.coerce.number().int().positive() }).parse(req.query);
    await tenantOf(tenantId);
    return (await db.admin.query(`SELECT ${cols} FROM products p LEFT JOIN codes c ON c.product_id = p.id
      WHERE p.tenant_id = $1 ORDER BY p.active DESC, p.category, coalesce(p.variant_of, p.sku), p.id`, [tenantId])).rows;
  });

  app.post('/v1/admin/products', { preHandler: h.admin }, async (req, reply) => {
    const b = productCreate.parse(req.body);
    const t = await tenantOf(b.tenantId);
    const rows = b.variants.length
      ? b.variants.map(v => ({ sku: `${b.sku}-${variantSuffix(v.label)}`, name: `${b.name} — ${v.label}`, variant: v.label as string | null, priceCents: v.priceCents ?? b.priceCents }))
      : [{ sku: b.sku, name: b.name, variant: null, priceCents: b.priceCents }];
    if (rows.some(r => r.sku === `${b.sku}-`) || new Set(rows.map(r => r.sku)).size !== rows.length) throw new HttpError(422, 'variantes_invalidas', 'Hay variantes repetidas o sin letras ni números');
    const c = await db.adminRw.connect();
    try {
      await c.query('BEGIN');
      const created: { id: number; sku: string; name: string; gtin: string }[] = [];
      for (const r of rows) {
        const p = (await c.query(`INSERT INTO products (tenant_id, sku, name, category, price_cents, stock, attrs, origin, description, image_url, variant_of, variant)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'scanbar',$8,$9,$10,$11) RETURNING id`,
          [t.id, r.sku, r.name, b.category, r.priceCents, b.stock, b.attrs, b.description, b.imageUrl ?? null, r.variant ? b.sku : null, r.variant])).rows[0];
        created.push({ id: Number(p.id), sku: r.sku, name: r.name, gtin: await issueProductCode(c, t.id, Number(p.id)) });
      }
      await c.query('COMMIT');
      await h.audit(S(req), t.id, 'product.created', null, { origin: 'scanbar', items: created });
      return reply.status(201).send({ tenant: t.slug, created });
    } catch (e: any) {
      await c.query('ROLLBACK').catch(() => {});
      if (e.code === '23505') throw new HttpError(409, 'sku_duplicado', `Ya existe un producto con ese SKU en ${t.name}`);
      throw e;
    } finally { c.release(); }
  });

  app.patch('/v1/admin/products/:id', { preHandler: h.admin }, async req => {
    const id = Number((req.params as { id: string }).id);
    const b = productPatch.parse(req.body);
    const before = (await db.admin.query(`SELECT ${cols}, t.slug AS "tenantSlug" FROM products p LEFT JOIN codes c ON c.product_id = p.id JOIN tenants t ON t.id = p.tenant_id WHERE p.id=$1`, [id])).rows[0];
    if (!before) throw new HttpError(404, 'producto_no_existe');
    // Lo que define el código de una web lo mantiene la sincronización: aquí solo se ajustan existencias.
    if (before.origin === 'repo' && Object.keys(b).some(k => k !== 'stock'))
      throw new HttpError(409, 'administrado_por_repo', `Este producto viene del código de la web (${before.tenantSlug}): cámbialo ahí y ejecuta npm run sync:repos. Aquí solo se ajustan existencias.`);
    const v = { ...before, ...b };
    const c = await db.adminRw.connect();
    try {
      await c.query('BEGIN');
      await c.query('UPDATE products SET name=$2, category=$3, price_cents=$4, stock=$5, description=$6, image_url=$7, attrs=$8, active=$9 WHERE id=$1',
        [id, v.name, v.category, v.priceCents, v.stock, v.description, v.imageUrl, v.attrs, v.active]);
      // Retirar, no borrar: el código queda registrado y el resolver responde "retirado"; reactivar lo devuelve.
      if (b.active !== undefined && b.active !== before.active)
        await c.query('UPDATE codes SET retired_at = CASE WHEN $2 THEN NULL ELSE now() END WHERE product_id=$1', [id, b.active]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    const after = (await db.admin.query(`SELECT ${cols} FROM products p LEFT JOIN codes c ON c.product_id = p.id WHERE p.id=$1`, [id])).rows[0];
    const { tenantSlug: _drop, ...prev } = before;
    await h.audit(S(req), before.tenantId, 'product.updated', prev, after);
    return after;
  });

  app.get('/v1/admin/tenants/:id/labels.pdf', { preHandler: h.admin }, async (req, reply) => {
    const t = await tenantOf(Number((req.params as { id: string }).id));
    const q = labelsQuery.parse(req.query);
    const r = await buildLabels((sql, params) => db.admin.query(sql, params), [t], q);
    await h.audit(S(req), t.id, 'labels.pdf', null, { products: r.products, labels: r.labels, ...q });
    return sendLabels(reply, r);
  });
}

type Query = (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;
type TenantRef = { id: number; slug: string; name: string };
export type Labels = { pdf: Buffer; products: number; labels: number; filename: string };
/**
 * Hoja de etiquetas de uno o varios negocios: todos sus productos activos con código (o una categoría / un origen), con el
 * nombre encima de cada código; cada negocio empieza en página nueva. La usan la consola (cualquier negocio), el SuperAdmin
 * desde Catálogo (cualquiera o todos) y el personal de cada negocio (solo el suyo, con RLS).
 */
export async function buildLabels(query: Query, tenants: TenantRef[], q: z.infer<typeof labelsQuery>): Promise<Labels> {
  const sections: { title: string; items: { name: string; sku: string; gtin: string }[] }[] = [];
  let products = 0;
  for (const t of tenants) {
    const params: unknown[] = [t.id]; let where = '';
    if (q.category) { params.push(slugify(q.category)); where += ` AND p.category = $${params.length}`; }
    if (q.origin) { params.push(q.origin); where += ` AND p.origin = $${params.length}`; }
    const rows = (await query(`SELECT p.name, p.sku, c.gtin FROM products p JOIN codes c ON c.product_id = p.id AND c.retired_at IS NULL
      WHERE p.tenant_id = $1 AND p.active${where} ORDER BY p.category, coalesce(p.variant_of, p.sku), p.id`, params)).rows as { name: string; sku: string; gtin: string }[];
    products += rows.length;
    sections.push({ title: t.name, items: rows.flatMap(r => Array<typeof r>(q.copies).fill(r)) });
  }
  const labels = sections.reduce((n, sec) => n + sec.items.length, 0);
  if (!labels) throw new HttpError(404, 'sin_productos', 'No hay productos activos con código para esas opciones');
  if (labels > MAX_LABELS) throw new HttpError(422, 'demasiadas_etiquetas', `Máximo ${MAX_LABELS} etiquetas por archivo (pediste ${labels}); filtra por categoría o baja las copias`);
  const one = tenants.length === 1 ? tenants[0] : null;
  const pdf = labelBook(sections, one?.name ?? 'Todos los negocios', { paper: q.paper, qr: q.qr === '1', scale: q.scale / 100 });
  return { pdf, products, labels, filename: `etiquetas-${one?.slug ?? 'todos-los-negocios'}-${new Date().toISOString().slice(0, 10)}.pdf` };
}
export const sendLabels = (reply: FastifyReply, r: Labels) => reply.header('Content-Type', 'application/pdf').header('Cache-Control', 'no-store')
  .header('Content-Disposition', `attachment; filename="${r.filename}"`).send(r.pdf);
