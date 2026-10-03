// Catálogo de las seis webs desde sus repositorios de GitHub (docs/INTEGRACION-WEBS.md).
// Lo usan `npm run sync:repos` y el servidor: al arrancar, cada SYNC_INTERVAL_MIN minutos si algún repo cambió
// y con el botón "Sincronizar ahora" de la consola.
// Idempotente: un SKU ya sincronizado conserva su GTIN; lo que desaparece del repo se retira (no se borra).
// Cada configuración de producto que define la web (talla, tamaño, gramaje, variante) es un producto con su propio GTIN.
// Solo administra productos de origen 'repo': lo que se agregó desde Scan-bar (origen 'scanbar') no se toca ni se retira.
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { buildGtin13 } from '../../../packages/codes/src/index';
import { slugify } from './catalog';

const exec = promisify(execFile);
export const OWNER = 'getforgex-bit';

type Item = { sku: string; name: string; category: string; cents: number; stock?: number; attrs: Record<string, unknown>; variantOf?: string; variant?: string };
export type WebSource = {
  slug: string; name: string; companyPrefix: string; repo: string;
  /** Nombre del Worker en Cloudflare (wrangler.jsonc de la web): da su URL en workers.dev. */
  worker: string;
  /** Únicos archivos que se descargan del repo (clonado parcial): nada de fotos ni videos. */
  paths: string[];
  extract: (dir: string) => Promise<Item[]>;
};
export type Db = { connect(): Promise<{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>; release(): void }> };
export type SyncResult = { slug: string; items: number; created: number; updated: number; retired: number; reactivated: number; skipped: number; head?: string; error?: string };

