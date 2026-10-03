// Sincroniza el catálogo de cada negocio desde su repositorio de GitHub y emite los GTIN de lo nuevo.
// Idempotente: un SKU ya sincronizado conserva su GTIN; lo que desaparece del repo se retira (no se borra).
// Cada configuración de producto que define la web (talla, tamaño, gramaje, variante) es un producto con su propio GTIN.
// Solo administra productos de origen 'repo': lo que se agregó desde Scan-bar (origen 'scanbar') no se toca ni se retira.
// Uso: npm run sync:repos [-- --dry] [-- --only=slug] [-- --local=../]  (--local lee las webs de una carpeta en vez de clonarlas)
import pg from 'pg';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { buildGtin13 } from '../packages/codes/src/index';
import { ownerUrl, rootDir } from '../apps/api/src/env';

type Item = { sku: string; name: string; category: string; cents: number; stock?: number; attrs: Record<string, unknown>; variantOf?: string; variant?: string };
type Source = { slug: string; name: string; companyPrefix: string; repo: string; extract: (dir: string) => Promise<Item[]> };

const OWNER = 'getforgex-bit';
const cache = path.join(rootDir, '.cache', 'repos');
const cents = (mxn: number) => Math.round(mxn * 100);
const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
/** JSON con llaves ordenadas: jsonb no conserva el orden de inserción. */
const canon = (o: unknown): string => JSON.stringify(o, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const slugify = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

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

const sources: Source[] = [
  {
    slug: 'yokrem', name: 'YOKREM', companyPrefix: '0010', repo: 'yokrem',
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
    slug: 'cafe-motz', name: 'Motz Café', companyPrefix: '0011', repo: 'Cafe-Motz',
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
    slug: 'dulce-encanto', name: 'Dulce Encanto', companyPrefix: '0012', repo: 'dulce-encanto',
    async extract(dir) {
      const rows: any[] = run(`(${arrayLiteral(read(dir, 'Dulce Encanto.html'), 'const PRODUCTOS')})`);
      return rows.map(p => ({ sku: p.id, name: p.nombre, category: p.cat, cents: cents(p.precio), attrs: { unidad: p.unidad, casa: p.casa } }));
    },
  },
  {
    slug: 'nova-core', name: 'Nova Core', companyPrefix: '0013', repo: 'nova-core',
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
    slug: 'la-picosita-de-la-sierra', name: 'La Picosita de la Sierra', companyPrefix: '0014', repo: 'La-picosita-de-la-sierra',
    async extract(dir) {
      const src = read(dir, 'code.html');
      const a = src.indexOf('const IMGS='), b = src.indexOf('P.forEach(', a);
      const P: any[] = run(`${src.slice(a, src.indexOf('\n', b))}\nP`);
      return P.flatMap(p => p.sizes.map((z: any) => ({ sku: `${p.id}-${z.g}G`, name: `${p.n} ${z.g} g`, category: p.t, cents: cents(z.p), attrs: { gramos: z.g, picor: p.pi }, variantOf: p.id, variant: `${z.g} g` })));
    },
  },
  {
    slug: 'biker-lifestyle', name: 'Biker Lifestyle', companyPrefix: '0015', repo: 'biker-lifestyle',
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

const local = process.argv.find(a => a.startsWith('--local='))?.slice(8);
function fetchRepo(repo: string): string {
  if (local) { const d = path.resolve(local, repo); if (!fs.existsSync(d)) throw new Error(`No existe ${d}`); return d; }
  const dir = path.join(cache, repo), url = `https://github.com/${OWNER}/${repo}.git`;
  fs.mkdirSync(cache, { recursive: true });
  if (fs.existsSync(path.join(dir, '.git'))) {
    execFileSync('git', ['-C', dir, 'fetch', '--depth', '1', 'origin'], { stdio: 'pipe' });
    execFileSync('git', ['-C', dir, 'reset', '--hard', 'FETCH_HEAD'], { stdio: 'pipe' });
  } else execFileSync('git', ['clone', '--depth', '1', url, dir], { stdio: 'pipe' });
  return dir;
}

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

const dry = process.argv.includes('--dry');
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7);
const c = new pg.Client({ connectionString: ownerUrl() });
if (!dry) await c.connect();
let failed = 0;

for (const s of sources.filter(x => !only || x.slug === only)) {
  try {
    const items = validate(await s.extract(fetchRepo(s.repo)), s.slug);
    if (!items.length) throw new Error('el repo no produjo ningún producto; no se retira nada');
    if (dry) { console.log(`${s.slug}: ${items.length} productos (dry)`); console.table(items.slice(0, 4).map(i => ({ sku: i.sku, name: i.name, category: i.category, mxn: i.cents / 100 }))); continue; }

    await c.query('BEGIN');
    const home = `https://github.com/${OWNER}/${s.repo}`;
    // La URL y los dominios solo se fijan al crear el tenant; después se editan en la consola y no se pisan.
    const t = (await c.query(
      `INSERT INTO tenants (slug,name,gs1_prefix,company_prefix,product_url_tpl,allowed_domains) VALUES ($1,$2,'750',$3,$4,$5)
       ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [s.slug, s.name, s.companyPrefix, home, ['github.com']])).rows[0];
    await c.query('INSERT INTO code_counters (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [t.id]);

    let created = 0, updated = 0, retired = 0, reactivated = 0;
    let skipped = 0;
    const existing = new Map<string, any>((await c.query('SELECT id, sku, name, category, price_cents, active, attrs, origin, variant_of, variant FROM products WHERE tenant_id=$1', [t.id])).rows.map(r => [r.sku, r]));
    for (const i of items) {
      const cur = existing.get(i.sku);
      if (!cur) {
        const p = (await c.query("INSERT INTO products (tenant_id,sku,name,category,price_cents,stock,attrs,origin,variant_of,variant) VALUES ($1,$2,$3,$4,$5,$6,$7,'repo',$8,$9) RETURNING id",
          [t.id, i.sku, i.name, i.category, i.cents, i.stock ?? 0, i.attrs, i.variantOf ?? null, i.variant ?? null])).rows[0];
        const n = (await c.query('SELECT allocate_item($1::smallint) AS n', [t.id])).rows[0].n;
        await c.query("INSERT INTO codes (gtin,tenant_id,kind,product_id) VALUES ($1,$2,'product',$3)", [buildGtin13('750', s.companyPrefix, n), t.id, p.id]);
        created++; continue;
      }
      // Mismo SKU dado de alta desde Scan-bar: no se pisa; hay que renombrar uno de los dos.
      if (cur.origin !== 'repo') { console.warn(`  ${s.slug}: ${i.sku} ya existe como producto agregado en Scan-bar; se omite`); skipped++; continue; }
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
    console.log(`${s.slug} (${s.companyPrefix}): ${items.length} en el repo · +${created} nuevos · ${updated} actualizados · ${retired} retirados · ${reactivated} reactivados${skipped ? ` · ${skipped} omitidos (SKU de Scan-bar)` : ''}`);
  } catch (e: any) {
    failed++; if (!dry) await c.query('ROLLBACK').catch(() => {});
    console.error(`${s.slug}: FALLÓ — ${e.message}`);
  }
}
if (!dry) await c.end();
process.exit(failed ? 1 : 0);
