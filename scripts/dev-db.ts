import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../.pgdata', import.meta.url));
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: 5433, persistent: true });
if (!fs.existsSync(dir + '/PG_VERSION')) await pg.initialise();
await pg.start();
try { await pg.createDatabase('codes'); } catch { /* ya existe */ }
console.log('Postgres listo en postgres://postgres:postgres@localhost:5433/codes');
process.on('SIGINT', async () => { await pg.stop(); process.exit(0); });
setInterval(() => {}, 1 << 30);