const cents = (mxn: number) => Math.round(mxn * 100);
const read = (dir: string, ...names: string[]) => {
  const f = names.find(n => fs.existsSync(path.join(dir, n)));
  if (!f) throw new Error(`No se encontró ${names.join(' ni ')}`);
  return fs.readFileSync(path.join(dir, f), 'utf8');
};
/** JSON con llaves ordenadas: jsonb no conserva el orden de inserción. */
const canon = (o: unknown): string => JSON.stringify(o, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
/** Ejecuta un fragmento JS de un repo en un contexto aislado (sin red ni fs) y devuelve su último valor. */
const run = (code: string, globals: Record<string, unknown> = {}) => vm.runInNewContext(code, { ...globals }, { timeout: 2000 });
/** Compila un módulo TS del repo (con sus imports locales) y lo carga como módulo ESM. */
async function loadTs(dir: string, entry: string): Promise<any> {
  const out = await build({ entryPoints: [path.join(dir, entry)], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent', loader: { '.svg': 'text' } });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}
/** Corta el literal de array que empieza en `marker` (hasta su `];` a inicio de línea). */
function arrayLiteral(src: string, marker: string): string {
  const i = src.indexOf(marker); if (i < 0) throw new Error(`No se encontró ${marker}`);
  const start = src.indexOf('[', i), end = src.indexOf('\n];', start);
  if (start < 0 || end < 0) throw new Error(`Array sin cerrar tras ${marker}`);
  return src.slice(start, end + 2);
}

export const SOURCES: WebSource[] = [
  {
    slug: 'yokrem', name: 'YOKREM', companyPrefix: '0010', repo: 'yokrem', worker: 'yokrem', paths: ['/js/products.js'],
    async extract(dir) {
      const w: any = {}; run(read(dir, 'js/products.js'), { window: w });
      // Una prenda por talla: la etiqueta que se pega en la ropa identifica la talla.
      const tallas: string[] = w.YOKREM_TALLAS ?? [];
      const porTalla = (p: any, category: string, attrs: Record<string, unknown>): Item[] => tallas.map(t => ({ sku: `${p.id}-${t}`, name: `${p.nombre} — ${t}`, category, cents: cents(p.precio), attrs, variantOf: p.id, variant: t }));
      const prendas = w.YOKREM_PRODUCTOS.flatMap((p: any) => porTalla(p, p.temporada, { color: p.color, temporada: p.temporada }));
      const conjuntos = (w.YOKREM_CONJUNTOS ?? []).flatMap((p: any) => porTalla(p, 'conjunto', { temporada: p.temporada, piezas: p.piezas }));
      return [...prendas, ...conjuntos];
    },
  },
  {
    slug: 'cafe-motz', name: 'Motz Café', companyPrefix: '0011', repo: 'Cafe-Motz', worker: 'cafe-motz', paths: ['/src/data/', '/src/types.ts'],
    async extract(dir) {
      const m = await loadTs(dir, 'src/data/coffeeData.ts');
      const items: Item[] = [];
      for (const i of m.MENU_ITEMS) {
        const sizes: [string, number | undefined, string | undefined][] = [['ch', i.priceSmall, i.sizeSmallLabel], ['gde', i.priceLarge, i.sizeLargeLabel]];
        const real = sizes.filter(([, p]) => typeof p === 'number');
        // Debe coincidir con skuDeTamano() de src/lib/scanbar.ts en la web.
        for (const [k, p, label] of real) items.push({ sku: real.length > 1 ? `${i.id}-${k}` : i.id, name: real.length > 1 ? `${i.name} — ${label ?? k}` : i.name, category: i.category, cents: cents(p!), attrs: { tamano: real.length > 1 ? k : undefined }, ...(real.length > 1 ? { variantOf: i.id, variant: label ?? k } : {}) });
      }
      for (const c of m.COMBOS) items.push({ sku: c.id, name: c.title, category: 'combo', cents: cents(c.price), attrs: {} });
      // Leche y extras de la bebida configurada (se cobran aparte y forman parte del código de la bebida).
      const mods: any[] = m.MODIFICADORES ? [...Object.values(m.MODIFICADORES.leche ?? {}), m.MODIFICADORES.extraShot, m.MODIFICADORES.cremaBatida].filter(Boolean) : [];
      for (const x of mods) items.push({ sku: x.sku, name: x.nombre, category: 'modificador', cents: cents(x.precio), stock: 999, attrs: {} });
      return items;
    },
  },
  {
    slug: 'dulce-encanto', name: 'Dulce Encanto', companyPrefix: '0012', repo: 'dulce-encanto', worker: 'dulce-encanto', paths: ['/index.html', '/Dulce Encanto.html'],
    async extract(dir) {
      const rows: any[] = run(`(${arrayLiteral(read(dir, 'index.html', 'Dulce Encanto.html'), 'const PRODUCTOS')})`);
      return rows.map(p => ({ sku: p.id, name: p.nombre, category: p.cat, cents: cents(p.precio), attrs: { unidad: p.unidad, casa: p.casa } }));
    },
  },
  {
    slug: 'nova-core', name: 'Nova Core', companyPrefix: '0013', repo: 'nova-core', worker: 'nova-core', paths: ['/src/data/', '/src/types/', '/src/utils/hardwareSvgImages.ts'],
    async extract(dir) {
      const [h, k, s] = await Promise.all([loadTs(dir, 'src/data/hardware.ts'), loadTs(dir, 'src/data/packs.ts'), loadTs(dir, 'src/data/services.ts')]);
      const items: Item[] = [];
      for (const c of h.HARDWARE_CATALOG) {
        items.push({ sku: c.sku, name: c.name, category: c.category, cents: cents(c.price), attrs: { marca: c.brand, tdp_w: c.tdpWattage, socket: c.socket } });
        for (const v of c.variants ?? []) {
          if (v.sku === c.sku) continue; // variante estándar = el mismo artículo
          const price = v.price ?? c.price + (v.priceDelta ?? 0);
          items.push({ sku: v.sku, name: `${c.name} — ${v.name}`, category: c.category, cents: cents(price), attrs: { variante_de: c.sku }, variantOf: c.sku, variant: v.name });
        }
      }
      for (const p of k.PREBUILT_PACKS) items.push({ sku: p.ref, name: p.name, category: `pack-${p.category}`, cents: cents(p.price), stock: p.stockCount, attrs: {} });
      for (const v of s.TECH_SERVICES) items.push({ sku: v.code, name: v.title, category: 'servicio', cents: cents(v.price), attrs: { duracion: v.duration } });
      // Servicios que se suman al ensamble a medida (montaje, sistema operativo…): forman parte del código del ensamble.
      for (const v of s.BUILD_SERVICES ?? []) items.push({ sku: v.sku, name: v.name, category: 'servicio-ensamble', cents: cents(v.price), stock: 999, attrs: {} });
      return items;
    },
  },
  {
    slug: 'la-picosita-de-la-sierra', name: 'La Picosita de la Sierra', companyPrefix: '0014', repo: 'La-picosita-de-la-sierra', worker: 'la-picosita-de-la-sierra', paths: ['/index.html', '/code.html'],
    async extract(dir) {
      const src = read(dir, 'index.html', 'code.html');
      const a = src.indexOf('const IMGS='), b = src.indexOf('P.forEach(', a);
      const P: any[] = run(`${src.slice(a, src.indexOf('\n', b))}\nP`);
      return P.flatMap(p => p.sizes.map((z: any) => ({ sku: `${p.id}-${z.g}G`, name: `${p.n} ${z.g} g`, category: p.t, cents: cents(z.p), attrs: { gramos: z.g, picor: p.pi }, variantOf: p.id, variant: `${z.g} g` })));
    },
  },
  {
    slug: 'biker-lifestyle', name: 'Biker Lifestyle', companyPrefix: '0015', repo: 'biker-lifestyle', worker: 'biker-lifestyle', paths: ['/public/index.html'],
    async extract(dir) {
      const html = read(dir, 'public/index.html');
      const cat: Record<string, string> = { GP: 'gorras', GC: 'gorras', GB: 'gorras', CS: 'cascos', AC: 'accesorios' };
      return [...html.matchAll(/<button\b[^>]*\bdata-add\b[^>]*>/g)].flatMap(([tag]) => {
        const at = Object.fromEntries([...tag.matchAll(/data-([a-z-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
        const kind = /^BKR-([A-Z]{2})/.exec(at.sku)?.[1] ?? '';
        const base: Item = { sku: at.sku, name: at.name, category: cat[kind] ?? 'otros', cents: cents(Number(at.price)), attrs: { con_talla: at.sized === 'true' } };
        if (at.sized !== 'true') return [base];
        // Cascos: un producto por talla (las del selector de su tarjeta).
        const sizes = [...new Set([...html.matchAll(new RegExp(`name="size-${at.sku}" value="([^"]+)"`, 'g'))].map(m => m[1]))];
        if (!sizes.length) throw new Error(`${at.sku} lleva talla pero no se encontraron sus tallas`);
        return sizes.map(z => ({ ...base, sku: `${at.sku}-${z}`, name: `${at.name} — Talla ${z}`, variantOf: at.sku, variant: z }));
      });
    },
  },
];

/**
 * URL pública de la web de un negocio: WEB_URL_<SLUG> (p. ej. WEB_URL_CAFE_MOTZ=https://cafe.ejemplo.mx/) o, si Scan-bar
 * corre en workers.dev, la del Worker de la web en la misma cuenta (https://<worker>.<cuenta>.workers.dev/).
 */
export function siteUrl(src: WebSource, env = process.env): string | null {
  const explicit = env[`WEB_URL_${src.slug.toUpperCase().replace(/-/g, '_')}`];
  if (explicit) { try { return new URL(explicit).toString(); } catch { return null; } }
  const host = env.RESOLVER_HOST ?? '';
  const m = /^[^.]+\.([a-z0-9-]+\.workers\.dev)$/i.exec(host);
  return m ? `https://${src.worker}.${m[1]}/` : null;
}

/** Clonado parcial: solo los archivos de catálogo de la web (segundos y unos cientos de KB, sin fotos ni videos). */
export async function fetchRepo(src: WebSource, opts: { local?: string } = {}): Promise<{ dir: string; head: string; cleanup: () => void }> {
  if (opts.local) {
    const dir = path.resolve(opts.local, src.repo);
    if (!fs.existsSync(dir)) throw new Error(`No existe ${dir}`);
    const head = (await exec('git', ['-C', dir, 'rev-parse', 'HEAD']).catch(() => ({ stdout: 'local' }))).stdout.trim();
    return { dir, head, cleanup: () => {} };
  }
  const base = fs.mkdtempSync(path.join(process.env.SYNC_CACHE_DIR ?? os.tmpdir(), `scanbar-${src.slug}-`));
  const dir = path.join(base, 'repo');
  const git = (...args: string[]) => exec('git', args, { timeout: 60_000, maxBuffer: 1 << 20 });
  try {
    await git('clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--quiet', `https://github.com/${OWNER}/${src.repo}.git`, dir);
    await git('-C', dir, 'sparse-checkout', 'set', '--no-cone', ...src.paths);
    await git('-C', dir, 'checkout', '--quiet');
    const head = (await git('-C', dir, 'rev-parse', 'HEAD')).stdout.trim();
    return { dir, head, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
  } catch (e) { fs.rmSync(base, { recursive: true, force: true }); throw e; }
}

/** Último commit de la rama principal del repo, sin descargar nada (para saber si hay que sincronizar). */
export const remoteHead = async (src: WebSource) =>
  (await exec('git', ['ls-remote', `https://github.com/${OWNER}/${src.repo}.git`, 'HEAD'], { timeout: 30_000 })).stdout.split(/\s/)[0];

function validate(items: Item[], who: string): Item[] {
  const seen = new Set<string>();
  for (const i of items) {
    if (!i.sku || !i.name || !Number.isInteger(i.cents) || i.cents < 0) throw new Error(`${who}: producto inválido ${JSON.stringify(i)}`);
    if (seen.has(i.sku)) throw new Error(`${who}: SKU duplicado ${i.sku}`);
    seen.add(i.sku); i.category = slugify(i.category) || 'general';
    i.attrs = Object.fromEntries(Object.entries(i.attrs).filter(([, v]) => v !== undefined));
  }
  return items;
}

type Client = Awaited<ReturnType<Db['connect']>>;
/**
 * Crea el negocio si falta. Su URL de producto y dominios se fijan al crearlo; si aún apuntan al repositorio de GitHub
 * (valor provisional) y ya se conoce la URL real de la web, se actualizan. Lo editado en la consola no se pisa.
 */
export async function ensureTenant(c: Client, src: WebSource): Promise<number> {
  const site = siteUrl(src);
  const tpl = site ?? `https://github.com/${OWNER}/${src.repo}`;
  const domains = [new URL(tpl).hostname];
  const t = (await c.query(
    `INSERT INTO tenants (slug,name,gs1_prefix,company_prefix,product_url_tpl,allowed_domains) VALUES ($1,$2,'750',$3,$4,$5)
     ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id, product_url_tpl`, [src.slug, src.name, src.companyPrefix, tpl, domains])).rows[0];
  // Se actualiza mientras la URL siga siendo automática (la provisional de GitHub o la de workers.dev), p. ej. al conocerse la cuenta
  // de Cloudflare o al definir WEB_URL_<NEGOCIO>. Una plantilla editada a mano en la consola no se toca.
  const automatic = (u: string) => u.startsWith('https://github.com/') || new RegExp(`^https://${src.worker}\\.[a-z0-9-]+\\.workers\\.dev/$`, 'i').test(u);
  if (site && site !== t.product_url_tpl && automatic(t.product_url_tpl))
    await c.query(`UPDATE tenants SET product_url_tpl=$2,
      allowed_domains=ARRAY(SELECT DISTINCT d FROM unnest(allowed_domains || $3::text[]) d WHERE d <> 'github.com') WHERE id=$1`, [t.id, site, domains]);
  await c.query('INSERT INTO code_counters (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [t.id]);
  return Number(t.id);
}

/** Aplica el catálogo de una web en una transacción. */
export async function syncSource(db: Db, src: WebSource, items: Item[]): Promise<Omit<SyncResult, 'slug' | 'head'>> {
  validate(items, src.slug);
  if (!items.length) throw new Error('el repo no produjo ningún producto; no se retira nada');
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const tenantId = await ensureTenant(c, src);
    let created = 0, updated = 0, retired = 0, reactivated = 0, skipped = 0;
    const existing = new Map<string, any>((await c.query('SELECT id, sku, name, category, price_cents, active, attrs, origin, variant_of, variant FROM products WHERE tenant_id=$1', [tenantId])).rows.map(r => [r.sku, r]));
    for (const i of items) {
      const cur = existing.get(i.sku);
      if (!cur) {
        const p = (await c.query("INSERT INTO products (tenant_id,sku,name,category,price_cents,stock,attrs,origin,variant_of,variant) VALUES ($1,$2,$3,$4,$5,$6,$7,'repo',$8,$9) RETURNING id",
          [tenantId, i.sku, i.name, i.category, i.cents, i.stock ?? 0, i.attrs, i.variantOf ?? null, i.variant ?? null])).rows[0];
        const n = (await c.query('SELECT allocate_item($1::smallint) AS n', [tenantId])).rows[0].n;
        await c.query("INSERT INTO codes (gtin,tenant_id,kind,product_id) VALUES ($1,$2,'product',$3)", [buildGtin13('750', src.companyPrefix, n), tenantId, p.id]);
        created++; continue;
      }
      // Mismo SKU dado de alta desde Scan-bar: no se pisa; hay que renombrar uno de los dos.
      if (cur.origin !== 'repo') { skipped++; continue; }
      const changed = cur.name !== i.name || cur.category !== i.category || cur.price_cents !== i.cents || canon(cur.attrs) !== canon(i.attrs) || cur.variant_of !== (i.variantOf ?? null) || cur.variant !== (i.variant ?? null);
      if (changed) { await c.query('UPDATE products SET name=$2, category=$3, price_cents=$4, attrs=$5, variant_of=$6, variant=$7 WHERE id=$1', [cur.id, i.name, i.category, i.cents, i.attrs, i.variantOf ?? null, i.variant ?? null]); updated++; }
      if (!cur.active) { await c.query('UPDATE products SET active=true WHERE id=$1', [cur.id]); await c.query('UPDATE codes SET retired_at=NULL WHERE product_id=$1', [cur.id]); reactivated++; }
    }
    const keep = new Set(items.map(i => i.sku));
    for (const [sku, cur] of existing) if (cur.origin === 'repo' && cur.active && !keep.has(sku)) {
      await c.query('UPDATE products SET active=false WHERE id=$1', [cur.id]);
      await c.query('UPDATE codes SET retired_at=now() WHERE product_id=$1 AND retired_at IS NULL', [cur.id]);
      retired++;
    }
    await c.query('COMMIT');
    return { items: items.length, created, updated, retired, reactivated, skipped };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

/** Sincroniza las webs pedidas (todas por defecto). Un error en una web no detiene las demás. */
export async function syncAll(db: Db, opts: { only?: string[]; local?: string; dry?: boolean } = {}): Promise<(SyncResult & { sample?: Item[] })[]> {
  const out: (SyncResult & { sample?: Item[] })[] = [];
  for (const src of SOURCES.filter(s => !opts.only?.length || opts.only.includes(s.slug))) {
    const zero = { items: 0, created: 0, updated: 0, retired: 0, reactivated: 0, skipped: 0 };
    let repo: Awaited<ReturnType<typeof fetchRepo>> | null = null;
    try {
      repo = await fetchRepo(src, { local: opts.local });
      const items = await src.extract(repo.dir);
      if (opts.dry) { validate(items, src.slug); out.push({ slug: src.slug, head: repo.head, ...zero, items: items.length, sample: items.slice(0, 4) }); continue; }
      out.push({ slug: src.slug, head: repo.head, ...(await syncSource(db, src, items)) });
    } catch (e: any) {
      out.push({ slug: src.slug, ...zero, error: e.message });
    } finally { repo?.cleanup(); }
  }
  return out;
}

export const describe = (r: SyncResult) => r.error ? `${r.slug}: FALLÓ — ${r.error}`
  : `${r.slug}: ${r.items} en el repo · +${r.created} nuevos · ${r.updated} actualizados · ${r.retired} retirados · ${r.reactivated} reactivados${r.skipped ? ` · ${r.skipped} omitidos (SKU de Scan-bar)` : ''}`;

/** Estado visible en la consola. */
export const syncState: { running: boolean; last?: { at: string; results: SyncResult[] }; heads: Record<string, string> } = { running: false, heads: {} };

/** Sincroniza (solo lo que cambió, salvo `force`) y deja el resultado en syncState. Nunca corre dos veces a la vez. */
export async function syncNow(db: Db, opts: { force?: boolean; log?: (m: string) => void } = {}) {
  if (syncState.running) return syncState.last;
  syncState.running = true;
  try {
    let only: string[] | undefined;
    if (!opts.force) {
      const heads = await Promise.all(SOURCES.map(async s => [s.slug, await remoteHead(s).catch(() => '')] as const));
      only = heads.filter(([slug, h]) => h && h !== syncState.heads[slug]).map(([slug]) => slug);
      if (!only.length) return syncState.last;
    }
    const results = await syncAll(db, { only });
    for (const r of results) { if (r.head && !r.error) syncState.heads[r.slug] = r.head; opts.log?.(describe(r)); }
    syncState.last = { at: new Date().toISOString(), results };
    return syncState.last;
  } finally { syncState.running = false; }
}

/**
 * Sincronización automática del servidor: al arrancar (espera a conocer su propio host para fijar las URL de las webs)
 * y luego cada SYNC_INTERVAL_MIN minutos solo si algún repo cambió. Se apaga con SYNC_REPOS=0.
 */
export function startAutoSync(db: Db, log: (m: string) => void = console.log): () => void {
  if (process.env.SYNC_REPOS === '0') return () => {};
  const minutes = Math.max(1, Number(process.env.SYNC_INTERVAL_MIN ?? 10));
  let stopped = false;
  const tick = (force: boolean) => syncNow(db, { force, log }).catch(e => log(`sincronización: ${e.message}`));
  const first = setTimeout(async () => {
    for (let i = 0; i < 60 && !process.env.RESOLVER_HOST && !stopped; i++) await new Promise(r => setTimeout(r, 1000));
    if (!stopped) await tick(true);
  }, 2000);
  const every = setInterval(() => tick(false), minutes * 60_000);
  first.unref(); every.unref();
  return () => { stopped = true; clearTimeout(first); clearInterval(every); };
}
