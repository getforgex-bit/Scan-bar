// Arranque de producción (contenedor de Cloudflare o cualquier servidor con Node):
// migraciones → negocios y cuentas → servidor. El servidor sincroniza el catálogo de las webs por su cuenta.
import pg from 'pg';
import { migrate } from './migrate';
import { ownerUrl } from '../apps/api/src/env';
import { bootstrap } from '../apps/api/src/bootstrap';

// Un Postgres administrado puede tardar unos segundos en despertar: se reintenta antes de rendirse.
for (let i = 1; ; i++) {
  try { await migrate(ownerUrl()); break; } catch (e: any) {
    if (i >= 5) throw e;
    console.warn(`Base de datos no disponible (${e.message}); reintento ${i}/4 en ${i * 3} s`);
    await new Promise(r => setTimeout(r, i * 3000));
  }
}
const pool = new pg.Pool({ connectionString: ownerUrl(), max: 1 });
for (const note of await bootstrap(pool)) console.log(note);
await pool.end();
await import('../apps/api/src/server');
