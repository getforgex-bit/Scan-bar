// Prueba de respaldo y restauración (copia física en frío del directorio de datos).
// Crea una instancia temporal, migra y siembra, la detiene, la respalda, destruye datos en el original,
// levanta la copia y comprueba que los conteos coinciden con los previos. Uso: npm run backup-test
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { migrate } from './migrate';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forgex-backup-'));
const orig = path.join(base, 'orig'), backup = path.join(base, 'backup');
const mk = (dir: string, port: number) => new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: true });
const counts = async (port: number) => {
  const c = new pg.Client({ connectionString: `postgres://postgres:postgres@localhost:${port}/codes` }); await c.connect();
  const r = (await c.query('SELECT (SELECT count(*) FROM tenants)::int t, (SELECT count(*) FROM products)::int p, (SELECT count(*) FROM codes)::int c, (SELECT count(*) FROM users)::int u')).rows[0];
  await c.end(); return r;
};
const P1 = 25001, P2 = 25002;
const a = mk(orig, P1); await a.initialise(); await a.start(); await a.createDatabase('codes');
const url = `postgres://postgres:postgres@localhost:${P1}/codes`;
await migrate(url);
execFileSync('npx', ['tsx', 'db/seed.ts'], { env: { ...process.env, DATABASE_URL: url, SEED_ADMIN_PASSWORD: 'Respaldo-prueba-123', SEED_POS_PASSWORD: 'Respaldo-prueba-456' }, shell: true, stdio: 'pipe' });
const before = await counts(P1);
await a.stop();
fs.cpSync(orig, backup, { recursive: true });                       // respaldo en frío
await a.start();
const c = new pg.Client({ connectionString: url }); await c.connect();
await c.query('TRUNCATE sale_items, sales, build_items, builds, codes, products CASCADE'); // desastre simulado
await c.end();
const damaged = await counts(P1); await a.stop();
const b = mk(backup, P2); await b.start();                          // restauración
const restored = await counts(P2); await b.stop();
fs.rmSync(base, { recursive: true, force: true });
console.log(JSON.stringify({ before, damaged, restored, ok: JSON.stringify(before) === JSON.stringify(restored) && damaged.p === 0 }));
process.exit(JSON.stringify(before) === JSON.stringify(restored) ? 0 : 1);
