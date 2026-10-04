// Tarjetas de acceso: un QR impreso por negocio para entrar como su caja sin escribir contraseña (escáner de la PWA o la
// cámara del teléfono). El enlace lleva el token en el fragmento (#k=…): el navegador no lo manda al servidor ni queda en
// registros; la PWA lo lee y lo envía en el cuerpo de POST /v1/auth/acceso. Solo se guarda su sha256.
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from './errors';
import type { Db } from './db';
import type { Session } from './session';
import { cajaEmail } from './bootstrap';
import { textQrSvg } from './svg';
import { MM, buildPdf, cutGuide, placeOps, svgToPdf, textOps, textWidth, wrapText } from './pdf';

export const ACCESS_PATH = '/acceso';
export const accessUrl = (base: string, token: string) => `${base.replace(/\/+$/, '')}${ACCESS_PATH}#k=${token}`;
export const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
/** 32 bytes al azar en base64url: 43 caracteres. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
export type Card = { tenantId: number; slug: string; name: string; email: string; url: string };

/**
 * Emite una tarjeta nueva para cada negocio pedido (todos si no se indica) y desactiva la anterior: la tarjeta va a la cuenta
 * de caja del negocio (caja.<negocio>@… si existe; si no, su primer operador). Negocios sin caja se devuelven en `sinCaja`.
 * Corre dentro de la transacción del llamador (consola: admin_rw; panel: dueño de la base).
 */
export async function issueCards(q: Query, o: { tenantIds?: number[]; createdBy: number | null; base: string }) {
  const tenants = (await q(`SELECT id::int AS id, slug, name FROM tenants ${o.tenantIds ? 'WHERE id = ANY($1)' : ''} ORDER BY name`, o.tenantIds ? [o.tenantIds] : [])).rows;
  const cards: Card[] = []; const sinCaja: string[] = [];
  for (const t of tenants) {
    const u = (await q(`SELECT u.id, u.email FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1 AND m.role = 'operador_pos' ORDER BY (u.email = $2) DESC, u.id LIMIT 1`, [t.id, cajaEmail(t.slug)])).rows[0];
    if (!u) { sinCaja.push(t.name); continue; }
    const token = crypto.randomBytes(32).toString('base64url');
    await q('UPDATE access_cards SET revoked_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL', [t.id]);
    await q('INSERT INTO access_cards (tenant_id, user_id, token_hash, created_by) VALUES ($1,$2,$3,$4)', [t.id, u.id, hashToken(token), o.createdBy]);
    cards.push({ tenantId: t.id, slug: t.slug, name: t.name, email: u.email, url: accessUrl(o.base, token) });
  }
  return { cards, sinCaja };
}

/** Hoja carta con hasta 4 tarjetas (2 × 2) para recortar: nombre del negocio, QR grande e instrucciones. */
export function cardsPdf(cards: Card[]): Buffer {
  const pw = 215.9 * MM, ph = 279.4 * MM, margin = 12 * MM, gap = 6 * MM;
  const w = (pw - 2 * margin - gap) / 2, h = (ph - 2 * margin - gap) / 2;
  const fecha = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
  const pages: { width: number; height: number; content: string }[] = [];
  for (let p = 0; p < Math.max(1, Math.ceil(cards.length / 4)); p++) {
    let c = '';
    cards.slice(p * 4, p * 4 + 4).forEach((card, i) => {
      const x = margin + (i % 2) * (w + gap), top = ph - margin - Math.floor(i / 2) * (h + gap);
      c += cutGuide(x, top - h, w, h);
      const centro = (s: string, y: number, font: 'F1' | 'F2', size: number, gray = 0) => textOps(s, x + (w - textWidth(s, font, size)) / 2, y, font, size, gray);
      c += centro('SCAN-BAR · TARJETA DE ACCESO', top - 9 * MM, 'F2', 7.5, 0.4);
      let y = top - 17 * MM;
      for (const l of wrapText(card.name, 'F2', 17, w - 10 * MM, 2)) { c += centro(l, y, 'F2', 17); y -= 20; }
      c += centro(`Entra como caja · ${card.email}`, y - 1 * MM, 'F1', 7.5, 0.35);
      const qr = svgToPdf(textQrSvg(card.url)); const lado = 58 * MM;
      const qy = top - h + 33 * MM;
      c += placeOps(qr, x + (w - lado) / 2, qy, lado / qr.width);
      const pasos = ['Abre Scan-bar, ve a Escáner y apunta a este código', '(o escanéalo con la cámara del teléfono).', 'Quien tenga esta tarjeta puede cobrar en este negocio: guárdala.', 'Si se pierde, genera una nueva: esta deja de servir.'];
      pasos.forEach((s, k) => { c += centro(s, qy - 6 * MM - k * 11, 'F1', 7.5, k < 2 ? 0 : 0.35); });
      c += centro(`Emitida el ${fecha}`, top - h + 5 * MM, 'F1', 6.5, 0.45);
    });
    pages.push({ width: pw, height: ph, content: c });
  }
  return buildPdf(pages, { title: 'Tarjetas de acceso · Scan-bar' });
}

