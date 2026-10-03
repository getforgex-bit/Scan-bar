// Semilla idempotente: 9 tenants ficticios + catálogo de cómputo (tenant 0002). Datos de EJEMPLO.
import pg from 'pg';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { buildGtin13 } from '../packages/codes/src/index';
import { ownerUrl } from '../apps/api/src/env';
import { pcDefinition, cafeDefinition, cafeCatalog } from './configurators';

const url = ownerUrl();
const names = ['Papelería Aurora', 'Cómputo Nova', 'Café Origen', 'Ferretería Norte', 'Libros Sur', 'Deportes Ágil', 'Jardín Verde', 'Mascotas Feliz', 'Juguetes Luna'];

type P = [sku: string, name: string, cat: string, cents: number, stock: number, attrs: Record<string, unknown>];
const computo: P[] = [
  ['CPU-A5-7600', 'Ryzen 5 7600', 'cpu', 369900, 20, { socket: 'AM5', tdp_w: 65 }],
  ['CPU-A7-7700', 'Ryzen 7 7700', 'cpu', 689900, 20, { socket: 'AM5', tdp_w: 65 }],
  ['CPU-I5-12400', 'Core i5-12400', 'cpu', 329900, 20, { socket: 'LGA1700', tdp_w: 65 }],
  ['CPU-I7-14700', 'Core i7-14700', 'cpu', 849900, 20, { socket: 'LGA1700', tdp_w: 125 }],
  ['MB-B650-ATX', 'Placa B650 ATX', 'motherboard', 289900, 15, { socket: 'AM5', ram_types: ['DDR5'], form_factor: 'ATX' }],
  ['MB-B650-MATX', 'Placa B650M mATX', 'motherboard', 229900, 15, { socket: 'AM5', ram_types: ['DDR5'], form_factor: 'mATX' }],
  ['MB-B760-ATX', 'Placa B760 ATX', 'motherboard', 259900, 15, { socket: 'LGA1700', ram_types: ['DDR4', 'DDR5'], form_factor: 'ATX' }],
  ['MB-H610-MATX', 'Placa H610M mATX', 'motherboard', 149900, 15, { socket: 'LGA1700', ram_types: ['DDR4'], form_factor: 'mATX' }],
  ['RAM-D5-16', 'RAM 16 GB DDR5', 'ram', 109900, 40, { ram_type: 'DDR5', gb: 16 }],
  ['RAM-D5-32', 'RAM 32 GB DDR5', 'ram', 189900, 40, { ram_type: 'DDR5', gb: 32 }],
  ['RAM-D4-16', 'RAM 16 GB DDR4', 'ram', 69900, 40, { ram_type: 'DDR4', gb: 16 }],
  ['RAM-D4-32', 'RAM 32 GB DDR4', 'ram', 119900, 40, { ram_type: 'DDR4', gb: 32 }],
  ['SSD-500', 'SSD NVMe 500 GB', 'storage', 79900, 30, { gb: 500 }],
  ['SSD-1T', 'SSD NVMe 1 TB', 'storage', 129900, 30, { gb: 1000 }],
  ['SSD-2T', 'SSD NVMe 2 TB', 'storage', 229900, 30, { gb: 2000 }],
  ['HDD-2T', 'Disco duro 2 TB', 'storage', 99900, 30, { gb: 2000 }],
  ['PSU-550', 'Fuente 550 W', 'psu', 89900, 25, { watts: 550 }],
  ['PSU-650', 'Fuente 650 W', 'psu', 109900, 25, { watts: 650 }],
  ['PSU-750', 'Fuente 750 W', 'psu', 149900, 25, { watts: 750 }],
  ['PSU-850', 'Fuente 850 W', 'psu', 189900, 25, { watts: 850 }],
  ['CASE-ATX', 'Gabinete ATX Mid Tower', 'case', 99900, 12, { form_factors: ['ATX', 'mATX'] }],
  ['CASE-MATX', 'Gabinete mATX compacto', 'case', 79900, 12, { form_factors: ['mATX'] }],
  ['CASE-FT', 'Gabinete Full Tower', 'case', 189900, 12, { form_factors: ['ATX', 'mATX', 'EATX'] }],
  ['GPU-4060', 'GPU 8 GB gama media', 'gpu', 599900, 10, { tdp_w: 115 }],
  ['GPU-4070', 'GPU 12 GB gama alta', 'gpu', 1199900, 10, { tdp_w: 200 }],
  ['GPU-4090', 'GPU 24 GB entusiasta', 'gpu', 3499900, 5, { tdp_w: 450 }],
];

