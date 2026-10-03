// Sincroniza a mano el catálogo de las webs (el servidor ya lo hace solo; ver apps/api/src/sync.ts).
// Uso: npm run sync:repos [-- --dry] [-- --only=slug] [-- --local=../]  (--local lee las webs de una carpeta en vez de clonarlas)
import pg from 'pg';
import { ownerUrl } from '../apps/api/src/env';
import { syncAll, describe } from '../apps/api/src/sync';

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const dry = process.argv.includes('--dry');
const pool = new pg.Pool({ connectionString: ownerUrl(), max: 1 });
const results = await syncAll(pool, { dry, only: arg('only')?.split(','), local: arg('local') });
for (const r of results) {
  console.log(dry && !r.error ? `${r.slug}: ${r.items} productos (dry)` : describe(r));
  if (dry && r.sample) console.table(r.sample.map(i => ({ sku: i.sku, name: i.name, category: i.category, mxn: i.cents / 100 })));
}
await pool.end();
process.exit(results.some(r => r.error) ? 1 : 0);
