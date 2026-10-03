// Recorre un GTIN por tenant y verifica la redirección 302. Uso: tsx scripts/check-resolver.ts
import pg from 'pg';
const BASE = process.env.BASE ?? 'http://localhost:3000';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/codes' });
await c.connect();
const rows = (await c.query("SELECT DISTINCT ON (c.tenant_id) c.gtin, t.slug, t.allowed_domains FROM codes c JOIN tenants t ON t.id=c.tenant_id WHERE c.kind='product' ORDER BY c.tenant_id, c.gtin")).rows;
let ok = 0;
for (const r of rows) {
  const res = await fetch(`${BASE}/01/0${r.gtin}`, { redirect: 'manual' });
  const loc = res.headers.get('location') ?? '';
  const good = res.status === 302 && r.allowed_domains.some((d: string) => loc.includes(d));
  if (good) ok++;
  console.log(good ? 'OK ' : 'FALLA', r.slug, r.gtin, res.status, loc);
}
console.log(`${ok} de ${rows.length} redirecciones correctas`);
await c.end();
process.exit(ok === rows.length ? 0 : 1);
