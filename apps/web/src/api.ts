import { kvGet, kvSet } from './kv';

export class ApiError extends Error { constructor(public status: number, public body: any) { super(body?.message ?? body?.error ?? String(status)); } }

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? 'GET', credentials: 'same-origin',
    headers: { 'X-Requested-With': 'pwa', ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    // La contraseña de administrador caducó: la app vuelve a pedirla.
    if (res.status === 403 && json?.error === 'admin_locked') window.dispatchEvent(new Event('admin-locked'));
    throw new ApiError(res.status, json);
  }
  return json as T;
}

export type Me = {
  role: 'superadmin' | 'operador_pos' | 'cliente'; email: string;
  tenant: { id: number; slug: string; name: string } | null; // null = cliente registrado (sin negocio)
  totp: boolean; adminUnlocked: boolean;
};

export const money = (c: number) => (c / 100).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
export const fmtGtin = (g: string) => `${g[0]} ${g.slice(1, 7)} ${g.slice(7)}`;

// ---- cola de escaneos y de ventas sin red (IndexedDB) ----
export type Product = { id: number; sku: string; name: string; category: string; priceCents: number; stock: number; attrs: Record<string, any>; gtin: string };
export type QueuedSale = { key: string; items: { gtin: string; qty: number }[]; paymentMethod: string };

export async function queueScanEvent(e: Record<string, unknown>) {
  const q = await kvGet<any[]>('scanQueue', []); q.push({ device: await kvGet('device', undefined), support: await kvGet('support', undefined), ...e }); await kvSet('scanQueue', q); flushScanEvents();
}
let flushing = false;
export async function flushScanEvents() {
  if (flushing) return; flushing = true;
  try {
    const q = await kvGet<any[]>('scanQueue', []);
    if (!q.length) return;
    await api('/v1/scan-events', { method: 'POST', body: { events: q.slice(0, 200) } });
    await kvSet('scanQueue', q.slice(200));
  } catch { /* se reintenta luego */ } finally { flushing = false; }
}

export async function queueSale(s: QueuedSale) { const q = await kvGet<QueuedSale[]>('saleQueue', []); q.push(s); await kvSet('saleQueue', q); }
export async function pendingSales() { return kvGet<QueuedSale[]>('saleQueue', []); }
/** Reintenta con la misma Idempotency-Key; devuelve cuántas se sincronizaron. */
export async function flushSales(): Promise<number> {
  const q = await pendingSales(); let done = 0; const rest: QueuedSale[] = [];
  for (const s of q) {
    try { await api('/v1/sales', { method: 'POST', body: { items: s.items, paymentMethod: s.paymentMethod }, headers: { 'Idempotency-Key': s.key } }); done++; }
    catch (e) { if (e instanceof ApiError && e.status >= 400 && e.status < 500) continue; /* rechazo definitivo */ rest.push(s); }
  }
  await kvSet('saleQueue', rest); return done;
}