const c = new pg.Client({ connectionString: url });
await c.connect();
let creds = '';
const secret = (envName: string) => {
  const v = process.env[envName];
  if (v) return v;
  const g = crypto.randomBytes(12).toString('base64url');
  creds += `${envName}=${g}\n`; // se guarda en archivo local ignorado por git
  return g;
};
const pwFile = new URL('../.dev-credentials.txt', import.meta.url);
const stored = fs.existsSync(pwFile) ? Object.fromEntries(fs.readFileSync(pwFile, 'utf8').split('\n').filter(Boolean).map(l => l.split('='))) : {};
const adminPw = process.env.SEED_ADMIN_PASSWORD ?? stored.SEED_ADMIN_PASSWORD ?? secret('SEED_ADMIN_PASSWORD');
const posPw = process.env.SEED_POS_PASSWORD ?? stored.SEED_POS_PASSWORD ?? secret('SEED_POS_PASSWORD');
if (creds) fs.writeFileSync(pwFile, `SEED_ADMIN_PASSWORD=${adminPw}\nSEED_POS_PASSWORD=${posPw}\n`);

await c.query('BEGIN');
for (let i = 0; i < 9; i++) {
  const n = i + 1, prefix = String(n).padStart(4, '0'), slug = `tienda-${prefix}`, host = `equipo${n}.ejemplo.mx`;
  const t = (await c.query(
    `INSERT INTO tenants (slug,name,gs1_prefix,company_prefix,product_url_tpl,build_url_tpl,allowed_domains)
     VALUES ($1,$2,'750',$3,$4,$5,$6) ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
    [slug, names[i], prefix, `https://${host}/producto/{sku}`, `https://${host}/ensamble/{gtin}`, [host]])).rows[0];
  await c.query('INSERT INTO code_counters (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [t.id]);
  for (const [role, email, pw] of [['superadmin', `admin${n}@ejemplo.mx`, adminPw], ['operador_pos', `caja${n}@ejemplo.mx`, posPw]] as const) {
    let u = (await c.query('SELECT id FROM users WHERE email=$1', [email])).rows[0];
    if (!u) u = (await c.query('INSERT INTO users (email,password_hash) VALUES ($1,$2) RETURNING id', [email, await argon2.hash(pw, { type: argon2.argon2id })])).rows[0];
    await c.query('INSERT INTO memberships (user_id,tenant_id,role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [u.id, t.id, role]);
  }
  // Catálogo: cómputo completo en 0002; 3 artículos genéricos en los demás
  const generic = [1, 2, 3].map(k => [`ART-${k}`, `${names[i]} artículo ${k}`, 'general', 10000 * k, 50, {}] as P);
  const items: P[] = n === 2 ? computo : n === 3 ? [...generic, ...cafeCatalog] : generic;
  for (const [sku, name, cat, cents, stock, attrs] of items) {
    if ((await c.query('SELECT 1 FROM products WHERE tenant_id=$1 AND sku=$2', [t.id, sku])).rowCount) continue;
    const p = (await c.query('INSERT INTO products (tenant_id,sku,name,category,price_cents,stock,attrs) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [t.id, sku, name, cat, cents, stock, attrs])).rows[0];
    const item = (await c.query('SELECT allocate_item($1::smallint) AS n', [t.id])).rows[0].n;
    await c.query("INSERT INTO codes (gtin,tenant_id,kind,product_id) VALUES ($1,$2,'product',$3)", [buildGtin13('750', prefix, item), t.id, p.id]);
  }
  // Configuradores de ejemplo: PC a medida (0002) y bebidas de la cafetería (0003). No se pisan si ya fueron editados.
  const cfg = n === 2 ? ['pc', 'PC a medida', 'Arma tu computadora pieza por pieza', pcDefinition] as const : n === 3 ? ['bebida', 'Tu café', 'Elige bebida, tamaño, leche, endulzante y extras', cafeDefinition] as const : null;
  if (cfg) await c.query('INSERT INTO configurators (tenant_id,slug,name,description,definition) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, slug) DO NOTHING', [t.id, cfg[0], cfg[1], cfg[2], JSON.stringify(cfg[3])]);
}
await c.query('COMMIT');
const r = await c.query('SELECT (SELECT count(*) FROM products) AS products, (SELECT count(*) FROM codes) AS codes, (SELECT count(*) FROM tenants) AS tenants, (SELECT count(*) FROM configurators) AS configurators');
console.log('Semilla lista:', r.rows[0]);
await c.end();