type Guard = (req: FastifyRequest) => Promise<void>;
type Audit = (s: Session, tenantId: number | null, action: string, before: unknown, after: unknown) => Promise<unknown>;

/** Consola (Administración → Acceso con QR): ver, emitir (PDF) y desactivar tarjetas. */
export function registerAccessAdmin(app: FastifyInstance, db: Db, h: { admin: Guard; audit: Audit }) {
  const S = (req: FastifyRequest) => (req as any).session as Session;

  app.get('/v1/admin/access-cards', { preHandler: h.admin }, async () => {
    const tenants = (await db.admin.query(`SELECT t.id::int AS id, t.slug, t.name, a.created_at AS "createdAt", a.last_used_at AS "lastUsedAt", a.uses
      FROM tenants t LEFT JOIN access_cards a ON a.tenant_id = t.id AND a.revoked_at IS NULL ORDER BY t.name`)).rows;
    const ops = (await db.admin.query(`SELECT m.tenant_id::int AS "tenantId", u.email FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.role = 'operador_pos' ORDER BY u.id`)).rows as { tenantId: number; email: string }[];
    return tenants.map(t => {
      const suyos = ops.filter(o => o.tenantId === t.id).map(o => o.email);
      return { tenantId: t.id, slug: t.slug, name: t.name, caja: suyos.find(e => e === cajaEmail(t.slug)) ?? suyos[0] ?? null,
        card: t.createdAt ? { createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, uses: t.uses } : null };
    });
  });

  // Emite (y desactiva las anteriores de esos negocios); responde el PDF para imprimir. El token no se guarda ni se registra.
  app.post('/v1/admin/access-cards', { preHandler: h.admin }, async (req, reply) => {
    const { tenantIds } = z.object({ tenantIds: z.array(z.number().int().positive()).max(100).optional() }).parse(req.body ?? {});
    const c = await db.adminRw.connect();
    let r: Awaited<ReturnType<typeof issueCards>>;
    try {
      await c.query('BEGIN');
      r = await issueCards((sql, params) => c.query(sql, params), { tenantIds, createdBy: S(req).userId, base: `${req.protocol}://${req.host}` });
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    if (!r.cards.length) throw new HttpError(409, 'sin_caja', `Ese negocio no tiene cuenta de caja (${r.sinCaja.join(', ')}); créala en Usuarios`);
    for (const k of r.cards) await h.audit(S(req), k.tenantId, 'access_card.issued', null, { caja: k.email });
    return reply.header('Content-Type', 'application/pdf').header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="tarjetas-acceso-${new Date().toISOString().slice(0, 10)}.pdf"`)
      .header('X-Sin-Caja', encodeURIComponent(r.sinCaja.join(', '))).send(cardsPdf(r.cards));
  });

  app.post('/v1/admin/access-cards/:tenantId/revoke', { preHandler: h.admin }, async req => {
    const tenantId = Number((req.params as { tenantId: string }).tenantId);
    const n = (await db.adminRw.query('UPDATE access_cards SET revoked_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL', [tenantId])).rowCount ?? 0;
    if (!n) throw new HttpError(404, 'sin_tarjeta', 'Ese negocio no tiene tarjeta activa');
    await h.audit(S(req), tenantId, 'access_card.revoked', null, null);
    return { revoked: n };
  });
}
